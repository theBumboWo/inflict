export interface DeviceInfo {
  /** CTAP2 device path (e.g. "/dev/hidraw0", USB HID path on Windows) */
  devicePath: string;
  /** Whether the device supports hmac-secret extension */
  supportsHmacSecret: boolean;
  /** Whether the device supports discoverable (resident) credentials */
  supportsResidentKey: boolean;
  /** Raw authenticatorGetInfo response extensions array */
  extensions: string[];
  /**
   * Whether the device has a PIN set (authenticatorGetInfo `clientPin` flag).
   * `true`  = PIN is set.
   * `false` = PIN has NOT been set — enrollment must pause until the user sets one.
   * `undefined` = device does not support clientPin (treat as PIN not required).
   */
  clientPin?: boolean;
}

export interface EnrollmentOptions {
  rpId: string;                    // "key-wallet.local"
  rpName: string;                  // "KeyWallet"
  userId: Uint8Array;              // 16-byte CSPRNG random
  userName: string;                // Display name for credential selector
  userDisplayName: string;
  requireResidentKey: true;        // literal true
  userVerification: "required";    // literal "required"
  authenticatorAttachment: "cross-platform";  // literal "cross-platform"
}

export interface EnrollmentResult {
  credentialId: Uint8Array;
  /** "cross-platform" | "platform" — must be "cross-platform" to be accepted */
  authenticatorAttachment: string;
  /** Public key bytes (Ed25519 public key on the FIDO credential, not the Solana key) */
  publicKeyBytes: Uint8Array;
}

export interface DiscoveryResult {
  credentials: Array<{
    credentialId: Uint8Array;
    userDisplayName: string;
    userId: Uint8Array;
  }>;
}

export interface AssertionOptions {
  rpId: string;
  credentialId: Uint8Array;
  /** Fixed 32-byte domain-separated PRF_Salt constant */
  hmacSalt: Uint8Array;
  userVerification: "required";
}

export interface AssertionResult {
  /** The 32-byte PRF_Output from hmac-secret extension */
  hmacOutput: Uint8Array;
  credentialId: Uint8Array;
}

export type CtapErrorCode =
  | "CTAP2_ERR_PIN_INVALID"
  | "CTAP2_ERR_PIN_BLOCKED"
  | "CTAP2_ERR_NO_CREDENTIALS"
  | "CTAP2_ERR_KEY_STORE_FULL"
  | "CTAP2_ERR_OPERATION_DENIED"
  | "CTAP2_ERR_NOT_ALLOWED"
  | "UNKNOWN";

export class CtapError extends Error {
  constructor(
    public readonly code: CtapErrorCode,
    public readonly userMessage: string,
    message?: string
  ) {
    super(message ?? userMessage);
    this.name = "CtapError";
  }
}
