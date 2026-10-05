/**
 * Minimal CBOR encoder / decoder for CTAP2 messages.
 *
 * Implements only the CBOR major types required by the CTAP2 specification:
 *   0 — unsigned integer
 *   1 — negative integer
 *   2 — byte string
 *   3 — text string
 *   4 — array
 *   5 — map
 *   6 — tagged value (decode only, tag is ignored)
 *   7 — simple / float (true, false, null, undefined)
 *
 * Reference: RFC 7049 (CBOR) and FIDO CTAP2 specification.
 *
 * Limitations (by design):
 *   - No indefinite-length encoding/decoding.
 *   - No 64-bit integer support beyond JavaScript's safe-integer range.
 *   - No float encoding (decoding float16/32/64 is supported for completeness).
 *   - Maps are represented as plain JS objects (string/number keys) on decode.
 *     Integer keys are returned as numbers; string keys as strings.
 */

// ---------------------------------------------------------------------------
// CBOR Major type constants
// ---------------------------------------------------------------------------

const MT_UINT = 0; // 0x00..0x1f
const MT_NINT = 1; // 0x20..0x3f
const MT_BSTR = 2; // 0x40..0x5f
const MT_TSTR = 3; // 0x60..0x7f
const MT_ARRAY = 4; // 0x80..0x9f
const MT_MAP = 5; // 0xa0..0xbf
const MT_TAG = 6; // 0xc0..0xdf
const MT_SIMPLE = 7; // 0xe0..0xff

// Additional info values for variable-length headers
const AI_1BYTE = 24;
const AI_2BYTE = 25;
const AI_4BYTE = 26;
const AI_8BYTE = 27;

// Simple value codes
const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;
const SIMPLE_UNDEFINED = 23;

// Float additional-info codes (inside MT_SIMPLE)
const AI_FLOAT16 = 25;
const AI_FLOAT32 = 26;
const AI_FLOAT64 = 27;

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

type _CborEncodable =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Buffer
  | _CborEncodable[]
  | Map<_CborEncodable, _CborEncodable>
  | Record<string | number, unknown>;

/**
 * Encodes a JavaScript value to a CBOR Buffer.
 *
 * Supported input types:
 *   - `null` / `undefined` → CBOR null
 *   - `boolean`            → CBOR true / false
 *   - `number`             → CBOR unsigned int, negative int, or float64
 *   - `bigint`             → CBOR unsigned / negative int (fits in 64 bits)
 *   - `string`             → CBOR text string (UTF-8)
 *   - `Uint8Array`/`Buffer`→ CBOR byte string
 *   - `Array`              → CBOR array
 *   - `Map`                → CBOR map (preserves key order)
 *   - plain `object`       → CBOR map (own enumerable keys, string/number)
 */
export function cborEncode(value: unknown): Buffer {
  const chunks: Buffer[] = [];
  encodeValue(value, chunks);
  return Buffer.concat(chunks);
}

function encodeValue(value: unknown, out: Buffer[]): void {
  if (value === null || value === undefined) {
    out.push(encodeSimple(SIMPLE_NULL));
    return;
  }
  if (typeof value === "boolean") {
    out.push(encodeSimple(value ? SIMPLE_TRUE : SIMPLE_FALSE));
    return;
  }
  if (typeof value === "number") {
    encodeNumber(value, out);
    return;
  }
  if (typeof value === "bigint") {
    encodeBigInt(value, out);
    return;
  }
  if (typeof value === "string") {
    encodeText(value, out);
    return;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    encodeBytes(value, out);
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(value, out);
    return;
  }
  if (value instanceof Map) {
    encodeMap(value, out);
    return;
  }
  if (typeof value === "object") {
    encodeObject(value as Record<string, unknown>, out);
    return;
  }
  throw new TypeError(`cborEncode: unsupported type "${typeof value}"`);
}

// --- Header helper ---

