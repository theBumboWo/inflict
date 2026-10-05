/**
 * CTAP2 authenticatorGetInfo (command 0x04)
 *
 * Queries the authenticator for its capabilities, supported extensions,
 * AAGUID, and configurable options.
 *
 * Reference:
 *   FIDO CTAP2 specification §6.4 — authenticatorGetInfo
 *   https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#authenticatorGetInfo
 *
 * Response map keys (integer, per CTAP2 spec Table 5):
 *   1  versions           array of strings
 *   2  extensions         array of strings
 *   3  aaguid             16-byte bstr
 *   4  options            map of string → bool
 *   5  maxMsgSize         uint (optional)
 *   6  pinUvAuthProtocols array of uint (optional)
 *
 * Requirements: Req 1.5, Req 23.2
 */

import HID from "node-hid";
import { ctap2Exchange } from "./hid-transport";
import { decodeCbor2Map } from "./cbor";
import { CTAP2_CMD } from "./types";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Parsed result of an authenticatorGetInfo response.
 *
 * All optional fields are `undefined` when absent from the response map.
 */
export interface AuthenticatorInfo {
  /** Supported CTAP/FIDO protocol versions, e.g. ["FIDO_2_0", "FIDO_2_1"] */
  versions: string[];

  /** Supported extensions, e.g. ["hmac-secret", "credProtect"] */
  extensions: string[];

  /** 16-byte AAGUID identifying the authenticator model */
  aaguid: Buffer;

  /** Authenticator option flags (subset of the full options map) */
  options: {
    /** Supports resident / discoverable credentials */
    rk: boolean | undefined;
    /** Supports user-presence test */
    up: boolean | undefined;
    /** Supports built-in user verification */
    uv: boolean | undefined;
    /** PIN / UV auth protocol is configured */
    clientPin: boolean | undefined;
    /** Supports credential management */
    credMgmt: boolean | undefined;
  };

  /** Maximum CBOR message size in bytes (optional) */
  maxMsgSize: number | undefined;

  /** Supported PIN/UV auth protocol versions (optional) */
  pinUvAuthProtocols: number[] | undefined;

  // ---------------------------------------------------------------------------
  // Derived convenience flags
  // ---------------------------------------------------------------------------

  /** True when the device advertises the "hmac-secret" extension */
  supportsHmacSecret: boolean;

  /** True when the device supports resident / discoverable credentials */
  supportsResidentKey: boolean;

  /**
   * Whether the device has a PIN configured.
   * `true`      = PIN is set.
   * `false`     = clientPin capability exists but no PIN is set yet.
   * `undefined` = device does not support clientPin at all.
   */
  clientPin: boolean | undefined;
}

// ---------------------------------------------------------------------------
// CTAP2 authenticatorGetInfo response map keys
// ---------------------------------------------------------------------------

const KEY_VERSIONS = 1;
const KEY_EXTENSIONS = 2;
const KEY_AAGUID = 3;
const KEY_OPTIONS = 4;
const KEY_MAX_MSG_SIZE = 5;
const KEY_PIN_UV_AUTH_PROTOCOLS = 6;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Sends a CTAP2 authenticatorGetInfo command to the device and returns the
 * parsed authenticator capabilities.
 *
 * @param device - An open node-hid HID device.
 * @param cid    - The allocated CTAPHID channel ID.
 * @returns      Parsed `AuthenticatorInfo`.
 * @throws       An `Error` with the CTAP2 status code when the response
 *               status byte is non-zero.
 */
