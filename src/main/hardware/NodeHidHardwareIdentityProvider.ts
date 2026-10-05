/**
 * NodeHidHardwareIdentityProvider
 *
 * Pure-Node.js CTAP2 implementation of IHardwareIdentityProvider backed by
 * `node-hid` for raw USB HID device access and the project's own CTAP2 modules
 * for protocol encoding/decoding.
 *
 * This class does NOT require any native addon beyond `node-hid` itself, making
 * it the portable alternative to Libfido2HardwareIdentityProvider.
 *
 * Windows 10 1903+ note:
 * The OS claims the FIDO2 HID interface so `node-hid` cannot see it via the
 * FIDO usage-page filter.  When the HID scan returns nothing on Windows we fall
 * back to `@vaultys/webauthn-node` (libfido2) which routes via webauthn.dll and
 * exposes the synthetic `windows://hello` device path.  All CTAP2 operations for
 * that path are then delegated to Libfido2HardwareIdentityProvider.
 *
 * KNOWN LIMITATION: The `@vaultys/webauthn-node` C++ binding does NOT implement
 * the hmac-secret extension in its GetAssertion path.  Wallet operations that
 * require the 32-byte PRF output (key derivation) will therefore fail with a
 * descriptive error when running through `windows://hello`.  Device detection
 * and enrollment work correctly.
 *
 * Requirements: Req 23.1, Req 23.5
 */
// node-hid path resolution note (Req 22.3):
// In development (app.isPackaged === false) Node.js resolves "node-hid" from
// the project's node_modules/ directory via the standard module search path.
// In a packaged Electron app (app.isPackaged === true) the electron-builder
// asarUnpack rule puts the native .node binary at:
//   <resources>/app.asar.unpacked/node_modules/node-hid/
// Electron's module resolver checks app.asar.unpacked before the ASAR archive,
// so this plain static import works in both environments without any runtime
// path manipulation.  See also: probeNativeHidModule() in src/main/index.ts.
import HID from "node-hid";
import { IHardwareIdentityProvider } from "./IHardwareIdentityProvider";
import {
  DeviceInfo,
  EnrollmentOptions,
  EnrollmentResult,
  DiscoveryResult,
  AssertionOptions,
  AssertionResult,
  CtapError,
  CtapErrorCode,
} from "./types";
import { allocateChannel } from "./ctap2/hid-transport";
import { getInfo } from "./ctap2/get-info";
import { makeCredential } from "./ctap2/make-credential";
import { getAssertion } from "./ctap2/get-assertion";
import { enumerateResidentCredentials } from "./ctap2/credential-management";
// ---------------------------------------------------------------------------
// FIDO HID filter constants
// ---------------------------------------------------------------------------
/**
 * FIDO Alliance HID usage page (0xF1D0).
 * All FIDO2 / U2F HID devices advertise this usage page with usage 0x01.
 */
const FIDO_USAGE_PAGE = 0xf1d0;
const FIDO_USAGE = 0x01;

/**
 * Synthetic device path used by libfido2 on Windows to route FIDO2 operations
 * through webauthn.dll instead of a raw HID interface.
 */
const WINDOWS_HELLO_PATH = "windows://hello";

/**
 * Known FIDO2 hardware security key vendor IDs.
 * On Windows, node-hid cannot access the FIDO HID interface but CAN see the
 * device by vendor ID. Used as a plug-in presence signal.
 * 0x1050=Yubico, 0x096e=Feitian, 0x2c97=Ledger, 0x1ea8=Nitrokey,
 * 0x20a0=SoloKeys, 0x0483=STMicro, 0x10c4=Silicon Labs
 */
const KNOWN_FIDO2_VENDORS = new Set([
  0x1050, // Yubico
  0x096e, // Feitian
  0x2c97, // Ledger
  0x1ea8, // Nitrokey
  0x20a0, // SoloKeys / Token2
  0x0483, // STMicro (OnlyKey etc.)
  0x10c4, // Silicon Labs (various keys)
]);

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------
/**
 * Maps a raw error thrown by CTAP2 modules to a CtapError.
 *
 * CTAP2 modules throw plain Error objects with messages containing CTAP
 * constant names or descriptive tokens. This function performs a best-effort
 * mapping to CtapErrorCode values.
 */