function encodeHeader(majorType: number, arg: number | bigint): Buffer {
  const mt = majorType << 5;
  if (typeof arg === "bigint") {
    if (arg <= 23n) {
      return Buffer.from([mt | Number(arg)]);
    }
    if (arg <= 0xffn) {
      const b = Buffer.allocUnsafe(2);
      b[0] = mt | AI_1BYTE;
      b[1] = Number(arg);
      return b;
    }
    if (arg <= 0xffffn) {
      const b = Buffer.allocUnsafe(3);
      b[0] = mt | AI_2BYTE;
      b.writeUInt16BE(Number(arg), 1);
      return b;
    }
    if (arg <= 0xffffffffn) {
      const b = Buffer.allocUnsafe(5);
      b[0] = mt | AI_4BYTE;
      b.writeUInt32BE(Number(arg), 1);
      return b;
    }
    // 8-byte big-endian uint64
    const b = Buffer.allocUnsafe(9);
    b[0] = mt | AI_8BYTE;
    b.writeBigUInt64BE(arg, 1);
    return b;
  }
  // number path
  if (arg <= 23) {
    return Buffer.from([mt | arg]);
  }
  if (arg <= 0xff) {
    const b = Buffer.allocUnsafe(2);
    b[0] = mt | AI_1BYTE;
    b[1] = arg;
    return b;
  }
  if (arg <= 0xffff) {
    const b = Buffer.allocUnsafe(3);
    b[0] = mt | AI_2BYTE;
    b.writeUInt16BE(arg, 1);
    return b;
  }
  if (arg <= 0xffffffff) {
    const b = Buffer.allocUnsafe(5);
    b[0] = mt | AI_4BYTE;
    b.writeUInt32BE(arg, 1);
    return b;
  }
  // Encode as 8-byte; safe for values up to Number.MAX_SAFE_INTEGER
  const b = Buffer.allocUnsafe(9);
  b[0] = mt | AI_8BYTE;
  b.writeBigUInt64BE(BigInt(arg), 1);
  return b;
}

function encodeSimple(simpleCode: number): Buffer {
  return Buffer.from([(MT_SIMPLE << 5) | simpleCode]);
}

function encodeNumber(value: number, out: Buffer[]): void {
  if (!Number.isFinite(value)) {
    // Encode NaN / Infinity as float64
    const b = Buffer.allocUnsafe(9);
    b[0] = (MT_SIMPLE << 5) | AI_FLOAT64;
    b.writeDoubleBE(value, 1);
    out.push(b);
    return;
  }
  if (Number.isInteger(value)) {
    if (value >= 0) {
      out.push(encodeHeader(MT_UINT, value));
    } else {
      out.push(encodeHeader(MT_NINT, -1 - value));
    }
    return;
  }
  // Float64
  const b = Buffer.allocUnsafe(9);
  b[0] = (MT_SIMPLE << 5) | AI_FLOAT64;
  b.writeDoubleBE(value, 1);
  out.push(b);
}

function encodeBigInt(value: bigint, out: Buffer[]): void {
  if (value >= 0n) {
    out.push(encodeHeader(MT_UINT, value));
  } else {
    out.push(encodeHeader(MT_NINT, -1n - value));
  }
}

function encodeText(value: string, out: Buffer[]): void {
  const strBuf = Buffer.from(value, "utf8");
  out.push(encodeHeader(MT_TSTR, strBuf.length));
  out.push(strBuf);
}

function encodeBytes(value: Uint8Array | Buffer, out: Buffer[]): void {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  out.push(encodeHeader(MT_BSTR, buf.length));
  out.push(buf);
}

function encodeArray(value: unknown[], out: Buffer[]): void {
  out.push(encodeHeader(MT_ARRAY, value.length));
  for (const item of value) {
    encodeValue(item, out);
  }
}

function encodeMap(
  value: Map<unknown, unknown>,
  out: Buffer[],
): void {
  out.push(encodeHeader(MT_MAP, value.size));
  for (const [k, v] of value.entries()) {
    encodeValue(k, out);
    encodeValue(v, out);
  }
}

