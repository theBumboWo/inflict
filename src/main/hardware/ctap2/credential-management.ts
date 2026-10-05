/**
 * CTAP2 authenticatorCredentialManagement (command 0x0A)
 *
 * Enumerates resident (discoverable) credentials stored on a FIDO2
 * authenticator for a given relying party ID.
 *
 * This module uses the simplified credential enumeration path:
 *   1. Send subcommand 0x04 (enumerateCredentialsBegin) with rpIdHash
 *   2. Parse `totalCredentials` from the response
 *   3. Send subcommand 0x05 (enumerateCredentialsGetNextCredential) for each
 *      additional credential (totalCredentials - 1 times)
 *
 * If the authenticator returns CTAP2_ERR_NO_CREDENTIALS (0x2E), an empty
 * array is returned. If CTAP2_ERR_PUAT_REQUIRED (0x36) is returned, an error
 * is thrown asking the caller to supply a PIN/UV auth token.
 *
 * References:
 *   FIDO CTAP2 specification §6.8 — authenticatorCredentialManagement
 *   https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#authenticatorCredentialManagement
 *
 * Response map keys (integer, per CTAP2 spec Table 1, credMgmt):
 *   0x06  user               { id: bstr, name: str, displayName: str }
 *   0x07  totalCredentials   uint
 *   0x08  credentialID       { type: str, id: bstr }
 *
 * Requirements: Req 3.1, Req 23.2
 */

import { createHash } from "node:crypto";
import HID from "node-hid";
import { ctap2Exchange } from "./hid-transport";
import { cborEncode, decodeCbor2Map } from "./cbor";
import { CTAP2_CMD, CTAP2_STATUS } from "./types";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * A single resident credential returned by the authenticator.
 */
export interface ResidentCredential {
  /** Raw credential ID bytes as returned by the authenticator */
  credentialId: Uint8Array;
  /** Human-readable display name for the user account */
  userDisplayName: string;
  /** Opaque user ID bytes */
  userId: Uint8Array;
}

// ---------------------------------------------------------------------------
// Credential management subcommand codes
// ---------------------------------------------------------------------------

/**
 * CTAP2 credentialManagement subcommand codes.
 * These values are sent as the value of key 0x01 in the request map.
 */
const CREDMGMT_SUBCMD = {
  /** List the first matching credential for a given rpIdHash */
  ENUMERATE_CREDENTIALS_BEGIN: 0x04,
  /** Get the next credential in an ongoing enumeration sequence */
  ENUMERATE_CREDENTIALS_GET_NEXT: 0x05,
} as const;

// ---------------------------------------------------------------------------
// credentialManagement response map keys
// ---------------------------------------------------------------------------

/** Request map key: subCommand (uint) */
const REQ_KEY_SUBCMD = 0x01;
/** Request map key: subCommandParams (map) */
const REQ_KEY_SUBCMD_PARAMS = 0x04;

/** Response map key: user entity (map with id/name/displayName) */
const RESP_KEY_USER = 0x06;
/** Response map key: total credentials count (uint) */
const RESP_KEY_TOTAL_CREDENTIALS = 0x07;
/** Response map key: credentialID descriptor (map with type/id) */
const RESP_KEY_CREDENTIAL_ID = 0x08;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Enumerates all resident credentials stored on the authenticator for the
 * specified relying party ID.
 *
 * Uses SHA-256 of the rpId (UTF-8 encoded) as the rpIdHash sent to the
 * authenticator. The operation times out after 10 seconds if no response
 * is received from the device.
 *
 * @param device - An open node-hid HID device.
 * @param cid    - The allocated CTAPHID channel ID.
 * @param rpId   - The relying party identifier (e.g. "keywallet.app").
 * @returns      Array of resident credentials for the given rpId. Empty if none.
 * @throws       Error with message "PIN required for credential enumeration"
 *               when the authenticator requires a PIN/UV auth token.
 * @throws       Error with message "Credential enumeration timeout" on timeout.
 * @throws       Error with message "Credential management not supported" when
 *               the authenticator does not implement the credMgmt command.
 */
