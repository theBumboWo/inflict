// test/mocks/MockHardwareIdentityProvider.ts
//
// Deterministic mock of IHardwareIdentityProvider for use in unit, property,
// and integration tests.  Never connects to real hardware.
//
// Validates: Requirements 18.6

import { createHmac, randomBytes } from "node:crypto";

import type { IHardwareIdentityProvider } from "../../src/main/hardware/IHardwareIdentityProvider";
import type {
  AssertionOptions,
  AssertionResult,
  DeviceInfo,
  DiscoveryResult,
  EnrollmentOptions,
  EnrollmentResult,
} from "../../src/main/hardware/types";
import { CtapError } from "../../src/main/hardware/types";

/** The single mock device exposed by {@link MockHardwareIdentityProvider}. */
const MOCK_DEVICE: DeviceInfo = {
  devicePath: "mock://device/1",
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
};

/**
 * In-memory mock of {@link IHardwareIdentityProvider}.
 *
 * - `listDevices()` always returns one mock FIDO2 device.
 * - `discoverCredentials()` returns whatever was last set via
 *   {@link setDiscoveryResult}; defaults to `{ credentials: [] }`.
 * - `createCredential()` validates that the options request a cross-platform
 *   resident-key credential and returns a fresh random 32-byte `credentialId`.
 * - `getAssertion()` derives a deterministic 32-byte `hmacOutput` from the
 *   `credentialId` using `HMAC-SHA256(key="mock-secret", data=credentialId)`,
 *   unless overridden via {@link setHmacOutput}.  Results are cached so the
 *   same `credentialId` always returns the same output within a test run.
 */
export class MockHardwareIdentityProvider implements IHardwareIdentityProvider {
  // -----------------------------------------------------------------------
  // Private state
  // -----------------------------------------------------------------------

  /** Cache: hex(credentialId) → hmacOutput */
  private readonly _hmacCache = new Map<string, Uint8Array>();

  /** Explicit per-credentialId overrides set by test code. */
  private readonly _hmacOverrides = new Map<string, Uint8Array>();

  /** Return value for discoverCredentials(). */
  private _discoveryResult: DiscoveryResult = { credentials: [] };

  // -----------------------------------------------------------------------
  // Test-configuration helpers
  // -----------------------------------------------------------------------

  /**
   * Override the result returned by {@link discoverCredentials} for all
   * subsequent calls.
   */
  setDiscoveryResult(result: DiscoveryResult): void {
    this._discoveryResult = result;
  }

  /**
   * Pin the `hmacOutput` that {@link getAssertion} will return for a specific
   * `credentialId`.  Useful in property tests that need to control PRF output.
   */
  setHmacOutput(credentialId: Uint8Array, output: Uint8Array): void {
    const key = Buffer.from(credentialId).toString("hex");
    this._hmacOverrides.set(key, output);
    // Also populate the cache so getAssertion() is consistent.
    this._hmacCache.set(key, output);
  }

  // -----------------------------------------------------------------------
  // IHardwareIdentityProvider implementation
  // -----------------------------------------------------------------------

  /** Returns the single mock FIDO2 device. */
  async listDevices(): Promise<DeviceInfo[]> {
    return [MOCK_DEVICE];
  }

  /**
   * Returns the discovery result configured via {@link setDiscoveryResult}.
   * The `devicePath` and `rpId` parameters are accepted but ignored — the mock
   * is device- and RP-agnostic.
   */
  async discoverCredentials(
    _devicePath: string,
    _rpId: string
  ): Promise<DiscoveryResult> {
    return this._discoveryResult;
  }

  /**
   * Validates the enrollment options and returns a random 32-byte
   * `credentialId` with `authenticatorAttachment: "cross-platform"`.
   *
   * Throws {@link CtapError} `CTAP2_ERR_NOT_ALLOWED` if the options do not
   * specify `requireResidentKey: true`, `userVerification: "required"`, and
   * `authenticatorAttachment: "cross-platform"`.
   */
  async createCredential(
    _devicePath: string,
    options: EnrollmentOptions
  ): Promise<EnrollmentResult> {
    if (
      options.requireResidentKey !== true ||
      options.userVerification !== "required" ||
      options.authenticatorAttachment !== "cross-platform"
    ) {
      throw new CtapError(
        "CTAP2_ERR_NOT_ALLOWED",
        "Credential creation requires resident key, required user verification, and cross-platform attachment."
      );
    }

    const credentialId = new Uint8Array(randomBytes(32));
    // Stub public key — 32 zero bytes (Ed25519 public key placeholder).
    const publicKeyBytes = new Uint8Array(32);

    return {
      credentialId,
      authenticatorAttachment: "cross-platform",
      publicKeyBytes,
    };
  }

  /**
   * Returns a deterministic 32-byte `hmacOutput` for the given
   * `credentialId`.
   *
   * Resolution order:
   * 1. Override set via {@link setHmacOutput} for this `credentialId`.
   * 2. Cached value from a previous call for this `credentialId`.
   * 3. Fresh `HMAC-SHA256(key="mock-secret", data=credentialId)`, then cached.
   *
   * The `devicePath`, `rpId`, and `hmacSalt` are accepted but ignored so that
   * tests do not need to supply realistic values for them.
   */
  async getAssertion(
    _devicePath: string,
    options: AssertionOptions
  ): Promise<AssertionResult> {
    const { credentialId } = options;
    const hexKey = Buffer.from(credentialId).toString("hex");

    // Check override first (setHmacOutput also populates _hmacCache, but we
    // keep a separate _hmacOverrides map so the semantics are explicit).
    let hmacOutput = this._hmacCache.get(hexKey);

    if (hmacOutput === undefined) {
      // Derive deterministically.
      const digest = createHmac("sha256", "mock-secret")
        .update(Buffer.from(credentialId))
        .digest();
      hmacOutput = new Uint8Array(digest);
      this._hmacCache.set(hexKey, hmacOutput);
    }

    return { hmacOutput: new Uint8Array(hmacOutput), credentialId };
  }
}

export default MockHardwareIdentityProvider;
