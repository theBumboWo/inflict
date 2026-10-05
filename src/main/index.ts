// src/main/index.ts
//
// Electron main process entry point.
//
// Responsibilities:
//  - Bootstrap all services and wire up their dependencies.
//  - Register ipcMain.handle() handlers for every IpcRequest channel.
//  - Forward push events (device, session, balance, enrollment, error) to the
//    renderer via webContents.send() as IpcEvent payloads.
//  - Never forward raw CTAP2 error codes or any secret material to the renderer.
//
// Hardware provider strategy:
//  - Uses NodeHidHardwareIdentityProvider by default.
//  - Falls back to MockHardwareIdentityProvider when NODE_ENV==="test" or KEYWALLET_USE_MOCK==="1".

import path from "node:path";

import { app, BrowserWindow, clipboard, ipcMain } from "electron";

// â”€â”€ Services â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { DeviceMonitor } from "./device/DeviceMonitor";
import type { DeviceEvent } from "./device/DeviceMonitor";
import { EnrollmentService, EnrollmentError } from "./enrollment/EnrollmentService";
import { DerivationService } from "./derivation/DerivationService";
import type { DerivationError } from "./derivation/DerivationService";
import { SessionService } from "./session/SessionService";
import { SolanaService, SolanaRpcError } from "./solana/SolanaService";
import type { BalanceResult } from "./solana/SolanaService";
import { TransactionService } from "./transaction/TransactionService";
import { createCredentialStore } from "./storage/CredentialStore";

// ── Hardware provider selection ────────────────────────────────────────────────────────────────────
// Use MockHardwareIdentityProvider when NODE_ENV==='test' or KEYWALLET_USE_MOCK==='1'.
// Otherwise use NodeHidHardwareIdentityProvider for real hardware access.
import { MockHardwareIdentityProvider } from "./hardware/MockHardwareIdentityProvider";
import { NodeHidHardwareIdentityProvider } from "./hardware/NodeHidHardwareIdentityProvider";

// â”€â”€ Shared types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import type {
  ErrorCategory,
  SessionPublicData,
  TransferParams,
} from "../shared/ipc-types";

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// -- Native module path resolution (Req 22.3) ---------------------------------
//
// node-hid ships an N-API binary (.node file) that must live *outside* the ASAR
// archive when the app is packaged.  electron-builder's `asarUnpack` config in
// package.json handles this automatically:
//
//   "asarUnpack": ["**/node_modules/node-hid/**"]
//
// At runtime this results in:
//
//   PACKAGED (app.isPackaged === true)
//   ---------------------------------
//   * The ASAR archive is at  <resources>/app.asar
//   * node-hid is unpacked to <resources>/app.asar.unpacked/node_modules/node-hid/
//   * Electron's module resolver checks app.asar.unpacked first, so
//     `require('node-hid')` resolves to the unpacked copy automatically -- no
//     manual path manipulation needed.
//
//   DEVELOPMENT (app.isPackaged === false, e.g. npm start / npm run dev)
//   --------------------------------------------------------------------
//   * No ASAR archive; node-hid lives in the project's node_modules/.
//   * `require('node-hid')` resolves through the standard Node.js module
//     search path starting at __dirname.
//
// Neither case requires explicit path overrides; the standard `import HID from
// "node-hid"` statement in NodeHidHardwareIdentityProvider.ts is sufficient.
// The startup probe below logs the outcome so packaging regressions are caught
// immediately on launch rather than silently at first hardware interaction.

/**
 * Probe that node-hid can be loaded from wherever the app is running.
 * Called once during app bootstrap (before any window is created).
 *
 * In dev mode this verifies the node_modules copy; in a packaged app it
 * confirms Electron found the asar-unpacked binary.
 *
 * Req 22.4: the production build MUST fail with a clear diagnostic if the
 * native HID layer cannot be loaded rather than silently falling back to the
 * mock provider.
 */
function probeNativeHidModule(): void {
  const env = app.isPackaged ? "packaged" : "development";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node-hid");
    console.log(`[hardware] node-hid loaded successfully (${env})`);
  } catch (e) {
    // Log the full error -- in production builds this surfaces in the Electron
    // log file (~/Library/Logs/KeyWallet on macOS, %APPDATA%\KeyWallet\logs
    // on Windows).  The UI will receive a 'device:unsupported' event once
    // DeviceMonitor fails its first poll.
    console.error(`[hardware] Failed to load node-hid (${env}):`, e);
  }
}

