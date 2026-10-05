/**
 * CTAP2 HID transport types and constants.
 *
 * References:
 *   - FIDO2 Client to Authenticator Protocol (CTAP) v2.1, Section 8 (USB HID)
 *   - https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html
 */

// ---------------------------------------------------------------------------
// CTAP2 Command codes (first byte of CBOR request, sent inside CTAPHID_CBOR)
// ---------------------------------------------------------------------------

/** CTAP2 command codes */
export const CTAP2_CMD = {
  /** authenticatorMakeCredential (0x01) — create a new credential */
  MAKE_CREDENTIAL: 0x01,
  /** authenticatorGetAssertion (0x02) — authenticate / get hmac-secret output */
  GET_ASSERTION: 0x02,
  /** authenticatorGetInfo (0x04) — query authenticator capabilities */
  GET_INFO: 0x04,
  /** authenticatorCredentialManagement (0x0A) — enumerate/delete resident credentials */
  CREDENTIAL_MANAGEMENT: 0x0a,
} as const;

export type Ctap2CmdCode = (typeof CTAP2_CMD)[keyof typeof CTAP2_CMD];

// ---------------------------------------------------------------------------
// CTAPHID Command codes (CMD byte in HID packet header)
// ---------------------------------------------------------------------------

/** CTAPHID channel broadcast — used for CTAPHID_INIT before a channel is allocated */
export const CTAPHID_BROADCAST_CID = 0xffffffff;

/** CTAPHID command codes */
export const CTAPHID_CMD = {
  /** CTAPHID_PING  (0x01) — echo request */
  PING: 0x81,
  /** CTAPHID_MSG   (0x03) — CTAP1/U2F message (legacy) */
  MSG: 0x83,
  /** CTAPHID_CBOR  (0x10 | 0x80 = 0x90) — CTAP2 CBOR command */
  CBOR: 0x90,
  /** CTAPHID_INIT  (0x06 | 0x80 = 0x86) — channel initialisation request */
  INIT: 0x86,
  /** CTAPHID_WINK  (0x08) — light up / wink the authenticator */
  WINK: 0x88,
  /** CTAPHID_ERROR (0x3f | 0x80 = 0xbf) — error response from authenticator */
  ERROR: 0xbf,
  /** CTAPHID_KEEPALIVE (0x3b | 0x80 = 0xbb) — authenticator processing, please wait */
  KEEPALIVE: 0xbb,
  /** CTAPHID_CANCEL (0x11 | 0x80 = 0x91) — abort current operation */
  CANCEL: 0x91,
} as const;

export type CtaphidCmdCode = (typeof CTAPHID_CMD)[keyof typeof CTAPHID_CMD];

// ---------------------------------------------------------------------------
// CTAP2 Status / Error codes
// Reference: CTAP2 spec §6 — Authenticator API, Table 6
// ---------------------------------------------------------------------------

/** CTAP2 status / error codes returned as the first byte of a CTAPHID_CBOR response */
export const CTAP2_STATUS = {
  CTAP2_OK: 0x00,

  // CTAP1/U2F compatible errors
  CTAP1_ERR_INVALID_COMMAND: 0x01,
  CTAP1_ERR_INVALID_PARAMETER: 0x02,
  CTAP1_ERR_INVALID_LENGTH: 0x03,
  CTAP1_ERR_INVALID_SEQ: 0x04,
  CTAP1_ERR_TIMEOUT: 0x05,
  CTAP1_ERR_CHANNEL_BUSY: 0x06,
  CTAP1_ERR_LOCK_REQUIRED: 0x0a,
  CTAP1_ERR_INVALID_CHANNEL: 0x0b,

  // CTAP2 errors
  CTAP2_ERR_CBOR_UNEXPECTED_TYPE: 0x11,
  CTAP2_ERR_INVALID_CBOR: 0x12,
  CTAP2_ERR_MISSING_PARAMETER: 0x14,
  CTAP2_ERR_LIMIT_EXCEEDED: 0x15,
  CTAP2_ERR_FP_DATABASE_FULL: 0x17,
  CTAP2_ERR_LARGE_BLOB_STORAGE_FULL: 0x18,
  CTAP2_ERR_CREDENTIAL_EXCLUDED: 0x19,
  CTAP2_ERR_PROCESSING: 0x21,
  CTAP2_ERR_INVALID_CREDENTIAL: 0x22,
  CTAP2_ERR_USER_ACTION_PENDING: 0x23,
  CTAP2_ERR_OPERATION_PENDING: 0x24,
  CTAP2_ERR_NO_OPERATIONS: 0x25,
  CTAP2_ERR_UNSUPPORTED_ALGORITHM: 0x26,
  CTAP2_ERR_OPERATION_DENIED: 0x27,
  CTAP2_ERR_KEY_STORE_FULL: 0x28,
  CTAP2_ERR_UNSUPPORTED_OPTION: 0x2b,
  CTAP2_ERR_INVALID_OPTION: 0x2c,
  CTAP2_ERR_KEEPALIVE_CANCEL: 0x2d,
  CTAP2_ERR_NO_CREDENTIALS: 0x2e,
  CTAP2_ERR_USER_ACTION_TIMEOUT: 0x2f,
  CTAP2_ERR_NOT_ALLOWED: 0x30,
  CTAP2_ERR_PIN_INVALID: 0x31,
  CTAP2_ERR_PIN_BLOCKED: 0x32,
  CTAP2_ERR_PIN_AUTH_INVALID: 0x33,
  CTAP2_ERR_PIN_AUTH_BLOCKED: 0x34,
  CTAP2_ERR_PIN_NOT_SET: 0x35,
  CTAP2_ERR_PUAT_REQUIRED: 0x36,
  CTAP2_ERR_PIN_POLICY_VIOLATION: 0x37,
  CTAP2_ERR_REQUEST_TOO_LARGE: 0x39,
  CTAP2_ERR_ACTION_TIMEOUT: 0x3a,
  CTAP2_ERR_UP_REQUIRED: 0x3b,
  CTAP2_ERR_UV_BLOCKED: 0x3c,
  CTAP2_ERR_INTEGRITY_FAILURE: 0x3d,
  CTAP2_ERR_INVALID_SUBCOMMAND: 0x3e,
  CTAP2_ERR_UV_INVALID: 0x3f,
  CTAP2_ERR_UNAUTHORIZED_PERMISSION: 0x40,
  CTAP2_ERR_OTHER: 0x7f,
  CTAP2_ERR_SPEC_LAST: 0xdf,
  CTAP2_ERR_EXTENSION_FIRST: 0xe0,
  CTAP2_ERR_EXTENSION_LAST: 0xef,
  CTAP2_ERR_VENDOR_FIRST: 0xf0,
  CTAP2_ERR_VENDOR_LAST: 0xff,
} as const;

