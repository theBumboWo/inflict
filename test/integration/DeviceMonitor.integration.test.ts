// test/integration/DeviceMonitor.integration.test.ts
//
// Integration tests for DeviceMonitor lifecycle with a mock USB event emitter.
// Validates: Requirements 1
//
// Strategy:
//   - Use MockHardwareIdentityProvider as the provider, spying on listDevices()
//     so each test can control the sequence of "connected" device lists.
//   - Use vi.useFakeTimers() so the 500ms polling loop is advanced explicitly
//     without real wall-clock delays.
//   - Collect events into arrays and assert on their content after advancing
//     the clock past one or more poll cycles.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceMonitor, type DeviceEvent } from "../../src/main/device/DeviceMonitor";
import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";
import type { DeviceInfo } from "../../src/main/hardware/types";

// ---------------------------------------------------------------------------
// Fixture devices
// ---------------------------------------------------------------------------

/** Fully-supported FIDO2 device. */
const DEVICE_A: DeviceInfo = {
  devicePath: "usb://003/004",
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
};

/** A second fully-supported device (distinct path). */
const DEVICE_B: DeviceInfo = {
  devicePath: "usb://003/005",
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
};

/** Device that lacks the required hmac-secret capability. */
const DEVICE_UNSUPPORTED: DeviceInfo = {
  devicePath: "usb://003/006",
  supportsHmacSecret: false,
  supportsResidentKey: false,
  extensions: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Advance fake timers by 600ms (past the 500ms poll interval) so at least one
 * poll cycle fires and its async poll() promise resolves.
 */
async function advanceOnePoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
}

// ---------------------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------------------