function encodeObject(
  value: Record<string | number, unknown>,
  out: Buffer[],
): void {
  const keys = Object.keys(value);
  out.push(encodeHeader(MT_MAP, keys.length));
  for (const key of keys) {
    // Numeric string keys → encode as integer for CTAP2 compatibility
    const numKey = Number(key);
    if (!isNaN(numKey) && String(numKey) === key) {
      encodeNumber(numKey, out);
    } else {
      encodeText(key, out);
    }
    encodeValue(value[key], out);
  }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

interface DecodeState {
  buf: Buffer;
  pos: number;
}

/**
 * Decodes a CBOR-encoded Buffer into a JavaScript value.
 *
 * Map keys are returned as numbers (when the CBOR key is an integer) or
 * strings.  This matches the CTAP2 response structure where top-level map
 * keys are always small positive integers.
 */
export function cborDecode(data: Buffer): unknown {
  const state: DecodeState = { buf: data, pos: 0 };
  const value = decodeValue(state);
  return value;
}

function readByte(state: DecodeState): number {
  if (state.pos >= state.buf.length) {
    throw new RangeError("CBOR decode: unexpected end of data");
  }
  return state.buf[state.pos++];
}

function readBytes(state: DecodeState, n: number): Buffer {
  if (state.pos + n > state.buf.length) {
    throw new RangeError(
      `CBOR decode: need ${n} bytes but only ${state.buf.length - state.pos} remain`,
    );
  }
  const slice = state.buf.slice(state.pos, state.pos + n);
  state.pos += n;
  return slice;
}

function decodeArgument(
  state: DecodeState,
  additionalInfo: number,
): number {
  if (additionalInfo < 24) return additionalInfo;
  if (additionalInfo === AI_1BYTE) return readByte(state);
  if (additionalInfo === AI_2BYTE) {
    const b = readBytes(state, 2);
    return b.readUInt16BE(0);
  }
  if (additionalInfo === AI_4BYTE) {
    const b = readBytes(state, 4);
    return b.readUInt32BE(0);
  }
  if (additionalInfo === AI_8BYTE) {
    const b = readBytes(state, 8);
    // Return as number; precision loss possible for large uint64 values
    const hi = b.readUInt32BE(0);
    const lo = b.readUInt32BE(4);
    return hi * 0x1_0000_0000 + lo;
  }
  throw new Error(
    `CBOR decode: unsupported additional info ${additionalInfo}`,
  );
}

function decodeValue(state: DecodeState): unknown {
  const initialByte = readByte(state);
  const majorType = (initialByte >> 5) & 0x07;
  const additionalInfo = initialByte & 0x1f;

  switch (majorType) {
    case MT_UINT: {
      return decodeArgument(state, additionalInfo);
    }
    case MT_NINT: {
      const n = decodeArgument(state, additionalInfo);
      return -1 - n;
    }
    case MT_BSTR: {
      const len = decodeArgument(state, additionalInfo);
      return readBytes(state, len);
    }
    case MT_TSTR: {
      const len = decodeArgument(state, additionalInfo);
      const strBuf = readBytes(state, len);
      return strBuf.toString("utf8");
    }
    case MT_ARRAY: {
      const count = decodeArgument(state, additionalInfo);
      const arr: unknown[] = new Array(count);
      for (let i = 0; i < count; i++) {
        arr[i] = decodeValue(state);
      }
      return arr;
    }
    case MT_MAP: {
      const count = decodeArgument(state, additionalInfo);
      // Use a Map to preserve integer keys (important for CTAP2 responses)
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < count; i++) {
        const key = decodeValue(state);
        const val = decodeValue(state);
        map.set(key, val);
      }
      return map;
    }
    case MT_TAG: {
      // Decode tag number (ignored) then decode the tagged value
      decodeArgument(state, additionalInfo);
      return decodeValue(state);
    }
    case MT_SIMPLE: {
      if (additionalInfo === SIMPLE_FALSE) return false;
      if (additionalInfo === SIMPLE_TRUE) return true;
      if (additionalInfo === SIMPLE_NULL) return null;
      if (additionalInfo === SIMPLE_UNDEFINED) return undefined;
      if (additionalInfo === AI_1BYTE) {
        // Simple value in next byte (rarely used)
        readByte(state);
        return undefined;
      }
      if (additionalInfo === AI_FLOAT16) {
        // Float16 — decode as float32 approximation
        const b = readBytes(state, 2);
        return decodeFloat16(b.readUInt16BE(0));
      }
      if (additionalInfo === AI_FLOAT32) {
        const b = readBytes(state, 4);
        return b.readFloatBE(0);
      }
      if (additionalInfo === AI_FLOAT64) {
        const b = readBytes(state, 8);
        return b.readDoubleBE(0);
      }
      throw new Error(
        `CBOR decode: unsupported simple value additionalInfo=${additionalInfo}`,
      );
    }
    default:
      throw new Error(`CBOR decode: unknown major type ${majorType}`);
  }
}

/**
 * Decodes a half-precision IEEE 754 float16 to a JavaScript number.
 * Reference: RFC 7049 Appendix D.
 */
function decodeFloat16(u16: number): number {
  const exp = (u16 >> 10) & 0x1f;
  const mant = u16 & 0x3ff;
  const sign = u16 & 0x8000 ? -1 : 1;
  if (exp === 0) {
    return sign * Math.pow(2, -14) * (mant / 0x400);
  }
  if (exp === 31) {
    return mant === 0 ? sign * Infinity : NaN;
  }
  return sign * Math.pow(2, exp - 15) * (1 + mant / 0x400);
}

// ---------------------------------------------------------------------------
// Convenience: decode a CTAP2 response map (integer keys → values)
// ---------------------------------------------------------------------------

/**
 * Decodes a CTAP2 CBOR response body into a `Map<number, unknown>`.
 * CTAP2 response maps always use small non-negative integer keys.
 *
 * @throws if the decoded value is not a CBOR map.
 */
export function decodeCbor2Map(data: Buffer): Map<number, unknown> {
  const decoded = cborDecode(data);
  if (!(decoded instanceof Map)) {
    throw new Error(
      `CTAP2 CBOR response is not a map (got ${typeof decoded})`,
    );
  }
  // Normalise keys to numbers (they should already be, but be defensive)
  const result = new Map<number, unknown>();
  for (const [k, v] of decoded.entries()) {
    result.set(Number(k), v);
  }
  return result;
}