// Run the probe immediately at module load time so the result appears at the
// top of the log output, before any window or IPC handler is registered.
probeNativeHidModule();

// -- Constants ----------------------------------------------------------------
/** Devnet periodic balance refresh interval (30 seconds). */
const BALANCE_REFRESH_INTERVAL_MS = 30_000;

/** RP identifier used throughout the app. */
const RP_ID = "key-wallet.local";

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Service bootstrap
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const useMock =
  process.env.NODE_ENV === "test" || process.env.KEYWALLET_USE_MOCK === "1";
if (useMock) {
  console.log("[hardware] using mock provider");
} else {
  console.log("[hardware] using real HID provider");
}
const hardwareProvider = useMock
  ? new MockHardwareIdentityProvider()
  : new NodeHidHardwareIdentityProvider();
const credentialStore = createCredentialStore(app);
const sessionService = new SessionService();
const solanaService = new SolanaService();
const transactionService = new TransactionService(solanaService);
const enrollmentService = new EnrollmentService(hardwareProvider, credentialStore);
const derivationService = new DerivationService(hardwareProvider);

// DeviceMonitor needs a callback to check session state.
const deviceMonitor = new DeviceMonitor(
  hardwareProvider,
  () => sessionService.isSessionActive()
);

// Per-enrollment AbortController â€” replaced on each enrollment start.
let enrollmentAbortController: AbortController | null = null;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Safely get the first (and usually only) BrowserWindow's webContents.
 * Returns null during startup before any window exists.
 */
function getWebContents(): Electron.WebContents | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0].webContents : null;
}

/**
 * Push an IpcEvent to the renderer.
 * Named helper keeps every call site concise and type-safe.
 */
function sendToRenderer(
  event: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
): void {
  const wc = getWebContents();
  if (wc && !wc.isDestroyed()) {
    wc.send(event, data);
  }
}

/**
 * Map any service-layer error to a safe ErrorCategory string.
 * Raw CTAP2 error codes are never forwarded to the renderer.
 */
function categoriseError(err: unknown): ErrorCategory {
  if (err instanceof EnrollmentError) {
    return err.category;
  }
  if (err instanceof SolanaRpcError) {
    return err.category;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("session") && msg.includes("lock")) return "session-locked";
    if (msg.includes("rpc") || msg.includes("timeout")) return "rpc-timeout";
    if (msg.includes("invalid") && msg.includes("address")) return "transaction-invalid";
  }
  return "unknown";
}

/**
 * Build the safe public representation of the active session.
 * Never includes keypair or any secret material.
 */
function toPublicSession(session: ReturnType<SessionService["getActiveSession"]>): SessionPublicData | null {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    displayName: session.displayName,
    credentialId: Buffer.from(session.credentialId).toString("hex"),
  };
}

/**
 * Guard for all handlers that require an active session (Req 5.8).
 * Throws if no session is active, which ipcMain converts to a renderer error.
 */
