import { hkdfSync } from "node:crypto";

/**
 * Wraps Node's hkdfSync for HKDF-SHA256 key derivation.
 *
 * @param ikm    Input keying material
 * @param salt   Optional salt value (use Buffer.alloc(0) for empty)
 * @param info   Context / application-specific info string
 * @param length Desired output length in bytes
 * @returns      Derived key as a Buffer
 */
export function hkdf(
  ikm: Buffer | Uint8Array,
  salt: Buffer | Uint8Array,
  info: Buffer | Uint8Array,
  length: number
): Buffer {
  const result = hkdfSync("sha256", ikm, salt, info, length);
  return Buffer.from(result);
}

/**
 * PRF_Salt constant – Req 4.2
 *
 * Computed once at module load time via HKDF-SHA256:
 *   IKM  = UTF-8("key-wallet-prf-salt-v1")
 *   salt = <empty>
 *   info = UTF-8("solana-wallet-derivation")
 *   length = 32
 *
 * Exposed as Readonly<Uint8Array> to prevent accidental mutation at the
 * TypeScript level.  Object.freeze on typed arrays is disallowed by the
 * JS engine, so immutability is enforced through the type system instead.
 */
export const PRF_SALT_CONSTANT: Readonly<Uint8Array> = new Uint8Array(
  hkdfSync(
    "sha256",
    Buffer.from("key-wallet-prf-salt-v1", "utf8"),
    Buffer.alloc(0),
    Buffer.from("solana-wallet-derivation", "utf8"),
    32
  )
);