export type Ctap2StatusCode = (typeof CTAP2_STATUS)[keyof typeof CTAP2_STATUS];

// ---------------------------------------------------------------------------
// CTAPHID packet layout constants
// ---------------------------------------------------------------------------

/** Total size of a single HID report (including report ID byte) */
export const HID_REPORT_SIZE = 65;

/** Size of the HID packet payload (without the 0x00 report ID prefix) */
export const HID_PACKET_SIZE = 64;

/** Number of channel-ID bytes at the start of every packet */
export const CID_SIZE = 4;

/** Initialization packet: CID(4) + CMD(1) + BCNTH(1) + BCNTL(1) + DATA(57) */
export const INIT_PACKET_HEADER_SIZE = 7; // CID + CMD + BCNTH + BCNTL
export const INIT_PACKET_DATA_SIZE = HID_PACKET_SIZE - INIT_PACKET_HEADER_SIZE; // 57 bytes

/** Continuation packet: CID(4) + SEQ(1) + DATA(59) */
export const CONT_PACKET_HEADER_SIZE = 5; // CID + SEQ
export const CONT_PACKET_DATA_SIZE = HID_PACKET_SIZE - CONT_PACKET_HEADER_SIZE; // 59 bytes

/** Maximum sequence number for continuation packets (0x00..0x7F) */
export const MAX_SEQ = 0x7f;

/** Bit that marks a command byte as a command (vs continuation) packet */
export const CMD_BIT = 0x80;

// ---------------------------------------------------------------------------
// CTAPHID_INIT nonce/response layout
// ---------------------------------------------------------------------------

/** Nonce size sent in CTAPHID_INIT request */
export const CTAPHID_INIT_NONCE_SIZE = 8;

/** Minimum size of a valid CTAPHID_INIT response payload */
export const CTAPHID_INIT_RESPONSE_SIZE = 17;

// ---------------------------------------------------------------------------
// TypeScript types for HID packets and CTAPHID frames
// ---------------------------------------------------------------------------

/** A raw 64-byte HID packet payload (without report-ID prefix) */
export interface HidPacket {
  /** Raw 64-byte buffer */
  data: Buffer;
}

/** Parsed CTAPHID initialization packet */
export interface CtaphidInitPacket {
  /** 4-byte channel ID */
  cid: number;
  /** Command byte (bit 7 must be set) */
  cmd: number;
  /** Total BCNT (big-endian: BCNTH<<8 | BCNTL) */
  bcnt: number;
  /** Up to 57 bytes of payload data from this packet */
  data: Buffer;
}

/** Parsed CTAPHID continuation packet */
export interface CtaphidContPacket {
  /** 4-byte channel ID */
  cid: number;
  /** Sequence number (0x00–0x7F) */
  seq: number;
  /** Up to 59 bytes of payload data from this packet */
  data: Buffer;
}

/** A fully reassembled CTAPHID message (from one or more packets) */
export interface CtaphidMessage {
  /** 4-byte channel ID */
  cid: number;
  /** CTAPHID command code */
  cmd: number;
  /** Full reassembled payload (BCNT bytes) */
  data: Buffer;
}

/** Result of a CTAPHID channel initialisation (response to CTAPHID_INIT) */
export interface CtaphidInitResult {
  /** Newly allocated channel ID for use in subsequent requests */
  cid: number;
  /** Device CTAPHID protocol version (must be 2) */
  protocolVersion: number;
  /** Device-reported major version */
  deviceVersionMajor: number;
  /** Device-reported minor version */
  deviceVersionMinor: number;
  /** Device-reported build version */
  deviceVersionBuild: number;
  /** Capabilities bitmask */
  capabilities: number;
}

/** Capability flag bits returned in CTAPHID_INIT response */
export const CAPABILITY = {
  /** Device supports CTAP2 CBOR commands */
  CBOR: 0x04,
  /** Device does NOT support CTAP1/U2F (legacy) */
  NMSG: 0x08,
} as const;

/** CTAP2 CBOR response: first byte is the status code, remainder is the CBOR map */
export interface Ctap2Response {
  /** CTAP2 status code (0x00 = success) */
  status: number;
  /** CBOR-encoded response body (undefined if status != 0) */
  cborPayload: Buffer | undefined;
}

/** CTAPHID keepalive status values */
export const KEEPALIVE_STATUS = {
  /** Authenticator is processing */
  PROCESSING: 0x01,
  /** Authenticator is waiting for user presence (touch) */
  UP_NEEDED: 0x02,
} as const;
