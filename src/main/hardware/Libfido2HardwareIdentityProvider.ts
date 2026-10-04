// src/main/hardware/Libfido2HardwareIdentityProvider.ts
//
// WINDOWS NOTE: libfido2 on Windows requires Administrator privileges OR
// Windows 10 1903+ with WebAuthn.dll routing. See requirements.md Finding 4.
//
// This file provides a real implementation when the `@vaultys/webauthn-node`
// native addon is available, and falls back to a clear stub error when it is
// not compiled / installed.  The stub satisfies the TypeScript interface so
// the rest of the codebase can import this class unconditionally and receive
// a descriptive runtime error rather than a module-not-found crash.
//
// Requirements: Req 1.5, Req 1.7, Req 2.2, Req 4.1, Req 13.1

import type { IHardwareIdentityProvider } from "./IHardwareIdentityProvider";
import { CtapError } from "./types";
import type {
  AssertionOptions,
  AssertionResult,
  CtapErrorCode,
  DeviceInfo,
  DiscoveryResult,
  EnrollmentOptions,
  EnrollmentResult,
} from "./types";

// ---------------------------------------------------------------------------
// Attempt to load the native addon.  We do this with a try/catch so that the
// module can be imported in environments where the addon is not compiled
// (CI, Windows without the right runtime, etc.).
// ---------------------------------------------------------------------------

// Minimal typing for the subset of @vaultys/webauthn-node we use.
interface Libfido2DeviceInfo {
  path: string;
  // authenticatorGetInfo extensions array
  extensions?: string[];
  // clientPin option value
  options?: Record<string, boolean | undefined>;
}

interface Libfido2Credential {
  id: Buffer;
  user?: {
    id: Buffer;
    displayName?: string;
    name?: string;
  };
}

interface Libfido2MakeCredentialResult {
  id: Buffer;
  response: {
    attestationObject: Buffer;
    clientDataJSON: Buffer;
    // authData contains the public key
    authData?: Buffer;
  };
  authenticatorAttachment?: string;
  // raw public key bytes when available
  publicKey?: Buffer;
}

interface Libfido2GetAssertionResult {
  id: Buffer;
  response: {
    authenticatorData: Buffer;
    signature: Buffer;
    // hmac-secret output, 32 bytes
    hmacSecret?: Buffer;
  };
}

interface Libfido2Module {
  list(): Libfido2DeviceInfo[];
  getInfo(path: string): Promise<Libfido2DeviceInfo>;
  makeCredential(
    path: string,
    options: Record<string, unknown>
  ): Promise<Libfido2MakeCredentialResult>;
  getAssertion(
    path: string,
    options: Record<string, unknown>
  ): Promise<Libfido2GetAssertionResult>;
  enumerateCredentials(
    path: string,
    rpId: string,
    options?: Record<string, unknown>
  ): Promise<Libfido2Credential[]>;
}

