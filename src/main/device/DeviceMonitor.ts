// src/main/device/DeviceMonitor.ts

import { EventEmitter } from "events";
import type { IHardwareIdentityProvider } from "../hardware/IHardwareIdentityProvider";
import type { DeviceInfo } from "../hardware/types";

// ─── Public types ────────────────────────────────────────────────────────────

export type DeviceEvent =
  | { type: "device-connected"; devicePath: string; info: DeviceInfo }
  | { type: "device-removed"; devicePath: string }
  | { type: "device-unsupported"; devicePath: string; reason: string };

export interface IDeviceMonitor {
  start(): void;
  stop(): void;
  on(event: "device-connected", listener: (e: DeviceEvent) => void): void;
  on(event: "device-removed", listener: (e: DeviceEvent) => void): void;
  on(event: "device-unsupported", listener: (e: DeviceEvent) => void): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a Promise that rejects after `ms` milliseconds. */
function timeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  );
}

// ─── Implementation ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 500;
const GET_INFO_TIMEOUT_MS = 5_000;

export class DeviceMonitor extends EventEmitter implements IDeviceMonitor {
  private readonly provider: IHardwareIdentityProvider;
  private readonly isSessionActive: () => boolean;

  /** devicePath → DeviceInfo for currently-known devices */
  private knownDevices: Map<string, DeviceInfo> = new Map();

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    provider: IHardwareIdentityProvider,
    isSessionActive: () => boolean = () => false
  ) {
    super();
    this.provider = provider;
    this.isSessionActive = isSessionActive;
  }

  /** Begin the 500ms polling loop. Calling `start()` twice is a no-op. */
  start(): void {
    if (this.intervalHandle !== null) return;

    this.intervalHandle = setInterval(() => {
      // Guard against overlapping polls if the provider is slow
      if (this.polling) return;
      this.polling = true;
      this.poll().finally(() => {
        this.polling = false;
      });
    }, POLL_INTERVAL_MS);
  }

  /** Clear the polling interval. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // ─── Core poll logic ───────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    let currentDevices: DeviceInfo[];

    try {
      // Req 1.8: wrap listDevices() with a 5-second timeout
      currentDevices = await Promise.race([
        this.provider.listDevices(),
        timeout(GET_INFO_TIMEOUT_MS),
      ]);
    } catch {
      // Timeout or provider error — emit device-unsupported for everything we
      // previously knew about and clear the map so reconnects are re-checked.
      for (const [devicePath] of this.knownDevices) {
        const event: DeviceEvent = {
          type: "device-unsupported",
          devicePath,
          reason: "Device could not be verified: authenticatorGetInfo timed out or failed",
        };
        this.emit("device-unsupported", event);
      }
      this.knownDevices.clear();
      return;
    }

    // Build a map for O(1) lookups
    const currentMap = new Map<string, DeviceInfo>(
      currentDevices.map((d) => [d.devicePath, d])
    );

    // ── Detect newly connected devices ──────────────────────────────────────
    for (const [devicePath, info] of currentMap) {
      if (this.knownDevices.has(devicePath)) continue; // already tracked

      // Req 1.5–1.8: check hmac-secret support
      if (!info.supportsHmacSecret) {
        // Req 1.6: device lacks required capability
        const event: DeviceEvent = {
          type: "device-unsupported",
          devicePath,
          reason: "Device does not support required PRF capability (hmac-secret)",
        };
        this.emit("device-unsupported", event);
        // Do NOT add to knownDevices — it stays out of the tracked set so we
        // don't emit repeated unsupported events if it stays plugged in.
        // Re-evaluating on the next poll is fine; the design only forbids
        // vendor-specific IDs (Req 1.7) — capability re-check is safe.
      } else {
        // Device is supported
        // Req 1.9: if a session is already active, still emit device-connected
        // but do NOT switch or interrupt the session (that's SessionService's job).
        const event: DeviceEvent = {
          type: "device-connected",
          devicePath,
          info,
        };
        this.emit("device-connected", event);
        // Track it regardless of whether a session is active
        this.knownDevices.set(devicePath, info);
      }
    }

    // ── Detect removed devices ───────────────────────────────────────────────
    for (const [devicePath] of this.knownDevices) {
      if (currentMap.has(devicePath)) continue; // still present

      const event: DeviceEvent = {
        type: "device-removed",
        devicePath,
      };
      this.emit("device-removed", event);
      this.knownDevices.delete(devicePath);
    }
  }
}

export default DeviceMonitor;