export async function getInfo(
  device: HID.HID,
  cid: number,
): Promise<AuthenticatorInfo> {
  // authenticatorGetInfo requires no parameters — send empty CBOR payload
  const { status, body } = await ctap2Exchange(
    device,
    cid,
    CTAP2_CMD.GET_INFO,
    Buffer.alloc(0),
  );

  if (status !== 0x00) {
    throw new Error(
      `authenticatorGetInfo failed with CTAP2 status 0x${status.toString(16).padStart(2, "0")}`,
    );
  }

  // Decode the CBOR response map (integer keys)
  const map = decodeCbor2Map(body);

  // --- Key 1: versions (required) ---
  const versions = extractStringArray(map, KEY_VERSIONS, "versions");

  // --- Key 2: extensions (optional, treat absent as empty) ---
  const rawExtensions = map.get(KEY_EXTENSIONS);
  const extensions: string[] =
    rawExtensions != null ? asStringArray(rawExtensions, "extensions") : [];

  // --- Key 3: aaguid (required, 16-byte bstr) ---
  const rawAaguid = map.get(KEY_AAGUID);
  if (rawAaguid == null) {
    throw new Error("authenticatorGetInfo: missing required field aaguid (key 3)");
  }
  const aaguid = asBuffer(rawAaguid, "aaguid");
  if (aaguid.length !== 16) {
    throw new Error(
      `authenticatorGetInfo: aaguid must be 16 bytes, got ${aaguid.length}`,
    );
  }

  // --- Key 4: options (optional map of string → bool) ---
  const rawOptions = map.get(KEY_OPTIONS);
  const optionsMap =
    rawOptions instanceof Map ? (rawOptions as Map<unknown, unknown>) : new Map<unknown, unknown>();

  const options = {
    rk: optionalBool(optionsMap, "rk"),
    up: optionalBool(optionsMap, "up"),
    uv: optionalBool(optionsMap, "uv"),
    clientPin: optionalBool(optionsMap, "clientPin"),
    credMgmt: optionalBool(optionsMap, "credMgmt"),
  };

  // --- Key 5: maxMsgSize (optional uint) ---
  const rawMaxMsgSize = map.get(KEY_MAX_MSG_SIZE);
  const maxMsgSize: number | undefined =
    typeof rawMaxMsgSize === "number" ? rawMaxMsgSize : undefined;

  // --- Key 6: pinUvAuthProtocols (optional array of uint) ---
  const rawPinUvAuth = map.get(KEY_PIN_UV_AUTH_PROTOCOLS);
  const pinUvAuthProtocols: number[] | undefined =
    rawPinUvAuth != null ? asNumberArray(rawPinUvAuth, "pinUvAuthProtocols") : undefined;

  // --- Derived flags ---
  const supportsHmacSecret = extensions.includes("hmac-secret");
  const supportsResidentKey = options.rk === true;
  const clientPin = options.clientPin;

  return {
    versions,
    extensions,
    aaguid,
    options,
    maxMsgSize,
    pinUvAuthProtocols,
    supportsHmacSecret,
    supportsResidentKey,
    clientPin,
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Reads a required array-of-strings value from the CTAP2 response map.
 * Throws if the key is absent or the value is not an array of strings.
 */
function extractStringArray(
  map: Map<number, unknown>,
  key: number,
  fieldName: string,
): string[] {
  const raw = map.get(key);
  if (raw == null) {
    throw new Error(
      `authenticatorGetInfo: missing required field ${fieldName} (key ${key})`,
    );
  }
  return asStringArray(raw, fieldName);
}

/**
 * Asserts that `value` is an array of strings; returns it typed.
 */
function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `authenticatorGetInfo: field ${fieldName} is not an array (got ${typeof value})`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new Error(
        `authenticatorGetInfo: ${fieldName}[${i}] is not a string (got ${typeof value[i]})`,
      );
    }
  }
  return value as string[];
}

/**
 * Asserts that `value` is an array of numbers; returns it typed.
 */
function asNumberArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `authenticatorGetInfo: field ${fieldName} is not an array (got ${typeof value})`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number") {
      throw new Error(
        `authenticatorGetInfo: ${fieldName}[${i}] is not a number (got ${typeof value[i]})`,
      );
    }
  }
  return value as number[];
}

/**
 * Converts a CBOR byte-string value to a Buffer.
 * Accepts both `Buffer` and `Uint8Array`.
 */
function asBuffer(value: unknown, fieldName: string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error(
    `authenticatorGetInfo: field ${fieldName} is not a byte string (got ${typeof value})`,
  );
}

/**
 * Reads an optional boolean from the options sub-map.
 * Returns `undefined` when the key is absent; throws if the value is not
 * a boolean.
 */
function optionalBool(
  optionsMap: Map<unknown, unknown>,
  key: string,
): boolean | undefined {
  const val = optionsMap.get(key);
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "boolean") {
    throw new Error(
      `authenticatorGetInfo: options.${key} is not a boolean (got ${typeof val})`,
    );
  }
  return val;
}