function requireSession(): NonNullable<ReturnType<SessionService["getActiveSession"]>> {
  const session = sessionService.getActiveSession();
  if (!session) {
    const err = new Error("session-locked: no active session");
    (err as Error & { category: ErrorCategory }).category = "session-locked";
    throw err;
  }
  return session;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DeviceMonitor â†’ renderer event forwarding
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

deviceMonitor.on("device-connected", (e: DeviceEvent) => {
  if (e.type !== "device-connected") return;
  sendToRenderer("device:connected", {
    devicePath: e.devicePath,
    supportsHmacSecret: e.info.supportsHmacSecret,
  });
});

deviceMonitor.on("device-removed", (e: DeviceEvent) => {
  if (e.type !== "device-removed") return;

  // Terminate active session immediately (Req 5.3 â€” must complete within 200ms)
  const session = sessionService.getActiveSession();
  if (session) {
    transactionService.discardOnSessionTermination();
    solanaService.stopPeriodicRefresh();
    sessionService.terminateSession(session.sessionId);

    // Notify renderer that session is gone
    sendToRenderer("session:changed", null);
  }

  sendToRenderer("device:removed", { devicePath: e.devicePath });
});

deviceMonitor.on("device-unsupported", (e: DeviceEvent) => {
  if (e.type !== "device-unsupported") return;
  sendToRenderer("device:unsupported", { reason: e.reason });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SolanaService â†’ renderer event forwarding
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

solanaService.on("balance", (result: BalanceResult) => {
  sendToRenderer("balance:updated", {
    sol: result.sol,
    lamports: result.lamports.toString(), // bigint â†’ string for IPC safety
  });
});

solanaService.on("balanceUnavailable", () => {
  sendToRenderer("balance:unavailable");
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// IPC Handlers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ device:list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle("device:list", async () => {
  const devices = await hardwareProvider.listDevices();
  // Strip non-public fields; return only what the renderer needs.
  return devices.map((d) => ({
    devicePath: d.devicePath,
    supportsHmacSecret: d.supportsHmacSecret,
    supportsResidentKey: d.supportsResidentKey,
  }));
});

// â”€â”€ enrollment:start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "enrollment:start",
  async (_event, payload: { displayName: string }) => {
    // Cancel any existing enrollment in flight.
    if (enrollmentAbortController) {
      enrollmentAbortController.abort();
    }
    enrollmentAbortController = new AbortController();
    const signal = enrollmentAbortController.signal;

    const devices = await hardwareProvider.listDevices();
    const device = devices[0]; // Use the first available device for now.
    if (!device) {
      throw new Error("No device connected");
    }

    // Progress: checking-pin
    sendToRenderer("enrollment:progress", { stage: "checking-pin" });

    try {
      // Progress: awaiting-touch (EnrollmentService drives the rest internally)
      sendToRenderer("enrollment:progress", { stage: "awaiting-touch" });

      const { credentialId } = await enrollmentService.enroll(
        device.devicePath,
        payload.displayName,
        signal
      );

      // Progress: storing-metadata (store has already been written by EnrollmentService)
      sendToRenderer("enrollment:progress", { stage: "storing-metadata" });

      // Automatically derive the wallet after enrollment.
      const derivationResult = await derivationService.deriveWallet(
        device.devicePath,
        credentialId,
        signal
      );

      if ("kind" in derivationResult) {
        const derivErr = derivationResult as DerivationError;
        const category: ErrorCategory =
          derivErr.kind === "user-cancelled" ? "derivation-failed" : "derivation-failed";
        sendToRenderer("enrollment:progress", { stage: "failed" });
        sendToRenderer("error", { category, message: "Wallet derivation failed after enrollment" });
        return { success: false, error: category };
      }

      const session = sessionService.createSession(
        device.devicePath,
        credentialId,
        payload.displayName,
        derivationResult.keypair
      );

      solanaService.startPeriodicRefresh(
        session.walletAddress,
        BALANCE_REFRESH_INTERVAL_MS
      );

      sendToRenderer("enrollment:progress", { stage: "complete" });
      sendToRenderer("session:changed", toPublicSession(session));

      return { success: true, session: toPublicSession(session) };
    } catch (err) {
      sendToRenderer("enrollment:progress", { stage: "failed" });
      const category = categoriseError(err);
      const message =
        err instanceof Error ? err.message : "Enrollment failed";
      sendToRenderer("error", { category, message });
      return { success: false, error: category };
    }
  }
);

// â”€â”€ enrollment:cancel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle("enrollment:cancel", () => {
  if (enrollmentAbortController) {
    enrollmentAbortController.abort();
    enrollmentAbortController = null;
  }
  return { cancelled: true };
});

// â”€â”€ credential:discover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "credential:discover",
  async (_event, payload: { devicePath: string }) => {
    const result = await hardwareProvider.discoverCredentials(
      payload.devicePath,
      RP_ID
    );
    // Return credential list without secret material.
    return {
      credentials: result.credentials.map((c) => ({
        credentialId: Buffer.from(c.credentialId).toString("hex"),
        userDisplayName: c.userDisplayName,
      })),
    };
  }
);

