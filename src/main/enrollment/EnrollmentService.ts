// src/main/enrollment/EnrollmentService.ts
//
// Implements credential enrollment on a FIDO2/CTAP2 hardware security key.
// Only non-secret metadata (credentialId, rpId, displayName, createdAt) is
// persisted — no PRF_Output, Wallet_Seed, or private key bytes ever reach disk.
//
// Requirements: Req 2, Req 3, Req 13

import { randomBytes } from "node:crypto";

import type { IHardwareIdentityProvider } from "../hardware/IHardwareIdentityProvider";
import { CtapError } from "../hardware/types";
import type { ICredentialStore } from "../storage/CredentialStore";
import type { ErrorCategory, EnrollmentState } from "../../shared/ipc-types";

// ── Re-export EnrollmentState so callers can import it from this module ────────
export type { EnrollmentState };

// ── Constants ─────────────────────────────────────────────────────────────────

const RP_ID = "key-wallet.local";

/** Maximum seconds the caller may take to confirm PIN setup (Req 2.10). */
const PIN_CONFIRM_TIMEOUT_MS = 300_000;

/** Maximum seconds for the credential creation ceremony (Req 2.11). */
const CREDENTIAL_TIMEOUT_MS = 120_000;

// ── Typed error thrown by EnrollmentService ───────────────────────────────────