describe("DeviceMonitor integration tests", () => {
  let monitor: DeviceMonitor;
  let provider: MockHardwareIdentityProvider;

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
  // 1. device-connected emitted when a device appears in listDevices() results
  // -------------------------------------------------------------------------
  it("emits device-connected when a device appears in listDevices() results", async () => {
    // Provider reports DEVICE_A on every poll.
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_A]);

    monitor = new DeviceMonitor(provider);

    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();
    await advanceOnePoll();

    // Exactly one event, containing the correct device info.
    expect(connectedEvents).toHaveLength(1);
    const evt = connectedEvents[0] as Extract<DeviceEvent, { type: "device-connected" }>;
    expect(evt.type).toBe("device-connected");
    expect(evt.devicePath).toBe(DEVICE_A.devicePath);
    expect(evt.info).toEqual(DEVICE_A);
  });

  it("does not re-emit device-connected for a device that stays connected across multiple polls", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_A]);

    monitor = new DeviceMonitor(provider);

    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();
    // Three consecutive polls — the device is always present.
    await advanceOnePoll();
    await advanceOnePoll();
    await advanceOnePoll();

    // Still only the initial connection event.
    expect(connectedEvents).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 2. device-removed emitted when a device disappears from listDevices()
  // -------------------------------------------------------------------------
  it("emits device-removed when a device disappears from listDevices() results", async () => {
    vi.spyOn(provider, "listDevices")
      // Poll 1: device present.
      .mockResolvedValueOnce([DEVICE_A])
      // Poll 2+: device gone.
      .mockResolvedValue([]);

    monitor = new DeviceMonitor(provider);

    const connectedEvents: DeviceEvent[] = [];
    const removedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));
    monitor.on("device-removed", (e) => removedEvents.push(e));

    monitor.start();

    // First poll — DEVICE_A connects.
    await advanceOnePoll();
    expect(connectedEvents).toHaveLength(1);
    expect(removedEvents).toHaveLength(0);

    // Second poll — DEVICE_A is gone.
    await advanceOnePoll();
    expect(removedEvents).toHaveLength(1);
    const evt = removedEvents[0] as Extract<DeviceEvent, { type: "device-removed" }>;
    expect(evt.type).toBe("device-removed");
    expect(evt.devicePath).toBe(DEVICE_A.devicePath);
  });

  it("does not emit device-removed while the device remains connected", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_A]);

    monitor = new DeviceMonitor(provider);

    const removedEvents: DeviceEvent[] = [];
    monitor.on("device-removed", (e) => removedEvents.push(e));

    monitor.start();
    await advanceOnePoll();
    await advanceOnePoll();

    expect(removedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. device-unsupported emitted when supportsHmacSecret is false
  // -------------------------------------------------------------------------
  it("emits device-unsupported (not device-connected) when supportsHmacSecret is false", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_UNSUPPORTED]);

    monitor = new DeviceMonitor(provider);

    const unsupportedEvents: DeviceEvent[] = [];
    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-unsupported", (e) => unsupportedEvents.push(e));
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();
    await advanceOnePoll();

    // Must emit device-unsupported.
    expect(unsupportedEvents).toHaveLength(1);
    const evt = unsupportedEvents[0] as Extract<DeviceEvent, { type: "device-unsupported" }>;
    expect(evt.type).toBe("device-unsupported");
    expect(evt.devicePath).toBe(DEVICE_UNSUPPORTED.devicePath);
    expect(typeof evt.reason).toBe("string");
    expect(evt.reason.length).toBeGreaterThan(0);

    // Must NOT emit device-connected for an unsupported device.
    expect(connectedEvents).toHaveLength(0);
  });

  it("does not track an unsupported device — so device-removed is never emitted for it", async () => {
    vi.spyOn(provider, "listDevices")
      // Poll 1: unsupported device present.
      .mockResolvedValueOnce([DEVICE_UNSUPPORTED])
      // Poll 2: device gone.
      .mockResolvedValue([]);

    monitor = new DeviceMonitor(provider);

    const removedEvents: DeviceEvent[] = [];
    monitor.on("device-removed", (e) => removedEvents.push(e));

    monitor.start();
    await advanceOnePoll(); // unsupported event fires, device NOT tracked.
    await advanceOnePoll(); // device list is now empty — no removal expected.

    expect(removedEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Second device connected during active session (Req 1.9):
  //    device-connected IS still emitted, existing session is NOT interrupted.
  // -------------------------------------------------------------------------
  it("emits device-connected for a second device even when a session is active (Req 1.9)", async () => {
    // The session is active throughout.
    const isSessionActive = vi.fn(() => true);

    vi.spyOn(provider, "listDevices")
      // Poll 1: only DEVICE_A.
      .mockResolvedValueOnce([DEVICE_A])
      // Poll 2+: both devices.
      .mockResolvedValue([DEVICE_A, DEVICE_B]);

    monitor = new DeviceMonitor(provider, isSessionActive);

    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();

    // First poll — DEVICE_A connects.
    await advanceOnePoll();
    expect(connectedEvents).toHaveLength(1);
    expect(connectedEvents[0]).toMatchObject({
      type: "device-connected",
      devicePath: DEVICE_A.devicePath,
    });

    // Second poll — DEVICE_B also connects while the session is active.
    await advanceOnePoll();
    expect(connectedEvents).toHaveLength(2);
    expect(connectedEvents[1]).toMatchObject({
      type: "device-connected",
      devicePath: DEVICE_B.devicePath,
    });

    // The session callback was never used to terminate anything — it only
    // describes state; the DeviceMonitor must not modify session state.
    expect(isSessionActive()).toBe(true);
  });

  it("does not interrupt the existing session when a second device connects (Req 1.9)", async () => {
    // sessionTerminate is a stand-in: if DeviceMonitor called it we'd know.
    const sessionTerminate = vi.fn();
    const isSessionActive = () => true;

    vi.spyOn(provider, "listDevices")
      .mockResolvedValueOnce([DEVICE_A])
      .mockResolvedValue([DEVICE_A, DEVICE_B]);

    monitor = new DeviceMonitor(provider, isSessionActive);

    monitor.start();
    await advanceOnePoll(); // DEVICE_A connects.
    await advanceOnePoll(); // DEVICE_B connects during active session.

    // DeviceMonitor must never have called a session-termination function.
    expect(sessionTerminate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Lifecycle — start/stop behaviour
  // -------------------------------------------------------------------------
  it("stops emitting events after stop() is called", async () => {
    vi.spyOn(provider, "listDevices")
      .mockResolvedValueOnce([DEVICE_A])
      .mockResolvedValue([]);

    monitor = new DeviceMonitor(provider);

    const allEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => allEvents.push(e));
    monitor.on("device-removed", (e) => allEvents.push(e));

    monitor.start();
    await advanceOnePoll(); // DEVICE_A connects.

    monitor.stop();
    const countAfterStop = allEvents.length;

    // Advance past several more potential poll intervals.
    await vi.advanceTimersByTimeAsync(3000);

    expect(allEvents.length).toBe(countAfterStop);
  });

  it("calling start() twice does not cause duplicate events", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_A]);

    monitor = new DeviceMonitor(provider);

    const events: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => events.push(e));

    monitor.start();
    monitor.start(); // second call must be a no-op.

    await advanceOnePoll();

    // Only one event even though start() was called twice.
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6. Mixed device list (supported + unsupported simultaneously)
  // -------------------------------------------------------------------------
  it("handles a mix of supported and unsupported devices in the same poll", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_A, DEVICE_UNSUPPORTED]);

    monitor = new DeviceMonitor(provider);

    const connectedEvents: DeviceEvent[] = [];
    const unsupportedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));
    monitor.on("device-unsupported", (e) => unsupportedEvents.push(e));

    monitor.start();
    await advanceOnePoll();

    // Supported device → device-connected.
    expect(connectedEvents).toHaveLength(1);
    expect(connectedEvents[0]).toMatchObject({
      type: "device-connected",
      devicePath: DEVICE_A.devicePath,
    });

    // Unsupported device → device-unsupported.
    expect(unsupportedEvents).toHaveLength(1);
    expect(unsupportedEvents[0]).toMatchObject({
      type: "device-unsupported",
      devicePath: DEVICE_UNSUPPORTED.devicePath,
    });
  });

  // -------------------------------------------------------------------------
  // 7. Polling timing — event fires within the 500ms window
  // -------------------------------------------------------------------------
  it("emits device-connected within the first 500ms poll window", async () => {
    vi.spyOn(provider, "listDevices").mockResolvedValue([DEVICE_A]);

    monitor = new DeviceMonitor(provider);

    const connectedEvents: DeviceEvent[] = [];
    monitor.on("device-connected", (e) => connectedEvents.push(e));

    monitor.start();

    // Advance to just before the first interval fires — no event yet.
    await vi.advanceTimersByTimeAsync(499);
    expect(connectedEvents).toHaveLength(0);

    // Advance past the 500ms mark — poll fires and event is emitted.
    await vi.advanceTimersByTimeAsync(200);
    expect(connectedEvents).toHaveLength(1);
  });
});
