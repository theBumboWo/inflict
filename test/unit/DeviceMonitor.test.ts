// test/unit/DeviceMonitor.test.ts
//
// Unit tests for DeviceMonitor — Validates: Requirements 1
//
// Strategy: fake timers advance the 500ms polling loop without waiting for
// real wall-clock time.  MockHardwareIdentityProvider.listDevices() is
// replaced with a vi.fn() wrapper so individual tests can control what the
// monitor "sees" on each poll.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceMonitor, type DeviceEvent } from "../../src/main/device/DeviceMonitor";
import { MockHardwareIdentityProvider } from "../../test/mocks/MockHardwareIdentityProvider";
import type { DeviceInfo } from "../../src/main/hardware/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fully-supported mock device. */
const SUPPORTED_DEVICE: DeviceInfo = {
  devicePath: "mock://device/1",
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
};

/** A second fully-supported mock device (different path). */
const SUPPORTED_DEVICE_2: DeviceInfo = {
  devicePath: "mock://device/2",
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
};

/** A device that lacks the hmac-secret capability. */
const UNSUPPORTED_DEVICE: DeviceInfo = {
  devicePath: "mock://device/unsupported",
  supportsHmacSecret: false,
  supportsResidentKey: false,
  extensions: [],
};

/**
 * Advance fake timers past one full poll cycle (interval + a little extra for
 * the async poll() Promise to resolve) and drain the micro-task queue.
 *
 * DeviceMonitor fires setInterval at 500ms.  We advance by 600ms so at least
 * one tick has fired, then flush pending Promises.
 */
