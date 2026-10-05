/**
 * CTAP2 authenticatorMakeCredential command.
 *
 * Implements the `authenticatorMakeCredential` (0x01) CTAP2 command to create
 * a new FIDO2 discoverable (resident) credential on a hardware authenticator.
 *
 * References:
 *   - FIDO2 CTAP2 specification, §6.1 authenticatorMakeCredential
 *     https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#authenticatorMakeCredential
 *
 * Requirements: Req 2.2, Req 23.2
 */

import HID from "node-hid";
import { createHash } from "node:crypto";
import { cborEncode, decodeCbor2Map } from "./cbor";
import { ctap2Exchange } from "./hid-transport";
import { CTAP2_CMD, CTAP2_STATUS } from "./types";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Parameters for authenticatorMakeCredential */
export interface MakeCredentialParams {
  /** Relying party identifier (e.g. "keywallet://app") */
  rpId: string;
  /** Human-readable name of the relying party */
  rpName: string;
  /** User ID as raw bytes */
  userId: Uint8Array;
  /** Human-readable account name (e.g. username or email) */
  userName: string;
  /** Human-readable display name for the user */
  userDisplayName: string;
}

/** Result returned by makeCredential on success */
export interface MakeCredentialResult {
  /** The credential ID created on the authenticator */
  credentialId: Uint8Array;
  /**
   * Authenticator attachment type.
   * Always "cross-platform" for hardware security keys.
   */
  authenticatorAttachment: "cross-platform";
  /**
   * The credential public key in COSE format (CBOR-encoded).
   * ES256 (alg -7) — COSE_Key with kty=2 (EC2), crv=1 (P-256).
   */
  publicKeyBytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// authData layout constants
// ---------------------------------------------------------------------------

/** Byte offset and size constants for authenticator data (authData) */
const AUTH_DATA = {
  /** rpIdHash occupies bytes 0–31 (32 bytes, SHA-256 of rpId) */
  RP_ID_HASH_OFFSET: 0,
  RP_ID_HASH_SIZE: 32,
  /** Flags byte at offset 32 */
  FLAGS_OFFSET: 32,
  /** signCount: 4 bytes big-endian at offset 33 */
  SIGN_COUNT_OFFSET: 33,
  SIGN_COUNT_SIZE: 4,
  /** attestedCredentialData starts at offset 37 */
  ATTESTED_CRED_DATA_OFFSET: 37,
  /** aaguid: 16 bytes */
  AAGUID_SIZE: 16,
  /** credIdLen: 2 bytes big-endian */
  CRED_ID_LEN_SIZE: 2,
} as const;

/** Flags byte bit positions (per CTAP2 spec §6.1) */
const FLAGS = {
  /** Bit 0: UP — User Presence */
  UP: 0x01,
  /** Bit 2: UV — User Verification */
  UV: 0x04,
  /** Bit 6: AT — Attested Credential Data included */
  AT: 0x40,
} as const;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps a CTAP2 status byte to a descriptive Error.
 * Returns undefined when status is CTAP2_OK (0x00).
 */
function ctap2StatusToError(status: number): Error | undefined {
  if (status === CTAP2_STATUS.CTAP2_OK) return undefined;

  const messages: Record<number, string> = {
    [CTAP2_STATUS.CTAP1_ERR_INVALID_COMMAND]: "Invalid command",
    [CTAP2_STATUS.CTAP1_ERR_INVALID_PARAMETER]: "Invalid parameter",
    [CTAP2_STATUS.CTAP1_ERR_INVALID_LENGTH]: "Invalid length",
    [CTAP2_STATUS.CTAP1_ERR_TIMEOUT]: "Operation timed out on authenticator",
    [CTAP2_STATUS.CTAP1_ERR_CHANNEL_BUSY]: "Channel busy — another operation is in progress",
    [CTAP2_STATUS.CTAP2_ERR_CBOR_UNEXPECTED_TYPE]: "CBOR unexpected type",
    [CTAP2_STATUS.CTAP2_ERR_INVALID_CBOR]: "Invalid CBOR encoding",
    [CTAP2_STATUS.CTAP2_ERR_MISSING_PARAMETER]: "Missing required parameter",
    [CTAP2_STATUS.CTAP2_ERR_LIMIT_EXCEEDED]: "Authenticator storage limit exceeded",
    [CTAP2_STATUS.CTAP2_ERR_FP_DATABASE_FULL]: "Fingerprint database full",
    [CTAP2_STATUS.CTAP2_ERR_LARGE_BLOB_STORAGE_FULL]: "Large blob storage full",
    [CTAP2_STATUS.CTAP2_ERR_CREDENTIAL_EXCLUDED]:
      "Credential already enrolled on this authenticator",
    [CTAP2_STATUS.CTAP2_ERR_PROCESSING]: "Authenticator is processing",
    [CTAP2_STATUS.CTAP2_ERR_INVALID_CREDENTIAL]: "Invalid credential",
    [CTAP2_STATUS.CTAP2_ERR_USER_ACTION_PENDING]:
      "User action pending — touch the authenticator",
    [CTAP2_STATUS.CTAP2_ERR_OPERATION_PENDING]: "Another operation is pending",
    [CTAP2_STATUS.CTAP2_ERR_NO_OPERATIONS]: "No pending operations",
    [CTAP2_STATUS.CTAP2_ERR_UNSUPPORTED_ALGORITHM]: "Unsupported algorithm (requires ES256 / -7)",
    [CTAP2_STATUS.CTAP2_ERR_OPERATION_DENIED]:
      "Operation denied — user verification may be required",
    [CTAP2_STATUS.CTAP2_ERR_KEY_STORE_FULL]:
      "Authenticator key store is full — delete existing credentials",
    [CTAP2_STATUS.CTAP2_ERR_UNSUPPORTED_OPTION]: "Unsupported option (rk or uv may be required)",
    [CTAP2_STATUS.CTAP2_ERR_INVALID_OPTION]: "Invalid option combination",
    [CTAP2_STATUS.CTAP2_ERR_KEEPALIVE_CANCEL]: "Operation cancelled via keepalive",
    [CTAP2_STATUS.CTAP2_ERR_NO_CREDENTIALS]: "No matching credentials found",
    [CTAP2_STATUS.CTAP2_ERR_USER_ACTION_TIMEOUT]:
      "User action timeout — touch the authenticator within the time limit",
    [CTAP2_STATUS.CTAP2_ERR_NOT_ALLOWED]: "Operation not allowed",
    [CTAP2_STATUS.CTAP2_ERR_PIN_INVALID]: "PIN is incorrect",
    [CTAP2_STATUS.CTAP2_ERR_PIN_BLOCKED]: "PIN is blocked — authenticator may need reset",
    [CTAP2_STATUS.CTAP2_ERR_PIN_AUTH_INVALID]: "PIN authentication is invalid",
    [CTAP2_STATUS.CTAP2_ERR_PIN_AUTH_BLOCKED]: "PIN authentication blocked temporarily",
    [CTAP2_STATUS.CTAP2_ERR_PIN_NOT_SET]: "PIN is not set on this authenticator",
    [CTAP2_STATUS.CTAP2_ERR_PUAT_REQUIRED]: "PIN/UV auth token required",
    [CTAP2_STATUS.CTAP2_ERR_PIN_POLICY_VIOLATION]: "PIN does not meet policy requirements",
    [CTAP2_STATUS.CTAP2_ERR_REQUEST_TOO_LARGE]: "Request too large for authenticator",
    [CTAP2_STATUS.CTAP2_ERR_ACTION_TIMEOUT]: "Authenticator action timed out",
    [CTAP2_STATUS.CTAP2_ERR_UP_REQUIRED]: "User presence check required",
    [CTAP2_STATUS.CTAP2_ERR_UV_BLOCKED]: "User verification blocked — retry limit reached",
    [CTAP2_STATUS.CTAP2_ERR_INTEGRITY_FAILURE]: "Authenticator integrity failure",
    [CTAP2_STATUS.CTAP2_ERR_INVALID_SUBCOMMAND]: "Invalid subcommand",
    [CTAP2_STATUS.CTAP2_ERR_UV_INVALID]: "User verification is invalid",
    [CTAP2_STATUS.CTAP2_ERR_UNAUTHORIZED_PERMISSION]: "Unauthorized permission",
    [CTAP2_STATUS.CTAP2_ERR_OTHER]: "Unknown authenticator error",
  };

  const message =
    messages[status] ??
    `Authenticator error: status 0x${status.toString(16).padStart(2, "0")}`;

  return Object.assign(new Error(message), {
    ctap2Status: status,
    ctap2StatusHex: `0x${status.toString(16).padStart(2, "0")}`,
  });
}

// ---------------------------------------------------------------------------
// clientDataHash construction
// ---------------------------------------------------------------------------

/**
 * Computes the clientDataHash used in authenticatorMakeCredential.
 *
 * clientData JSON: `{"type":"webauthn.create","challenge":"...","origin":"keywallet://app"}`
 * clientDataHash  = SHA-256(UTF-8(JSON))
 *
 * The challenge is a random 32-byte value encoded as base64url without padding.
 *
 * @param challenge - 32-byte random challenge (provided externally for reproducibility in tests)
 */
function buildClientDataHash(challenge: Buffer): Buffer {
  const clientData = JSON.stringify({
    type: "webauthn.create",
    challenge: challenge.toString("base64url"),
    origin: "keywallet://app",
  });
  return createHash("sha256").update(clientData).digest();
}

// ---------------------------------------------------------------------------
// authData parsing
// ---------------------------------------------------------------------------

/**
 * Parses the authenticator data (authData) binary blob to extract the
 * credential ID and public key bytes from the attested credential data section.
 *
 * authData layout (per WebAuthn / CTAP2 spec):
 *   [0..31]  rpIdHash    — SHA-256 of the RP ID
 *   [32]     flags       — UP(0), UV(2), AT(6) bits
 *   [33..36] signCount   — 4-byte big-endian counter
 *   [37..]   attestedCredentialData (only when flags.AT is set):
 *     [37..52]    aaguid         — 16 bytes
 *     [53..54]    credIdLen      — 2-byte big-endian length of credentialId
 *     [55..55+N-1] credentialId — N bytes (credIdLen)
 *     [55+N..]    credPubKey     — CBOR-encoded COSE public key (remainder)
 *
 * @throws if authData is too short or the AT flag is not set.
 */
function parseAuthData(authData: Buffer): {
  credentialId: Uint8Array;
  publicKeyBytes: Uint8Array;
} {
  const minLength =
    AUTH_DATA.ATTESTED_CRED_DATA_OFFSET +
    AUTH_DATA.AAGUID_SIZE +
    AUTH_DATA.CRED_ID_LEN_SIZE;

  if (authData.length < minLength) {
    throw new Error(
      `authData too short: ${authData.length} bytes (minimum ${minLength})`,
    );
  }

  const flags = authData[AUTH_DATA.FLAGS_OFFSET];

  // AT bit must be set — attested credential data MUST be present
  if ((flags & FLAGS.AT) === 0) {
    throw new Error(
      `authData flags (0x${flags.toString(16)}) do not have the AT bit set — ` +
        "attested credential data is absent",
    );
  }

  // Parse attestedCredentialData
  let offset = AUTH_DATA.ATTESTED_CRED_DATA_OFFSET;

  // Skip aaguid (16 bytes)
  offset += AUTH_DATA.AAGUID_SIZE;

  // credIdLen — 2 bytes big-endian
  if (offset + AUTH_DATA.CRED_ID_LEN_SIZE > authData.length) {
    throw new Error("authData truncated before credIdLen field");
  }
  const credIdLen = authData.readUInt16BE(offset);
  offset += AUTH_DATA.CRED_ID_LEN_SIZE;

  // credentialId — credIdLen bytes
  if (offset + credIdLen > authData.length) {
    throw new Error(
      `authData truncated: expected ${credIdLen} bytes for credentialId but only ` +
        `${authData.length - offset} remain`,
    );
  }
  const credentialId = authData.slice(offset, offset + credIdLen);
  offset += credIdLen;

  // credPubKey — remainder of authData
  if (offset >= authData.length) {
    throw new Error("authData truncated: no public key bytes after credentialId");
  }
  const publicKeyBytes = authData.slice(offset);

  return {
    credentialId: new Uint8Array(credentialId),
    publicKeyBytes: new Uint8Array(publicKeyBytes),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Sends an authenticatorMakeCredential (0x01) CTAP2 command to create a new
 * ES256 discoverable credential with the `hmac-secret` extension enabled.
 *
 * The credential is created with:
 *   - `rk: true`  — resident/discoverable credential stored on authenticator
 *   - `uv: true`  — user verification (PIN/biometric) required
 *   - `hmac-secret: true` — enables the hmac-secret extension for PRF derivation
 *
 * Only cross-platform (roaming/hardware) authenticators are supported.
 * Platform authenticators (TPM, Touch ID, Windows Hello) would break the
 * portability guarantee and MUST NOT be used with KeyWallet.
 *
 * @param device  - An open node-hid HID device (from node-hid).
 * @param cid     - The allocated CTAPHID channel ID.
 * @param params  - Credential creation parameters.
 * @returns The credential ID, authenticator attachment type, and public key.
 *
 * @throws {Error} with a `ctap2Status` property if the authenticator returns
 *   a non-zero CTAP2 status code.
 * @throws {Error} if the response is malformed or authData cannot be parsed.
 */
export async function makeCredential(
  device: HID.HID,
  cid: number,
  params: MakeCredentialParams,
): Promise<MakeCredentialResult> {
  // Build clientDataHash — SHA-256 of a webauthn.create clientData object
  // Use a random 32-byte challenge each invocation
  const { randomBytes } = await import("node:crypto");
  const challenge = randomBytes(32);
  const clientDataHash = buildClientDataHash(challenge);

  // Build the CTAP2 authenticatorMakeCredential request map.
  // Keys are CTAP2 integer keys per the spec (§6.1 Table 1).
  //
  //   1  clientDataHash    (bstr, 32 bytes)
  //   2  rp                (map: id, name)
  //   3  user              (map: id, name, displayName)
  //   4  pubKeyCredParams  (array of maps: type, alg)
  //   7  options           (map: rk, uv)
  //   8  extensions        (map: hmac-secret)
  //
  // We use a JS Map to guarantee key order (integer keys must appear in the
  // map in the order the CTAP2 spec defines them for maximum compatibility).
  const requestMap = new Map<number, unknown>([
    [1, clientDataHash],
    [
      2,
      new Map<string, unknown>([
        ["id", params.rpId],
        ["name", params.rpName],
      ]),
    ],
    [
      3,
      new Map<string, unknown>([
        ["id", Buffer.from(params.userId)],
        ["name", params.userName],
        ["displayName", params.userDisplayName],
      ]),
    ],
    [
      4,
      [
        new Map<string, unknown>([
          ["type", "public-key"],
          ["alg", -7], // ES256
        ]),
      ],
    ],
    [
      7,
      new Map<string, unknown>([
        ["rk", true],
        ["uv", true],
      ]),
    ],
    [
      8,
      new Map<string, unknown>([
        ["hmac-secret", true],
      ]),
    ],
  ]);

  const cborPayload = cborEncode(requestMap);

  // Exchange with authenticator
  const { status, body } = await ctap2Exchange(
    device,
    cid,
    CTAP2_CMD.MAKE_CREDENTIAL,
    cborPayload,
  );

  // Check status
  const err = ctap2StatusToError(status);
  if (err !== undefined) {
    throw err;
  }

  // Decode the CBOR response map
  // Response keys (§6.1 Table 2):
  //   1  fmt       (tstr)   — attestation format (e.g. "packed", "none")
  //   2  authData  (bstr)   — authenticator data
  //   3  attStmt   (map)    — attestation statement (format-specific)
  if (body.length === 0) {
    throw new Error("authenticatorMakeCredential response has no CBOR body");
  }

  const responseMap = decodeCbor2Map(body);

  // Key 2: authData (required)
  const authDataRaw = responseMap.get(2);
  if (!authDataRaw || !(authDataRaw instanceof Buffer) && !(authDataRaw instanceof Uint8Array)) {
    throw new Error(
      `authenticatorMakeCredential response missing or invalid authData (key 2); ` +
        `got ${authDataRaw === undefined ? "undefined" : typeof authDataRaw}`,
    );
  }
  const authData = Buffer.isBuffer(authDataRaw)
    ? authDataRaw
    : Buffer.from(authDataRaw as Uint8Array);

  // Parse authData to extract credentialId and publicKeyBytes
  const { credentialId, publicKeyBytes } = parseAuthData(authData);

  return {
    credentialId,
    authenticatorAttachment: "cross-platform",
    publicKeyBytes,
  };
}