export async function enumerateResidentCredentials(
  device: HID.HID,
  cid: number,
  rpId: string,
): Promise<ResidentCredential[]> {
  // Compute rpIdHash = SHA-256(rpId encoded as UTF-8)
  const rpIdHash = createHash("sha256").update(rpId, "utf8").digest();

  // Build the enumerateCredentialsBegin request map
  // { 0x01: 0x04 (subCmd), 0x04: { 0x01: rpIdHash } (subCommandParams) }
  const subCmdParamsMap = new Map<number, unknown>([
    [0x01, rpIdHash], // rpIDHash
  ]);

  const beginRequestMap = new Map<number, unknown>([
    [REQ_KEY_SUBCMD, CREDMGMT_SUBCMD.ENUMERATE_CREDENTIALS_BEGIN],
    [REQ_KEY_SUBCMD_PARAMS, subCmdParamsMap],
  ]);

  const beginPayload = cborEncode(beginRequestMap);

  // Wrap the entire enumeration in a 10-second timeout
  return withTimeout(
    10_000,
    "Credential enumeration timeout",
    async () => {
      // --- Step 1: enumerateCredentialsBegin ---
      let status: number;
      let body: Buffer;

      try {
        ({ status, body } = await ctap2Exchange(
          device,
          cid,
          CTAP2_CMD.CREDENTIAL_MANAGEMENT,
          beginPayload,
        ));
      } catch (err) {
        // Some authenticators return CTAPHID_ERROR if the command is not
        // supported. Normalise this to a friendly error.
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("CTAPHID_ERROR") ||
          message.toLowerCase().includes("invalid command")
        ) {
          throw new Error("Credential management not supported by this authenticator");
        }
        throw err;
      }

      // Handle known error codes from the first exchange
      if (status === CTAP2_STATUS.CTAP2_ERR_NO_CREDENTIALS) {
        return [];
      }
      if (status === CTAP2_STATUS.CTAP2_ERR_PUAT_REQUIRED) {
        throw new Error("PIN required for credential enumeration");
      }
      if (status === CTAP2_STATUS.CTAP1_ERR_INVALID_COMMAND) {
        throw new Error("Credential management not supported by this authenticator");
      }
      if (status !== CTAP2_STATUS.CTAP2_OK) {
        throw ctap2StatusToError(status, "enumerateCredentialsBegin");
      }

      // Decode the first response
      const firstMap = decodeCbor2Map(body);
      const credentials: ResidentCredential[] = [];

      const firstCred = parseCredentialFromMap(firstMap);
      if (firstCred !== undefined) {
        credentials.push(firstCred);
      }

      // Determine how many more to fetch
      const totalCredentials = extractTotalCredentials(firstMap);
      const remaining = totalCredentials - 1;

      // --- Step 2: enumerateCredentialsGetNextCredential (repeated) ---
      const nextPayload = cborEncode(
        new Map<number, unknown>([
          [REQ_KEY_SUBCMD, CREDMGMT_SUBCMD.ENUMERATE_CREDENTIALS_GET_NEXT],
        ]),
      );

      for (let i = 0; i < remaining; i++) {
        let nextStatus: number;
        let nextBody: Buffer;

        try {
          ({ status: nextStatus, body: nextBody } = await ctap2Exchange(
            device,
            cid,
            CTAP2_CMD.CREDENTIAL_MANAGEMENT,
            nextPayload,
          ));
        } catch (err) {
          // An unexpected CTAPHID error mid-enumeration — surface as-is
          throw err;
        }

        if (nextStatus === CTAP2_STATUS.CTAP2_ERR_NO_CREDENTIALS) {
          // Authenticator says there are no more credentials; stop iterating.
          break;
        }
        if (nextStatus !== CTAP2_STATUS.CTAP2_OK) {
          throw ctap2StatusToError(nextStatus, "enumerateCredentialsGetNextCredential");
        }

        const nextMap = decodeCbor2Map(nextBody);
        const nextCred = parseCredentialFromMap(nextMap);
        if (nextCred !== undefined) {
          credentials.push(nextCred);
        }
      }

      return credentials;
    },
  );
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the `totalCredentials` field (key 0x07) from a credMgmt response.
 * Returns 1 if the field is absent (treat the single returned credential as
 * the only one).
 */
function extractTotalCredentials(map: Map<number, unknown>): number {
  const raw = map.get(RESP_KEY_TOTAL_CREDENTIALS);
  if (typeof raw === "number" && raw >= 1) {
    return raw;
  }
  // If absent, assume only the one credential already received exists.
  return 1;
}

/**
 * Attempts to parse a `ResidentCredential` from a credential-management
 * response map. Returns `undefined` if the required fields are absent.
 */
function parseCredentialFromMap(
  map: Map<number, unknown>,
): ResidentCredential | undefined {
  // --- credentialID (key 0x08) ---
  const rawCredId = map.get(RESP_KEY_CREDENTIAL_ID);
  const credentialId = extractCredentialId(rawCredId);
  if (credentialId === undefined) {
    return undefined;
  }

  // --- user entity (key 0x06) ---
  const rawUser = map.get(RESP_KEY_USER);
  const { userId, userDisplayName } = extractUser(rawUser);

  return { credentialId, userDisplayName, userId };
}

/**
 * Extracts the raw credential ID bytes from the credentialID descriptor map.
 *
 * The credentialID value is a CBOR map: { "type": "public-key", "id": <bstr> }
 * We only need the `id` field (string key "id").
 */