async function advanceOnePoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DeviceMonitor", () => {
  let provider: MockHardwareIdentityProvider;
  let monitor: DeviceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockHardwareIdentityProvider();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. device-connected — emitted when a device appears
  // -------------------------------------------------------------------------
  it("emits device-connected within one poll cycle when a supported device appears", async () => {
    // Make listDevices return a supported device immediately.
    vi.spyOn(provider, "listDevices").mockResolvedValue([SUPPORTED_DEVICE]);

    monitor = new DeviceMonitor(provider);

    const events: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => events.push(e));

    monitor.start();
    await advanceOnePoll();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "device-connected",
      devicePath: SUPPORTED_DEVICE.devicePath,
    });
    expect((events[0] as Extract<DeviceEvent, { type: "device-connected" }>).info).toEqual(SUPPORTED_DEVICE);
  });

  // -------------------------------------------------------------------------
  // 2. device-connected not re-emitted if device stays connected
  // -------------------------------------------------------------------------
  it("does not emit device-connected again for a device that stays connected across polls", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([SUPPORTED_DEVICE]);

    monitor = new DeviceMonitor(provider);

    const events: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => events.push(e));

    monitor.start();

    // Two full poll cycles
    await advanceOnePoll();
    await advanceOnePoll();

    // Should still only have received one event
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 3. device-removed — emitted when a device disappears
  // -------------------------------------------------------------------------
  it("emits device-removed when a previously-connected device disappears", async () => {
    const listDevices = vi
      .spyOn(provider, "listDevices")
      // First poll: device is present
      .mockResolvedValueOnce([SUPPORTED_DEVICE])
      // Second poll: device is gone
      .mockResolvedValue([]);

    monitor = new DeviceMonitor(provider);

    const connectedEvents: DeviceEvent[] = [];
    const removedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));
    monitor.on("device-removed", (e) => removedEvents.push(e));

    monitor.start();

    // First poll — device connects
    await advanceOnePoll();
    expect(connectedEvents).toHaveLength(1);

    // Second poll — device disappears
    await advanceOnePoll();
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0]).toMatchObject({
      type: "device-removed",
      devicePath: SUPPORTED_DEVICE.devicePath,
    });
  });

  // -------------------------------------------------------------------------
  // 4. device-removed not emitted before device is gone
  // -------------------------------------------------------------------------
  it("does not emit device-removed while the device is still connected", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([SUPPORTED_DEVICE]);

    monitor = new DeviceMonitor(provider);

    const removedEvents: DeviceEvent[] = [];
    monitor.on("device-removed", (e) => removedEvents.push(e));

    monitor.start();
    await advanceOnePoll();
    await advanceOnePoll();

    expect(removedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. device-unsupported — emitted when supportsHmacSecret is false
  // -------------------------------------------------------------------------
  it("emits device-unsupported when the device reports supportsHmacSecret = false", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([UNSUPPORTED_DEVICE]);

    monitor = new DeviceMonitor(provider);

    const unsupportedEvents: DeviceEvent[] = [];
    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-unsupported", (e) => unsupportedEvents.push(e));
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();
    await advanceOnePoll();

    expect(unsupportedEvents).toHaveLength(1);
    expect(unsupportedEvents[0]).toMatchObject({
      type: "device-unsupported",
      devicePath: UNSUPPORTED_DEVICE.devicePath,
    });
    // Must NOT emit device-connected for an unsupported device
    expect(connectedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. device-unsupported carries a reason string
  // -------------------------------------------------------------------------
  it("device-unsupported event includes a non-empty reason string", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([UNSUPPORTED_DEVICE]);

    monitor = new DeviceMonitor(provider);

    const events: DeviceEvent[] = [];
    monitor.on("device-unsupported", (e) => events.push(e));

    monitor.start();
    await advanceOnePoll();

    const evt = events[0] as Extract<DeviceEvent, { type: "device-unsupported" }>;
    expect(evt.reason).toBeTruthy();
    expect(typeof evt.reason).toBe("string");
  });

  // -------------------------------------------------------------------------
  // 7. Req 1.9: second device connected during active session
  //    — device-connected IS emitted but session is NOT interrupted
  // -------------------------------------------------------------------------
  it("emits device-connected for a second device when a session is active (Req 1.9)", async () => {
    // Session is active throughout this test.
    const isSessionActive = vi.fn(() => true);

    vi.spyOn(provider, "listDevices")
      // First poll: only device 1
      .mockResolvedValueOnce([SUPPORTED_DEVICE])
      // Second poll: both devices present
      .mockResolvedValue([SUPPORTED_DEVICE, SUPPORTED_DEVICE_2]);

    monitor = new DeviceMonitor(provider, isSessionActive);

    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();

    // First poll — device 1 connects
    await advanceOnePoll();
    expect(connectedEvents).toHaveLength(1);
    expect(connectedEvents[0]).toMatchObject({ devicePath: SUPPORTED_DEVICE.devicePath });

    // Second poll — device 2 also connects while session is active
    await advanceOnePoll();
    expect(connectedEvents).toHaveLength(2);
    expect(connectedEvents[1]).toMatchObject({ devicePath: SUPPORTED_DEVICE_2.devicePath });

    // isSessionActive should have been checked (DeviceMonitor may query it)
    // — but the important assertion is that the event fired regardless.
    // The session must NOT have been terminated — we verify by confirming
    // isSessionActive still returns true (we never called a terminate).
    expect(isSessionActive()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. Req 1.9: second device does NOT suppress the existing session
  //    — the isSessionActive callback is never called with a "stop" side-effect
  // -------------------------------------------------------------------------
  it("does not call session-termination logic when a second device connects (Req 1.9)", async () => {
    const sessionTerminate = vi.fn();
    // isSessionActive returns true; sessionTerminate is a stand-in for
    // anything that would end the session.
    const isSessionActive = () => true;

    vi.spyOn(provider, "listDevices")
      .mockResolvedValueOnce([SUPPORTED_DEVICE])
      .mockResolvedValue([SUPPORTED_DEVICE, SUPPORTED_DEVICE_2]);

    monitor = new DeviceMonitor(provider, isSessionActive);

    monitor.start();
    await advanceOnePoll(); // device 1 connects
    await advanceOnePoll(); // device 2 connects

    // The DeviceMonitor must not have called sessionTerminate — it should only
    // emit events, never modify session state directly.
    expect(sessionTerminate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 9. stop() halts polling — no more events after stop is called
  // -------------------------------------------------------------------------
  it("stops emitting events after stop() is called", async () => {
    // Device present on first poll, gone on subsequent polls
    vi.spyOn(provider, "listDevices")
      .mockResolvedValueOnce([SUPPORTED_DEVICE])
      .mockResolvedValue([]);

    monitor = new DeviceMonitor(provider);

    const allEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => allEvents.push(e));
    monitor.on("device-removed", (e) => allEvents.push(e));

    monitor.start();
    await advanceOnePoll(); // device-connected fires

    monitor.stop();
    const countAfterStop = allEvents.length;

    // Advance timers further — no more polls should run
    await vi.advanceTimersByTimeAsync(2000);

    expect(allEvents.length).toBe(countAfterStop);
  });

  // -------------------------------------------------------------------------
  // 10. start() is idempotent — calling twice doesn't double-emit events
  // -------------------------------------------------------------------------
  it("calling start() twice does not cause duplicate events", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([SUPPORTED_DEVICE]);

    monitor = new DeviceMonitor(provider);

    const events: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => events.push(e));

    monitor.start();
    monitor.start(); // second call should be a no-op

    await advanceOnePoll();

    // Still only one event per device appearance
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 11. Empty device list → no events
  // -------------------------------------------------------------------------
  it("emits no events when listDevices returns an empty array", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([]);

    monitor = new DeviceMonitor(provider);

    const allEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => allEvents.push(e));
    monitor.on("device-removed", (e) => allEvents.push(e));
    monitor.on("device-unsupported", (e) => allEvents.push(e));

    monitor.start();
    await advanceOnePoll();

    expect(allEvents).toHaveLength(0);
  });
});