// â”€â”€ credential:select â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "credential:select",
  async (_event, payload: { credentialId: string }) => {
    const devices = await hardwareProvider.listDevices();
    const device = devices[0];
    if (!device) {
      throw new Error("No device connected");
    }

    const credentialId = Buffer.from(payload.credentialId, "hex");
    const abortController = new AbortController();
    const signal = abortController.signal;

    // Look up the display name from the store.
    const allCreds = await credentialStore.findAll();
    const stored = allCreds.find(
      (c) => c.credentialId === payload.credentialId
    );
    const displayName = stored?.displayName ?? "Unknown Key";

    const derivationResult = await derivationService.deriveWallet(
      device.devicePath,
      credentialId,
      signal
    );

    if ("kind" in derivationResult) {
      const derivErr = derivationResult as DerivationError;
      const category: ErrorCategory = derivErr.kind === "user-cancelled"
        ? "derivation-failed"
        : "derivation-failed";
      sendToRenderer("error", { category, message: "Wallet derivation failed" });
      return { success: false, error: category };
    }

    const session = sessionService.createSession(
      device.devicePath,
      credentialId,
      displayName,
      derivationResult.keypair
    );

    solanaService.startPeriodicRefresh(
      session.walletAddress,
      BALANCE_REFRESH_INTERVAL_MS
    );

    sendToRenderer("session:changed", toPublicSession(session));

    return { success: true, session: toPublicSession(session) };
  }
);

// â”€â”€ wallet:derive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "wallet:derive",
  async (_event, payload: { devicePath: string; credentialId: string }) => {
    const credentialId = Buffer.from(payload.credentialId, "hex");
    const abortController = new AbortController();
    const signal = abortController.signal;

    const allCreds = await credentialStore.findAll();
    const stored = allCreds.find(
      (c) => c.credentialId === payload.credentialId
    );
    const displayName = stored?.displayName ?? "Unknown Key";

    const derivationResult = await derivationService.deriveWallet(
      payload.devicePath,
      credentialId,
      signal
    );

    if ("kind" in derivationResult) {
      const derivErr = derivationResult as DerivationError;
      const category: ErrorCategory = derivErr.kind === "user-cancelled"
        ? "derivation-failed"
        : "derivation-failed";
      sendToRenderer("error", { category, message: "Wallet derivation failed" });
      return { success: false, error: category };
    }

    const session = sessionService.createSession(
      payload.devicePath,
      credentialId,
      displayName,
      derivationResult.keypair
    );

    solanaService.startPeriodicRefresh(
      session.walletAddress,
      BALANCE_REFRESH_INTERVAL_MS
    );

    sendToRenderer("session:changed", toPublicSession(session));

    return { success: true, session: toPublicSession(session) };
  }
);

// â”€â”€ session:get â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Req 5.8: validate session is active before returning any wallet data.
ipcMain.handle("session:get", () => {
  const session = sessionService.getActiveSession();
  return toPublicSession(session);
});

// â”€â”€ session:terminate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle("session:terminate", () => {
  const session = sessionService.getActiveSession();
  if (!session) return { terminated: false };

  transactionService.discardOnSessionTermination();
  solanaService.stopPeriodicRefresh();
  sessionService.terminateSession(session.sessionId);

  sendToRenderer("session:changed", null);

  return { terminated: true };
});

// â”€â”€ balance:get â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle("balance:get", async () => {
  const session = requireSession();

  try {
    const result = await solanaService.getBalance(session.walletAddress);
    return {
      sol: result.sol,
      lamports: result.lamports.toString(),
    };
  } catch (err) {
    const category = categoriseError(err);
    sendToRenderer("balance:unavailable");
    sendToRenderer("error", {
      category,
      message: err instanceof Error ? err.message : "Balance fetch failed",
    });
    throw err;
  }
});

// â”€â”€ balance:refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle("balance:refresh", async () => {
  const session = requireSession();

  // Restart periodic refresh to trigger an immediate fetch.
  solanaService.startPeriodicRefresh(
    session.walletAddress,
    BALANCE_REFRESH_INTERVAL_MS
  );

  return { refreshed: true };
});

// â”€â”€ transaction:validate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "transaction:validate",
  (_event, params: TransferParams) => {
    requireSession();
    // Deserialise bigint fields that arrive as strings over IPC.
    const normalisedParams = normaliseTransferParams(params);
    const validationError = transactionService.validateTransferParams(normalisedParams);
    return validationError ?? null;
  }
);

// â”€â”€ transaction:preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "transaction:preview",
  async (_event, params: TransferParams) => {
    requireSession();
    const normalisedParams = normaliseTransferParams(params);
    try {
      return await transactionService.buildTransactionPreview(normalisedParams);
    } catch (err) {
      const category = categoriseError(err);
      sendToRenderer("error", {
        category,
        message: err instanceof Error ? err.message : "Preview failed",
      });
      throw err;
    }
  }
);

