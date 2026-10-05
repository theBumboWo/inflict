/**
 * CTAPHID transport layer — send and receive CTAPHID messages over USB HID.
 *
 * Protocol reference:
 *   FIDO CTAP2 specification, Section 8: USB Human Interface Device (HID) Transport
 *   https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#usb
 *
 * Framing summary:
 *   - Initialization packet: CID[4] + CMD[1] (bit7=1) + BCNTH[1] + BCNTL[1] + DATA[57]
 *   - Continuation packet:   CID[4] + SEQ[1] (bit7=0) + DATA[59]
 *   - All writes are 65 bytes (report ID 0x00 prepended to 64-byte payload).
 *   - All reads return 64-byte payloads from node-hid.
 */

import HID from "node-hid";
import { randomBytes } from "node:crypto";
import {
  CTAPHID_BROADCAST_CID,
  CTAPHID_CMD,
  CTAPHID_INIT_NONCE_SIZE,
  CTAPHID_INIT_RESPONSE_SIZE,
  CONT_PACKET_DATA_SIZE,
  CONT_PACKET_HEADER_SIZE,
  CMD_BIT,
  HID_REPORT_SIZE,
  INIT_PACKET_DATA_SIZE,
  INIT_PACKET_HEADER_SIZE,
  KEEPALIVE_STATUS,
  type CtaphidInitResult,
  type CtaphidMessage,
} from "./types";

/** Timeout waiting for a HID response packet (milliseconds) */
const RESPONSE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Packet building helpers
// ---------------------------------------------------------------------------

/**
 * Builds a 65-byte HID write buffer (report ID 0x00 + 64-byte packet).
 *
 * Initialization packet layout:
 *   [0]       report ID 0x00 (required by node-hid)
 *   [1..4]    CID (big-endian)
 *   [5]       CMD | 0x80
 *   [6]       BCNTH
 *   [7]       BCNTL
 *   [8..64]   DATA (57 bytes, zero-padded)
 */
function buildInitPacket(
  cid: number,
  cmd: number,
  bcnt: number,
  data: Buffer,
): Buffer {
  const pkt = Buffer.alloc(HID_REPORT_SIZE, 0x00);
  // Report ID
  pkt[0] = 0x00;
  // CID (big-endian uint32)
  pkt.writeUInt32BE(cid, 1);
  // CMD with high bit set
  pkt[5] = (cmd | CMD_BIT) & 0xff;
  // BCNT (big-endian uint16)
  pkt[6] = (bcnt >> 8) & 0xff;
  pkt[7] = bcnt & 0xff;
  // DATA (up to 57 bytes)
  data.copy(pkt, 8, 0, Math.min(data.length, INIT_PACKET_DATA_SIZE));
  return pkt;
}

/**
 * Builds a 65-byte HID write buffer for a continuation packet.
 *
 * Continuation packet layout:
 *   [0]       report ID 0x00
 *   [1..4]    CID (big-endian)
 *   [5]       SEQ (0x00–0x7F, bit7 must be 0)
 *   [6..64]   DATA (59 bytes, zero-padded)
 */
function buildContPacket(cid: number, seq: number, data: Buffer): Buffer {
  const pkt = Buffer.alloc(HID_REPORT_SIZE, 0x00);
  pkt[0] = 0x00;
  pkt.writeUInt32BE(cid, 1);
  pkt[5] = seq & 0x7f;
  data.copy(pkt, 6, 0, Math.min(data.length, CONT_PACKET_DATA_SIZE));
  return pkt;
}

// ---------------------------------------------------------------------------
// Write helper
// ---------------------------------------------------------------------------

/**
 * Sends a single HID report to the device.
 * node-hid's `write()` is synchronous and throws on error.
 */
function writePacket(device: HID.HID, packet: Buffer): void {
  // node-hid write() accepts a number[] or Buffer; pass the raw buffer.
  const result = device.write([...packet]);
  if (result < 0) {
    throw new Error(`HID write failed (result=${result})`);
  }
}

// ---------------------------------------------------------------------------
// Read helper
// ---------------------------------------------------------------------------

/**
 * Reads a single 64-byte HID report from the device with a timeout.
 * node-hid returns the raw payload (without the report ID byte).
 */