export class EnrollmentError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "EnrollmentError";
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IEnrollmentService {
  /**
   * Initiates credential enrollment on the connected device.
   * Returns the Credential_ID on success.
   *
   * @param devicePath  OS-level path identifying the FIDO2 device.
   * @param displayName Human-readable label stored alongside the credential.
   * @param signal      AbortSignal; abort() cancels the ceremony immediately.
   */
  enroll(
    devicePath: string,
    displayName: string,
    signal: AbortSignal,
  ): Promise<{ credentialId: Uint8Array }>;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class EnrollmentService implements IEnrollmentService {
  constructor(
    private readonly provider: IHardwareIdentityProvider,
    private readonly credentialStore: ICredentialStore,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async enroll(
    devicePath: string,
    displayName: string,
    signal: AbortSignal,
  ): Promise<{ credentialId: Uint8Array }> {
    // ── 1. Early abort guard ────────────────────────────────────────────────
    this._throwIfAborted(signal);

    // ── 2. PIN check (Req 2.10) ─────────────────────────────────────────────
    // authenticatorGetInfo is surfaced through listDevices(); the returned
    // DeviceInfo contains the clientPin flag via the supportsHmacSecret flag.
    // We check the device list and look at the matching device's info.
    // The DeviceInfo interface uses `clientPin?: boolean` — if false or absent,
    // the PIN has not been set and enrollment must pause.
    const devices = await this._raceAbortAndTimeout(
      this.provider.listDevices(),
      signal,
      PIN_CONFIRM_TIMEOUT_MS,
      "pin-check-timeout",
    );

    const deviceInfo = devices.find((d) => d.devicePath === devicePath);

    // If we can't find the device, treat it as an unsupported device error.
    if (!deviceInfo) {
      throw new EnrollmentError(
        "device-error",
        "Device not found: " + devicePath,
      );
    }

    // clientPin flag from authenticatorGetInfo (Req 2.10).
    // If clientPin === false, a PIN has not been set on the device.
    // Surface "pin-required" so the caller can show guidance and retry.
    if (deviceInfo.clientPin === false) {
      throw new EnrollmentError(
        "pin-required",
        "PIN has not been set on this device. Please set a PIN on your security key before enrolling.",
      );
    }

    // ── 3. Abort guard again before long ceremony ───────────────────────────
    this._throwIfAborted(signal);

    // ── 4. Build userId: 16 CSPRNG random bytes ─────────────────────────────
    // Must NOT be stored — it is ephemeral per enrollment (not secret material).
    const userId = new Uint8Array(randomBytes(16));

    // ── 5. Create credential with 120s timeout (Req 2.11) ───────────────────
    let result: import("../hardware/types").EnrollmentResult;
    try {
      result = await this._raceAbortAndTimeout(
        this.provider.createCredential(devicePath, {
          rpId: RP_ID,
          rpName: "KeyWallet",
          userId,
          userName: displayName,
          userDisplayName: displayName,
          requireResidentKey: true,
          userVerification: "required",
          authenticatorAttachment: "cross-platform",
        }),
        signal,
        CREDENTIAL_TIMEOUT_MS,
        "enrollment-timeout",
      );
    } catch (err) {
      // ── CTAP2 error mapping ──────────────────────────────────────────────
      if (err instanceof CtapError) {
        throw this._mapCtapError(err);
      }
      // Re-throw EnrollmentError (AbortError, timeout) unchanged.
      throw err;
    } finally {
      // Zero userId immediately after use (not secret, but good hygiene).
      userId.fill(0);
    }

    // ── 6. Verify authenticatorAttachment (Req 13.2, 13.3) ─────────────────
    if (result.authenticatorAttachment !== "cross-platform") {
      // Discard: do NOT persist a platform credential.
      throw new EnrollmentError(
        "enrollment-failed",
        "Only portable hardware security keys are supported. " +
          "Platform authenticators (Touch ID, Windows Hello) are not permitted " +
          "because they bind the wallet identity to a single device.",
      );
    }

    // ── 7. Persist metadata only — NO secret material (Req 2.8, 2.9) ───────
    const credentialIdHex = Buffer.from(result.credentialId).toString("hex");
    await this.credentialStore.save({
      credentialId: credentialIdHex,
      rpId: RP_ID,
      displayName,
      createdAt: new Date().toISOString(),
    });

    // ── 8. Return credentialId (Uint8Array) ─────────────────────────────────
    return { credentialId: result.credentialId };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Throws an `EnrollmentError` with category `"enrollment-failed"` if the
   * AbortSignal has already been aborted.
   */
  private _throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new EnrollmentError("enrollment-failed", "Enrollment aborted.");
    }
  }

  /**
   * Races `promise` against both the caller's AbortSignal and a timeout.
   * On abort or timeout, throws an `EnrollmentError`.
   *
   * This helper does NOT cancel the underlying promise (CTAP2 operations are
   * not cancellable mid-flight), but it ensures we don't wait indefinitely.
   */
  private _raceAbortAndTimeout<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
    timeoutTag: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const done = (action: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          action();
        }
      };

      const timer = setTimeout(() => {
        done(() =>
          reject(
            new EnrollmentError(
              "enrollment-failed",
              `Enrollment timed out (${timeoutTag}).`,
            ),
          ),
        );
      }, timeoutMs);

      const onAbort = () => {
        done(() =>
          reject(new EnrollmentError("enrollment-failed", "Enrollment aborted.")),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });

      promise.then(
        (value) => done(() => resolve(value)),
        (err: unknown) => done(() => reject(err)),
      );
    });
  }

  /**
   * Maps a `CtapError` to an `EnrollmentError` with the appropriate
   * `ErrorCategory` (Req 3.5).
   */
  private _mapCtapError(err: CtapError): EnrollmentError {
    switch (err.code) {
      case "CTAP2_ERR_KEY_STORE_FULL":
        // Req 2.7
        return new EnrollmentError(
          "storage-full",
          "Device credential storage is full. Please free up credential slots on your security key before enrolling.",
        );
      case "CTAP2_ERR_PIN_INVALID":
        return new EnrollmentError(
          "pin-required",
          "PIN is incorrect. Please check your PIN and try again.",
        );
      case "CTAP2_ERR_PIN_BLOCKED":
        return new EnrollmentError(
          "pin-locked",
          "Device PIN is locked. Do not reset the device without a backup of any existing credentials.",
        );
      case "CTAP2_ERR_OPERATION_DENIED":
      case "CTAP2_ERR_NOT_ALLOWED":
        return new EnrollmentError(
          "enrollment-failed",
          err.userMessage || "The operation was denied by the authenticator.",
        );
      case "CTAP2_ERR_NO_CREDENTIALS":
        return new EnrollmentError(
          "enrollment-failed",
          "No matching credentials found on device.",
        );
      default:
        return new EnrollmentError(
          "unknown",
          err.userMessage || "An unknown error occurred during enrollment.",
        );
    }
  }
}

export default EnrollmentService;