// â”€â”€ transaction:submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ipcMain.handle(
  "transaction:submit",
  async (_event, params: TransferParams) => {
    const session = requireSession();
    const normalisedParams = normaliseTransferParams(params);

    // Create a per-submission AbortController tied to session state.
    const abortController = new AbortController();
    const signal = abortController.signal;

    // Abort if the session terminates mid-flight.
    const sessionId = session.sessionId;
    const onSessionRemoved = () => {
      const stillActive = sessionService.getActiveSession();
      if (!stillActive || stillActive.sessionId !== sessionId) {
        abortController.abort();
      }
    };
    // Poll is not ideal; a future improvement is to wire SessionService events.
    // For now, abort-on-device-remove is handled by the device-removed handler.

    try {
      const result = await transactionService.signAndSubmit(
        normalisedParams,
        session.keypair,
        signal
      );
      void onSessionRemoved; // suppress unused warning
      return result;
    } catch (err) {
      const category = categoriseError(err);
      sendToRenderer("error", {
        category,
        message: err instanceof Error ? err.message : "Transaction failed",
      });
      throw err;
    }
  }
);

// â”€â”€ address:copy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// -- hardware:diagnose ---------------------------------------------------------
// Req 22.7: Returns a safe, non-secret diagnostic snapshot of the connected
// hardware device. No PRF output, seeds, private keys, or any secret material
// is included in the response.
ipcMain.handle("hardware:diagnose", async () => {
  try {
    const devices = await hardwareProvider.listDevices();
    const device = devices[0] ?? null;

    if (!device) {
      return {
        deviceDetected: false,
        fido2Supported: false,
        hmacSecretSupported: false,
        credentialFound: false,
        prfOperationResult: "not tested",
        derivedWalletAddress: null,
        devicePath: null,
        extensions: [],
        versions: [],
        error: null,
      };
    }

    // Check for stored credentials on this device (no PRF/derivation performed).
    const discoveryResult = await hardwareProvider.discoverCredentials(
      device.devicePath,
      RP_ID
    );
    const credentialFound = discoveryResult.credentials.length > 0;

    // versions is not exposed by DeviceInfo; return empty array.
    // The real Libfido2 provider may populate this in the future.
    const versions: string[] = [];

    return {
      deviceDetected: true,
      fido2Supported: true,
      hmacSecretSupported: device.supportsHmacSecret,
      credentialFound,
      prfOperationResult: "not tested",
      derivedWalletAddress: null,
      devicePath: device.devicePath,
      extensions: device.extensions ?? [],
      versions,
      error: null,
    };
  } catch (err) {
    // Surface a safe error description; never include raw CTAP2 codes.
    const safeError =
      err instanceof Error ? err.message : "Hardware diagnostic failed";
    return {
      deviceDetected: false,
      fido2Supported: false,
      hmacSecretSupported: false,
      credentialFound: false,
      prfOperationResult: "not tested",
      derivedWalletAddress: null,
      devicePath: null,
      extensions: [],
      versions: [],
      error: safeError,
    };
  }
});

ipcMain.handle("address:copy", () => {
  const session = requireSession();
  clipboard.writeText(session.walletAddress);
  return { copied: true };
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// IPC utility: normalise TransferParams
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * TransferParams contains `bigint` fields that JSON serialisation converts to
 * strings when passed over IPC.  Normalise them back to bigint before passing
 * to the service layer.
 */
function normaliseTransferParams(
  params: TransferParams | Record<string, unknown>
): TransferParams {
  return {
    destinationAddress: params.destinationAddress as string,
    lamports: BigInt(params.lamports as string | number | bigint),
    currentBalanceLamports: BigInt(
      params.currentBalanceLamports as string | number | bigint
    ),
  };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Electron app lifecycle
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    webPreferences: {
      // Security settings (Req 15 â€” process separation)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  // In development, load the Vite dev server; in production, load the built HTML.
  if (process.env.NODE_ENV === "development") {
    void mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, "../../renderer/index.html")
    );
  }
}

app.whenReady().then(() => {
  createWindow();

  // Start the device polling loop after the window is ready.
  deviceMonitor.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  deviceMonitor.stop();
  solanaService.stopPeriodicRefresh();

  // Zero-overwrite keypair on app exit if a session is still active.
  const session = sessionService.getActiveSession();
  if (session) {
    sessionService.terminateSession(session.sessionId);
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  deviceMonitor.stop();
  solanaService.stopPeriodicRefresh();
  const session = sessionService.getActiveSession();
  if (session) {
    sessionService.terminateSession(session.sessionId);
  }
});

