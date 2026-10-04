// src/main/hardware/IHardwareIdentityProvider.ts

import type {
  DeviceInfo,
  EnrollmentOptions,
  EnrollmentResult,
  DiscoveryResult,
  AssertionOptions,
  AssertionResult,
} from "./types";

export interface IHardwareIdentityProvider {
  /**
   * Returns info about all currently connected FIDO2 devices.
   * Uses authenticatorGetInfo command.
   */
  listDevices(): Promise<DeviceInfo[]>;

  /**
   * Enumerates discoverable credentials for the given RP ID on the device.
   * Requires CTAP2 credential management support.
   */
  discoverCredentials(
    devicePath: string,
    rpId: string
  ): Promise<DiscoveryResult>;

  /**
   * Creates a new discoverable (resident) credential on the device.
   * Must set requireResidentKey: true and authenticatorAttachment: "cross-platform".
   */
  createCredential(
    devicePath: string,
    options: EnrollmentOptions
  ): Promise<EnrollmentResult>;

  /**
   * Performs a CTAP2 GetAssertion with hmac-secret extension.
   * Returns the 32-byte PRF_Output.
   */
  getAssertion(
    devicePath: string,
    options: AssertionOptions
  ): Promise<AssertionResult>;
}