async function readPacket(
  device: HID.HID,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      device.removeAllListeners("data");
      device.removeAllListeners("error");
      reject(new Error(`CTAPHID read timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      clearTimeout(timer);
      device.removeAllListeners("data");
      device.removeAllListeners("error");
      resolve(Buffer.from(data));
    };

    const onError = (err: Error) => {
      clearTimeout(timer);
      device.removeAllListeners("data");
      device.removeAllListeners("error");
      reject(err);
    };

    device.once("data", onData);
    device.once("error", onError);
  });
}

// ---------------------------------------------------------------------------
// Packet parsing helpers
// ---------------------------------------------------------------------------

/** Returns true when the CMD byte of an initialization packet has bit 7 set */
function isInitPacket(cmdByte: number): boolean {
  return (cmdByte & CMD_BIT) !== 0;
}

/**
 * Parses the channel ID from the first 4 bytes of a received HID packet.
 * node-hid returns 64-byte payloads (no report ID prefix).
 */
function parseCid(pkt: Buffer): number {
  return pkt.readUInt32BE(0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends a CTAPHID message to the device, fragmenting it into 64-byte HID
 * packets as required by the CTAPHID specification.
 *
 * @param device  - An open node-hid HID device.
 * @param cid     - The channel ID (use CTAPHID_BROADCAST_CID before allocating).
 * @param cmd     - A CTAPHID command code (from CTAPHID_CMD).
 * @param data    - The message payload (arbitrary length).
 */
export function sendCtaphidMessage(
  device: HID.HID,
  cid: number,
  cmd: number,
  data: Buffer,
): void {
  const bcnt = data.length;

  // --- Initialization packet ---
  const initData = data.slice(0, INIT_PACKET_DATA_SIZE);
  const initPkt = buildInitPacket(cid, cmd, bcnt, initData);
  writePacket(device, initPkt);

  // --- Continuation packets (if payload exceeds 57 bytes) ---
  let offset = INIT_PACKET_DATA_SIZE;
  let seq = 0;
  while (offset < bcnt) {
    const chunk = data.slice(offset, offset + CONT_PACKET_DATA_SIZE);
    const contPkt = buildContPacket(cid, seq, chunk);
    writePacket(device, contPkt);
    offset += CONT_PACKET_DATA_SIZE;
    seq += 1;
    if (seq > 0x7f) {
      throw new Error("CTAPHID message too large: sequence number overflow");
    }
  }
}

/**
 * Reads HID packets from the device and reassembles them into a complete
 * CTAPHID message.  Silently skips KEEPALIVE packets (0xBB) while waiting.
 *
 * @param device  - An open node-hid HID device.
 * @param cid     - The expected channel ID to accept.
 * @returns The fully reassembled CTAPHID message.
 */
export async function receiveCtaphidMessage(
  device: HID.HID,
  cid: number,
): Promise<CtaphidMessage> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

  // --- Wait for the initialization packet ---
  let initPkt: Buffer;
  let cmd: number;
  let bcnt: number;
  let payload: Buffer;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("CTAPHID response timeout (no init packet received)");
    }
    initPkt = await readPacket(device, remaining);

    const pktCid = parseCid(initPkt);
    const cmdByte = initPkt[4];

    // Skip packets for other channels
    if (pktCid !== cid) continue;

    // Must be an initialization packet (bit 7 set)
    if (!isInitPacket(cmdByte)) {
      throw new Error(
        `Unexpected continuation packet (seq=0x${cmdByte.toString(16)}) before init packet`,
      );
    }

    cmd = cmdByte & ~CMD_BIT;

    // KEEPALIVE: authenticator is still processing, loop again
    if (cmd === (CTAPHID_CMD.KEEPALIVE & ~CMD_BIT)) {
      const status = initPkt[INIT_PACKET_HEADER_SIZE]; // 1 byte payload
      if (
        status === KEEPALIVE_STATUS.UP_NEEDED ||
        status === KEEPALIVE_STATUS.PROCESSING
      ) {
        // Continue waiting — authenticator is busy or waiting for user presence
        continue;
      }
      // Unknown keepalive status; still continue waiting
      continue;
    }

    bcnt =
      ((initPkt[5] & 0xff) << 8) | (initPkt[6] & 0xff);
    const initDataLen = Math.min(bcnt, INIT_PACKET_DATA_SIZE);
    payload = Buffer.allocUnsafe(bcnt);
    initPkt.copy(payload, 0, INIT_PACKET_HEADER_SIZE, INIT_PACKET_HEADER_SIZE + initDataLen);
    break;
  }

  // --- Read continuation packets if needed ---
  let received = Math.min(bcnt, INIT_PACKET_DATA_SIZE);
  let expectedSeq = 0;

  while (received < bcnt) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("CTAPHID response timeout (incomplete message)");
    }

    const contPkt = await readPacket(device, remaining);
    const pktCid = parseCid(contPkt);
    if (pktCid !== cid) continue; // skip other channels

    const seqByte = contPkt[4];
    if (isInitPacket(seqByte)) {
      throw new Error(
        `Unexpected init packet (cmd=0x${(seqByte & ~CMD_BIT).toString(16)}) while reading continuation`,
      );
    }
    if (seqByte !== expectedSeq) {
      throw new Error(
        `CTAPHID sequence error: expected seq=${expectedSeq}, got seq=${seqByte}`,
      );
    }

    const toRead = Math.min(bcnt - received, CONT_PACKET_DATA_SIZE);
    contPkt.copy(payload, received, CONT_PACKET_HEADER_SIZE, CONT_PACKET_HEADER_SIZE + toRead);
    received += toRead;
    expectedSeq += 1;
  }

  return { cid, cmd, data: payload };
}

// ---------------------------------------------------------------------------
// Channel allocation via CTAPHID_INIT
// ---------------------------------------------------------------------------

/**
 * Performs a CTAPHID_INIT handshake on the broadcast channel to allocate a
 * new channel ID for subsequent CTAP2 operations.
 *
 * @param device - An open node-hid HID device.
 * @returns The allocated channel ID and device version information.
 */
export async function allocateChannel(
  device: HID.HID,
): Promise<CtaphidInitResult> {
  const nonce = randomBytes(CTAPHID_INIT_NONCE_SIZE);

  // Send CTAPHID_INIT on the broadcast channel
  sendCtaphidMessage(
    device,
    CTAPHID_BROADCAST_CID,
    CTAPHID_CMD.INIT,
    nonce,
  );

  // Read responses until we get the one matching our nonce
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("CTAPHID_INIT timeout: no matching response received");
    }

    // Read a single init-packet response on the broadcast channel
    // (use the raw packet reader directly since the full message is short)
    const pkt = await readPacket(device, remaining);
    const pktCid = parseCid(pkt);
    const cmdByte = pkt[4];

    // Must be from broadcast channel and be an init-packet
    if (pktCid !== CTAPHID_BROADCAST_CID) continue;
    if (!isInitPacket(cmdByte)) continue;
    if ((cmdByte & ~CMD_BIT) !== (CTAPHID_CMD.INIT & ~CMD_BIT)) continue;

    const bcnt = ((pkt[5] & 0xff) << 8) | (pkt[6] & 0xff);
    if (bcnt < CTAPHID_INIT_RESPONSE_SIZE) continue; // malformed

    const payload = pkt.slice(INIT_PACKET_HEADER_SIZE, INIT_PACKET_HEADER_SIZE + bcnt);

    // Verify nonce matches
    const responseNonce = payload.slice(0, CTAPHID_INIT_NONCE_SIZE);
    if (!responseNonce.equals(nonce)) continue;

    // Parse the CTAPHID_INIT response fields
    const allocatedCid = payload.readUInt32BE(CTAPHID_INIT_NONCE_SIZE);
    const protocolVersion = payload[CTAPHID_INIT_NONCE_SIZE + 4];
    const deviceVersionMajor = payload[CTAPHID_INIT_NONCE_SIZE + 5];
    const deviceVersionMinor = payload[CTAPHID_INIT_NONCE_SIZE + 6];
    const deviceVersionBuild = payload[CTAPHID_INIT_NONCE_SIZE + 7];
    const capabilities = payload[CTAPHID_INIT_NONCE_SIZE + 8];

    return {
      cid: allocatedCid,
      protocolVersion,
      deviceVersionMajor,
      deviceVersionMinor,
      deviceVersionBuild,
      capabilities,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience: send a CTAP2 CBOR command and receive the response
// ---------------------------------------------------------------------------

/**
 * Sends a CTAP2 CBOR command and receives the response.
 *
 * @param device       - An open node-hid HID device.
 * @param cid          - The allocated channel ID.
 * @param ctap2CmdByte - The CTAP2 command byte (e.g. 0x04 for getInfo).
 * @param cborPayload  - The CBOR-encoded command parameters (may be empty).
 * @returns The raw CTAP2 response: first byte is the status code, remainder is the CBOR body.
 */
export async function ctap2Exchange(
  device: HID.HID,
  cid: number,
  ctap2CmdByte: number,
  cborPayload: Buffer = Buffer.alloc(0),
): Promise<{ status: number; body: Buffer }> {
  // Prepend the CTAP2 command byte to the CBOR payload
  const request = Buffer.concat([Buffer.from([ctap2CmdByte]), cborPayload]);
  sendCtaphidMessage(device, cid, CTAPHID_CMD.CBOR, request);

  const msg = await receiveCtaphidMessage(device, cid);

  // CTAPHID_ERROR responses carry a 1-byte CTAPHID error code
  if (msg.cmd === (CTAPHID_CMD.ERROR & ~CMD_BIT)) {
    const errCode = msg.data.length > 0 ? msg.data[0] : 0x7f;
    throw new Error(
      `CTAPHID_ERROR received: 0x${errCode.toString(16).padStart(2, "0")}`,
    );
  }

  if (msg.data.length === 0) {
    throw new Error("CTAP2 response is empty");
  }

  const status = msg.data[0];
  const body = msg.data.slice(1);
  return { status, body };
}