// Attempt to load — captured once at module level.
let libfido2: Libfido2Module | null = null;
let libfido2LoadError: string | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  libfido2 = require("@vaultys/webauthn-node") as Libfido2Module;
} catch (e) {
  // Addon not available — record the reason for surfacing in error messages.
  libfido2LoadError =
    e instanceof Error
      ? e.message
      : "Unknown error loading @vaultys/webauthn-node";
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps a raw libfido2 error message or code string to a CtapErrorCode.
 *
 * libfido2 surfaces errors as exception messages containing the CTAP constant
 * name (e.g. "CTAP2_ERR_PIN_INVALID") or short tokens like "PIN_INVALID".
 */
function mapLibfido2Error(err: unknown): CtapError {
  const raw =
    err instanceof Error ? err.message.toUpperCase() : String(err).toUpperCase();

  const codeMap: Array<[string, CtapErrorCode]> = [
    ["PIN_INVALID", "CTAP2_ERR_PIN_INVALID"],
    ["PIN_BLOCKED", "CTAP2_ERR_PIN_BLOCKED"],
    ["NO_CREDENTIALS", "CTAP2_ERR_NO_CREDENTIALS"],
    ["KEY_STORE_FULL", "CTAP2_ERR_KEY_STORE_FULL"],
    ["OPERATION_DENIED", "CTAP2_ERR_OPERATION_DENIED"],
    ["NOT_ALLOWED", "CTAP2_ERR_NOT_ALLOWED"],
  ];

  for (const [token, code] of codeMap) {
    if (raw.includes(token)) {
      return new CtapError(
        code,
        userMessageForCode(code),
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return new CtapError(
    "UNKNOWN",
    "An unexpected hardware security key error occurred.",
    err instanceof Error ? err.message : String(err)
  );
}

function userMessageForCode(code: CtapErrorCode): string {
  switch (code) {
    case "CTAP2_ERR_PIN_INVALID":
      return "Incorrect PIN. Please try again.";
    case "CTAP2_ERR_PIN_BLOCKED":
      return "PIN is blocked. Reset your security key to continue.";
    case "CTAP2_ERR_NO_CREDENTIALS":
      return "No credentials found on this device for the given account.";
    case "CTAP2_ERR_KEY_STORE_FULL":
      return "The security key's credential storage is full.";
    case "CTAP2_ERR_OPERATION_DENIED":
      return "Operation was denied. Ensure the device is unlocked and try again.";
    case "CTAP2_ERR_NOT_ALLOWED":
      return "Operation not allowed by the security key.";
    default:
      return "An unexpected hardware security key error occurred.";
  }
}

/**
 * Returns the loaded libfido2 module, or throws a clear CtapError when the
 * native addon is unavailable.  Using a function return rather than an
 * `asserts` overload avoids TypeScript narrowing issues with module-level
 * nullable variables.
 */
function requireLibfido2(): Libfido2Module {
  if (libfido2 === null) {
    throw new CtapError(
      "UNKNOWN",
      "libfido2 native addon is not available on this system.",
      `libfido2 not available: ${libfido2LoadError ?? "module not loaded"}. ` +
        "Install @vaultys/webauthn-node and rebuild native addons, or use " +
        "MockHardwareIdentityProvider for development."
    );
  }
  return libfido2;
}

// ---------------------------------------------------------------------------
// TIMEOUT CONSTANT (Req 3.1)
// ---------------------------------------------------------------------------
const DISCOVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Real CTAP2 implementation of {@link IHardwareIdentityProvider} backed by
 * the `@vaultys/webauthn-node` native addon (libfido2).
 *
 * When the native addon is not compiled / installed the class still satisfies
 * the TypeScript interface but every method throws a {@link CtapError} with
 * code `"UNKNOWN"` and a descriptive message explaining that libfido2 is
 * unavailable.  This is intentional: it allows the application to import this
 * class unconditionally and degrade gracefully at runtime.
 *
 * WINDOWS NOTE: libfido2 on Windows requires Administrator privileges OR
 * Windows 10 1903+ with WebAuthn.dll routing. See requirements.md Finding 4.
 */
export class Libfido2HardwareIdentityProvider
  implements IHardwareIdentityProvider
{
  /**
   * Returns info about all currently connected FIDO2 devices.
   *
   * Calls `libfido2.list()` to enumerate HID paths, then
   * `authenticatorGetInfo` (via `libfido2.getInfo()`) for each device to
   * populate capability flags.
   *
   * Maps the `hmac-secret` extensions flag → `supportsHmacSecret` (Req 1.5).
   * Maps the `rk` options flag → `supportsResidentKey` (Req 1.7).
   */
  async listDevices(): Promise<DeviceInfo[]> {
    const fido2 = requireLibfido2();

    let rawDevices: Libfido2DeviceInfo[];
    try {
      rawDevices = fido2.list();
    } catch (err) {
      throw mapLibfido2Error(err);
    }

    const deviceInfos: DeviceInfo[] = [];

    for (const raw of rawDevices) {
      try {
        // getInfo performs the authenticatorGetInfo CTAP2 command.
        const info = await fido2.getInfo(raw.path);
        const extensions: string[] = info.extensions ?? raw.extensions ?? [];
        const options = info.options ?? raw.options ?? {};

        deviceInfos.push({
          devicePath: raw.path,
          supportsHmacSecret: extensions.includes("hmac-secret"), // Req 1.5
          supportsResidentKey:
            options["rk"] === true || options["residentKey"] === true, // Req 1.7
          extensions,
          clientPin:
            typeof options["clientPin"] === "boolean"
              ? options["clientPin"]
              : undefined,
        });
      } catch (err) {
        // If getInfo fails for one device, skip it rather than failing the
        // entire enumeration — the caller can see an empty list.
        console.warn(
          `[Libfido2HardwareIdentityProvider] getInfo failed for ${raw.path}:`,
          err
        );
      }
    }

    return deviceInfos;
  }

  /**
   * Enumerates discoverable credentials for the given RP ID on the device.
   *
   * Uses CTAP2 credential management (`enumerateCredentials`) with a 10-second
   * timeout (Req 3.1).
   */
  async discoverCredentials(
    devicePath: string,
    rpId: string
  ): Promise<DiscoveryResult> {
    const fido2 = requireLibfido2();

    let credentials: Libfido2Credential[];

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new CtapError(
                "CTAP2_ERR_NOT_ALLOWED",
                "Credential discovery timed out (10 s).",
                "discoverCredentials: timeout after 10s"
              )
            ),
          DISCOVERY_TIMEOUT_MS
        )
      );

      const discoveryPromise = fido2.enumerateCredentials(
        devicePath,
        rpId,
        { timeout: DISCOVERY_TIMEOUT_MS }
      );

      credentials = await Promise.race([discoveryPromise, timeoutPromise]);
    } catch (err) {
      if (err instanceof CtapError) throw err;
      throw mapLibfido2Error(err);
    }

    return {
      credentials: credentials.map((c) => ({
        credentialId: new Uint8Array(c.id),
        userDisplayName:
          c.user?.displayName ?? c.user?.name ?? "(unknown user)",
        userId: new Uint8Array(c.user?.id ?? Buffer.alloc(0)),
      })),
    };
  }

  /**
   * Creates a new discoverable (resident) credential on the device.
   *
   * Enforces:
   * - `requireResidentKey: true` (Req 2.2)
   * - `userVerification: "required"` (Req 2.2)
   * - `authenticatorAttachment: "cross-platform"` (Req 2.2)
   * - `hmac-secret` extension enabled (Req 4.1 prerequisite)
   */
  async createCredential(
    devicePath: string,
    options: EnrollmentOptions
  ): Promise<EnrollmentResult> {
    const fido2 = requireLibfido2();

    // Defensive runtime guard — the TypeScript literal types already enforce
    // these at compile time, but we re-check to satisfy Req 2.2.
    if (
      options.requireResidentKey !== true ||
      options.userVerification !== "required" ||
      options.authenticatorAttachment !== "cross-platform"
    ) {
      throw new CtapError(
        "CTAP2_ERR_NOT_ALLOWED",
        "Credential creation requires resident key, required UV, and cross-platform attachment.",
        "createCredential: options do not meet policy requirements"
      );
    }

    let result: Libfido2MakeCredentialResult;
    try {
      result = await fido2.makeCredential(devicePath, {
        rp: {
          id: options.rpId,
          name: options.rpName,
        },
        user: {
          id: Buffer.from(options.userId),
          name: options.userName,
          displayName: options.userDisplayName,
        },
        // Request ES256 (COSE -7) as the primary algorithm; libfido2 will pick
        // the best algorithm supported by the device.
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -8 }, // EdDSA
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
          authenticatorAttachment: "cross-platform",
        },
        extensions: {
          "hmac-secret": true, // Req 4.1 prerequisite
        },
        attestation: "none",
      });
    } catch (err) {
      throw mapLibfido2Error(err);
    }

    // Extract public key bytes.  libfido2 may expose them directly; otherwise
    // they are embedded in the attestation object and we surface the raw buffer.
    const publicKeyBytes: Uint8Array = result.publicKey
      ? new Uint8Array(result.publicKey)
      : new Uint8Array(0); // Caller must parse attestationObject if needed.

    return {
      credentialId: new Uint8Array(result.id),
      authenticatorAttachment:
        result.authenticatorAttachment ?? "cross-platform",
      publicKeyBytes,
    };
  }

  /**
   * Performs a CTAP2 GetAssertion with the `hmac-secret` extension.
   *
   * Returns the 32-byte PRF_Output (`hmacOutput`) derived by the device from
   * the provided `hmacSalt` (Req 4.1).
   */
  async getAssertion(
    devicePath: string,
    options: AssertionOptions
  ): Promise<AssertionResult> {
    const fido2 = requireLibfido2();

    let result: Libfido2GetAssertionResult;
    try {
      result = await fido2.getAssertion(devicePath, {
        rpId: options.rpId,
        allowCredentials: [
          {
            type: "public-key",
            id: Buffer.from(options.credentialId),
          },
        ],
        userVerification: options.userVerification,
        extensions: {
          // Pass the 32-byte PRF_Salt as the hmac-secret salt1 input (Req 4.1)
          "hmac-secret": {
            salt1: Buffer.from(options.hmacSalt),
          },
        },
      });
    } catch (err) {
      throw mapLibfido2Error(err);
    }

    // Ensure we received the 32-byte hmac-secret output from the device.
    const rawHmac = result.response.hmacSecret;
    if (!rawHmac || rawHmac.length !== 32) {
      throw new CtapError(
        "UNKNOWN",
        "The security key did not return an hmac-secret output. " +
          "Ensure the device supports the hmac-secret extension.",
        `getAssertion: hmacSecret output missing or wrong length (got ${rawHmac?.length ?? 0})`
      );
    }

    return {
      hmacOutput: new Uint8Array(rawHmac), // Req 4.1: 32-byte PRF_Output
      credentialId: new Uint8Array(result.id),
    };
  }
}