function mapCtap2Error(err: unknown): CtapError {
  const raw =
    err instanceof Error ? err.message.toUpperCase() : String(err).toUpperCase();
  const codeMap: Array<[string, CtapErrorCode]> = [
    ["PIN_INVALID", "CTAP2_ERR_PIN_INVALID"],
    ["PIN_BLOCKED", "CTAP2_ERR_PIN_BLOCKED"],
    ["NO_CREDENTIALS", "CTAP2_ERR_NO_CREDENTIALS"],
    ["KEY_STORE_FULL", "CTAP2_ERR_KEY_STORE_FULL"],
    ["OPERATION_DENIED", "CTAP2_ERR_OPERATION_DENIED"],
    ["NOT_ALLOWED", "CTAP2_ERR_NOT_ALLOWED"],
    // "Credential management not supported" Ã¢â€ â€™ NOT_ALLOWED
    ["CREDENTIAL MANAGEMENT NOT SUPPORTED", "CTAP2_ERR_NOT_ALLOWED"],
    // "PIN required" Ã¢â€ â€™ PIN_INVALID (user needs to supply PIN)
    ["PIN REQUIRED", "CTAP2_ERR_PIN_INVALID"],
  ];
  for (const [token, code] of codeMap) {
    if (raw.includes(token)) {
      return new CtapError(
        code,
        userMessageForCode(code),
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return new CtapError(
    "UNKNOWN",
    "An unexpected hardware security key error occurred.",
    err instanceof Error ? err.message : String(err),
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
// ---------------------------------------------------------------------------
// Helper: open HID device safely
// ---------------------------------------------------------------------------
/**
 * Opens a node-hid HID device by path, returning it along with a close()
 * function that is safe to call multiple times.
 */
function openDevice(devicePath: string): { device: HID.HID; close: () => void } {
  const device = new HID.HID(devicePath);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      try {
        device.close();
      } catch {
        // Ignore errors on close Ã¢â‚¬â€ device may already be disconnected.
      }
    }
  };
  return { device, close };
}


// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/**
 * Pure-Node.js implementation of {@link IHardwareIdentityProvider} using
 * `node-hid` for USB HID device access and the project's own CTAP2 protocol
 * modules for communication.
 *
 * Every public method opens the HID device, performs the CTAP2 operation,
 * and closes the device in a `finally` block Ã¢â‚¬â€ even on error.
 *
 * On Windows, when `node-hid` finds no FIDO devices (OS HID claim), the class
 * transparently falls back to `@vaultys/webauthn-node` (libfido2/webauthn.dll)
 * via the `windows://hello` synthetic path, delegating all CTAP2 operations to
 * {@link Libfido2HardwareIdentityProvider}.
 *
 * Requirements: Req 23.1, Req 23.5
 */
export class NodeHidHardwareIdentityProvider implements IHardwareIdentityProvider {
  /** Lazily-initialised Windows libfido2 delegate. */
  private windowsProvider: IHardwareIdentityProvider | undefined;

  /**
   * Returns the lazily-created {@link Libfido2HardwareIdentityProvider} used
   * to service `windows://hello` device paths on Windows.
   */
  private getWindowsProvider(): IHardwareIdentityProvider {
    if (!this.windowsProvider) {
      // Use Fido2CliHardwareIdentityProvider for windows://hello paths.
      // The bundled libfido2 CLI tools fully support the hmac-secret extension
      // via windows://hello, unlike @vaultys/webauthn-node which lacks it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Fido2CliHardwareIdentityProvider } = require("./Fido2CliHardwareIdentityProvider");
      this.windowsProvider = new Fido2CliHardwareIdentityProvider() as IHardwareIdentityProvider;
    }
    return this.windowsProvider;
  }

  /**
   * Returns info about all currently connected FIDO2/FIDO HID devices.
   *
   * Filters the full HID device list to entries with the FIDO usage page
   * (0xF1D0) and usage 0x01, then queries each with authenticatorGetInfo.
   * Devices that fail to respond are silently skipped.
   *
   * On Windows, when the FIDO filter returns nothing, falls back to
   * `@vaultys/webauthn-node` to discover the `windows://hello` path.
   *
   * Requirements: Req 23.1
   */
  async listDevices(): Promise<DeviceInfo[]> {
    const allDevices = HID.devices();
    // Filter to FIDO HID devices only
    const fidoDevices = allDevices.filter(
      (d) => d.usagePage === FIDO_USAGE_PAGE && d.usage === FIDO_USAGE,
    );
    const deviceInfos: DeviceInfo[] = [];
    for (const d of fidoDevices) {
      if (!d.path) continue;
      const { device, close } = openDevice(d.path);
      try {
        const initResult = await allocateChannel(device);
        const info = await getInfo(device, initResult.cid);
        deviceInfos.push({
          devicePath: d.path,
          supportsHmacSecret: info.supportsHmacSecret,
          supportsResidentKey: info.supportsResidentKey,
          extensions: info.extensions,
          clientPin: info.clientPin,
        });
      } catch (err) {
        // Skip devices that fail getInfo rather than aborting the whole list.
        console.warn(
          `[NodeHidHardwareIdentityProvider] getInfo failed for ${d.path}:`,
          err,
        );
      } finally {
        close();
      }
    }

    // Windows 10 1903+: OS claims the FIDO HID interface, so node-hid cannot
    // access the FIDO usage page.  However node-hid CAN see the device by its
    // vendor ID.  We use vendor-ID presence as a gate: only return the synthetic
    // windows://hello device when a known FIDO2 vendor is actually plugged in.
    if (deviceInfos.length === 0 && process.platform === "win32") {
      const hasKnownVendor = allDevices.some(
        (d) => KNOWN_FIDO2_VENDORS.has(d.vendorId),
      );
      if (hasKnownVendor) {
        console.log(
          "[NodeHidHardwareIdentityProvider] Known FIDO2 vendor detected; " +
            "using windows://hello for CTAP2 operations.",
        );
        const winDevices = await this.getWindowsProvider().listDevices();
        deviceInfos.push(...winDevices);
      }
      // If no known vendor is found, return empty array — shows SEARCHING in UI.
    }

    return deviceInfos;
  }

  /**
   * Enumerates discoverable credentials for the given RP ID on the device.
   *
   * When `devicePath === 'windows://hello'`, delegates to
   * {@link Libfido2HardwareIdentityProvider}.
   *
   * Requirements: Req 23.5
   */
  async discoverCredentials(
    devicePath: string,
    rpId: string,
  ): Promise<DiscoveryResult> {
    if (devicePath === WINDOWS_HELLO_PATH) {
      return this.getWindowsProvider().discoverCredentials(devicePath, rpId);
    }

    const { device, close } = openDevice(devicePath);
    try {
      const initResult = await allocateChannel(device);
      const cid = initResult.cid;
      const rawCredentials = await enumerateResidentCredentials(
        device,
        cid,
        rpId,
      );
      return {
        credentials: rawCredentials.map((c) => ({
          credentialId: c.credentialId,
          userDisplayName: c.userDisplayName,
          userId: c.userId,
        })),
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      // enumerateResidentCredentials throws "Credential enumeration timeout",
      // "PIN required for credential enumeration", or
      // "Credential management not supported by this authenticator".
      // Map "no credentials" semantics to an empty result.
      if (
        message.toLowerCase().includes("no credentials") ||
        message.toLowerCase().includes("no matching credentials")
      ) {
        return { credentials: [] };
      }
      throw mapCtap2Error(err);
    } finally {
      close();
    }
  }

  /**
   * Creates a new discoverable (resident) credential on the device.
   *
   * When `devicePath === 'windows://hello'`, delegates to
   * {@link Libfido2HardwareIdentityProvider}.
   *
   * Enforces the wallet's required options:
   *  - resident key (rk: true)
   *  - user verification required (uv: true)
   *  - hmac-secret extension enabled
   *
   * Requirements: Req 23.5
   */
  async createCredential(
    devicePath: string,
    options: EnrollmentOptions,
  ): Promise<EnrollmentResult> {
    if (devicePath === WINDOWS_HELLO_PATH) {
      return this.getWindowsProvider().createCredential(devicePath, options);
    }

    const { device, close } = openDevice(devicePath);
    try {
      const initResult = await allocateChannel(device);
      const cid = initResult.cid;
      const result = await makeCredential(device, cid, {
        rpId: options.rpId,
        rpName: "KeyWallet",
        userId: options.userId,
        userName: options.userName || options.userDisplayName,
        userDisplayName: options.userDisplayName,
      });
      return {
        credentialId: result.credentialId,
        authenticatorAttachment: result.authenticatorAttachment,
        publicKeyBytes: result.publicKeyBytes,
      };
    } catch (err) {
      if (err instanceof CtapError) throw err;
      throw mapCtap2Error(err);
    } finally {
      close();
    }
  }

  /**
   * Performs a CTAP2 GetAssertion with the hmac-secret extension.
   *
   * When `devicePath === 'windows://hello'`, delegates to
   * {@link Libfido2HardwareIdentityProvider}.
   *
   * NOTE: The `@vaultys/webauthn-node` C++ binding does NOT implement
   * hmac-secret in its GetAssertion path, so the Windows delegate will throw a
   * descriptive CtapError.  This is a known limitation; device detection and
   * enrollment are fully functional.
   *
   * Returns the 32-byte PRF_Output (`hmacOutput`) derived by the device from
   * the provided `hmacSalt`.
   *
   * Requirements: Req 23.5
   */
  async getAssertion(
    devicePath: string,
    options: AssertionOptions,
  ): Promise<AssertionResult> {
    if (devicePath === WINDOWS_HELLO_PATH) {
      return this.getWindowsProvider().getAssertion(devicePath, options);
    }

    const { device, close } = openDevice(devicePath);
    try {
      const initResult = await allocateChannel(device);
      const cid = initResult.cid;
      // AssertionOptions does not carry a pin field; pass undefined.
      // The CTAP2 layer will throw "PIN is required" if the device demands one.
      const result = await getAssertion(device, cid, {
        rpId: options.rpId,
        credentialId: options.credentialId,
        hmacSalt: options.hmacSalt,
        userVerification: options.userVerification,
        pin: (options as AssertionOptions & { pin?: string }).pin,
      });
      return {
        hmacOutput: result.hmacOutput,
        credentialId: result.credentialId,
      };
    } catch (err) {
      if (err instanceof CtapError) throw err;
      throw mapCtap2Error(err);
    } finally {
      close();
    }
  }
}