function extractCredentialId(
  credIdDescriptor: unknown,
): Uint8Array | undefined {
  if (!(credIdDescriptor instanceof Map)) {
    return undefined;
  }
  const idValue = credIdDescriptor.get("id");
  if (Buffer.isBuffer(idValue)) {
    return new Uint8Array(idValue);
  }
  if (idValue instanceof Uint8Array) {
    return idValue;
  }
  return undefined;
}

/**
 * Extracts userId and userDisplayName from the user entity map.
 *
 * The user value is a CBOR map: { "id": <bstr>, "name": <str>, "displayName": <str> }
 * Falls back to empty values when fields are absent.
 */
function extractUser(userEntity: unknown): {
  userId: Uint8Array;
  userDisplayName: string;
} {
  if (!(userEntity instanceof Map)) {
    return { userId: new Uint8Array(0), userDisplayName: "" };
  }

  // userId
  const rawId = userEntity.get("id");
  let userId: Uint8Array;
  if (Buffer.isBuffer(rawId)) {
    userId = new Uint8Array(rawId);
  } else if (rawId instanceof Uint8Array) {
    userId = rawId;
  } else {
    userId = new Uint8Array(0);
  }

  // displayName (prefer displayName, fall back to name)
  const displayName = userEntity.get("displayName");
  const name = userEntity.get("name");
  let userDisplayName: string;
  if (typeof displayName === "string" && displayName.length > 0) {
    userDisplayName = displayName;
  } else if (typeof name === "string") {
    userDisplayName = name;
  } else {
    userDisplayName = "";
  }

  return { userId, userDisplayName };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Converts a non-zero CTAP2 status code to a descriptive Error, preserving
 * the raw status code as a property on the error object.
 */
function ctap2StatusToError(status: number, context: string): Error {
  const messages: Record<number, string> = {
    [CTAP2_STATUS.CTAP1_ERR_INVALID_COMMAND]: "Invalid command",
    [CTAP2_STATUS.CTAP1_ERR_INVALID_PARAMETER]: "Invalid parameter",
    [CTAP2_STATUS.CTAP1_ERR_TIMEOUT]: "Operation timed out on authenticator",
    [CTAP2_STATUS.CTAP1_ERR_CHANNEL_BUSY]: "Channel busy — another operation is in progress",
    [CTAP2_STATUS.CTAP2_ERR_CBOR_UNEXPECTED_TYPE]: "CBOR unexpected type",
    [CTAP2_STATUS.CTAP2_ERR_INVALID_CBOR]: "Invalid CBOR encoding",
    [CTAP2_STATUS.CTAP2_ERR_MISSING_PARAMETER]: "Missing required parameter",
    [CTAP2_STATUS.CTAP2_ERR_NO_CREDENTIALS]: "No matching credentials found",
    [CTAP2_STATUS.CTAP2_ERR_OPERATION_DENIED]: "Operation denied",
    [CTAP2_STATUS.CTAP2_ERR_PUAT_REQUIRED]: "PIN required for credential enumeration",
    [CTAP2_STATUS.CTAP2_ERR_PIN_INVALID]: "PIN is incorrect",
    [CTAP2_STATUS.CTAP2_ERR_PIN_BLOCKED]: "PIN is blocked — authenticator may need reset",
    [CTAP2_STATUS.CTAP2_ERR_PIN_AUTH_INVALID]: "PIN authentication is invalid",
    [CTAP2_STATUS.CTAP2_ERR_PIN_AUTH_BLOCKED]: "PIN authentication blocked temporarily",
    [CTAP2_STATUS.CTAP2_ERR_PIN_NOT_SET]: "PIN is not set on this authenticator",
    [CTAP2_STATUS.CTAP2_ERR_INVALID_SUBCOMMAND]: "Invalid subcommand",
    [CTAP2_STATUS.CTAP2_ERR_NOT_ALLOWED]: "Operation not allowed",
    [CTAP2_STATUS.CTAP2_ERR_UV_BLOCKED]: "User verification blocked — retry limit reached",
    [CTAP2_STATUS.CTAP2_ERR_OTHER]: "Unknown authenticator error",
  };

  const message =
    messages[status] ??
    `Authenticator error: status 0x${status.toString(16).padStart(2, "0")}`;

  const fullMessage = `${context}: ${message}`;
  return Object.assign(new Error(fullMessage), {
    ctap2Status: status,
    ctap2StatusHex: `0x${status.toString(16).padStart(2, "0")}`,
  });
}

// ---------------------------------------------------------------------------
// Timeout utility
// ---------------------------------------------------------------------------

/**
 * Races a promise against a timeout. Throws an Error with `timeoutMessage`
 * if `fn()` does not resolve within `ms` milliseconds.
 */
async function withTimeout<T>(
  ms: number,
  timeoutMessage: string,
  fn: () => Promise<T>,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}
