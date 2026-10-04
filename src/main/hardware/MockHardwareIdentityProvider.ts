// src/main/hardware/MockHardwareIdentityProvider.ts
//
// Software mock of IHardwareIdentityProvider for use in development and tests
// (task 24 will replace this with the real Libfido2 implementation).
//
// This copy lives under src/ so it is within the rootDir for tsconfig.main.json.
// The canonical test copy at test/mocks/MockHardwareIdentityProvider.ts is
// authoritative for unit/property tests; keep them in sync.

import { createHmac, randomBytes } from "node:crypto";

import type { IHardwareIdentityProvider } from "./IHardwareIdentityProvider";
import { CtapError } from "./types";
import type {
  AssertionOptions,
  AssertionResult,
  DeviceInfo,
  DiscoveryResult,
  EnrollmentOptions,
  EnrollmentResult,
} from "./types";

const MOCK_DEVICE: DeviceInfo = {
  devicePath: "mock://device/1",
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
  clientPin: true, // PIN is set on the mock device
};

export class MockHardwareIdentityProvider implements IHardwareIdentityProvider {
  private readonly _hmacCache = new Map<string, Uint8Array>();
  private _discoveryResult: DiscoveryResult = { credentials: [] };

  setDiscoveryResult(result: DiscoveryResult): void {
    this._discoveryResult = result;
  }

  setHmacOutput(credentialId: Uint8Array, output: Uint8Array): void {
    const key = Buffer.from(credentialId).toString("hex");
    this._hmacCache.set(key, output);
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return [MOCK_DEVICE];
  }

  async discoverCredentials(
    _devicePath: string,
    _rpId: string
  ): Promise<DiscoveryResult> {
    return this._discoveryResult;
  }

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
    const publicKeyBytes = new Uint8Array(32);

    return {
      credentialId,
      authenticatorAttachment: "cross-platform",
      publicKeyBytes,
    };
  }

  async getAssertion(
    _devicePath: string,
    options: AssertionOptions
  ): Promise<AssertionResult> {
    const { credentialId } = options;
    const hexKey = Buffer.from(credentialId).toString("hex");

    let hmacOutput = this._hmacCache.get(hexKey);
    if (hmacOutput === undefined) {
      const digest = createHmac("sha256", "mock-secret")
        .update(Buffer.from(credentialId))
        .digest();
      hmacOutput = new Uint8Array(digest);
      this._hmacCache.set(hexKey, hmacOutput);
    }

    return { hmacOutput, credentialId };
  }
}
