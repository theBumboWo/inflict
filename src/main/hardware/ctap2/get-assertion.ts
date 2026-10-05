/**
 * CTAP2 authenticatorGetAssertion with hmac-secret extension.
 *
 * This is the critical path for wallet derivation:
 *   The hmac-secret output IS the PRF_Output → used as HKDF input material.
 *
 * PIN Protocol 1 is used to encrypt the hmac-secret salt before sending.
 *
 * References:
 *   - FIDO2 CTAP2 spec §6.1 authenticatorGetAssertion
 *   - FIDO2 CTAP2 spec §6.5.5 authenticatorClientPIN
 *   - FIDO2 CTAP2 spec, Extension: hmac-secret
 *   - PIN Protocol 1: AES-256-CBC + HMAC-SHA256
 *
 * Requirements: Req 4.1, Req 23.2, Req 23.4
 */

import HID from "node-hid";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  createHash,
  createPublicKey,
  randomBytes,
  diffieHellman,
  KeyObject,
} from "node:crypto";
import { ctap2Exchange } from "./hid-transport";
import { cborEncode, decodeCbor2Map } from "./cbor";
import { CTAP2_CMD, CTAP2_STATUS } from "./types";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface GetAssertionParams {
  rpId: string;
  credentialId: Uint8Array;
  /** 32-byte PRF_Salt */
  hmacSalt: Uint8Array;
  userVerification: "required";
  /** Optional PIN string — required when userVerification is "required" */
  pin?: string;
}

export interface GetAssertionResult {
  /** 32-byte decrypted hmac-secret output (= PRF_Output) */
  hmacOutput: Uint8Array;
  credentialId: Uint8Array;
}

// ---------------------------------------------------------------------------
// CTAP2 authenticatorClientPIN command codes
// ---------------------------------------------------------------------------

/** authenticatorClientPIN command byte */
const CTAP2_CLIENT_PIN_CMD = 0x06;

/** authenticatorClientPIN subcommands */
const PIN_SUBCOMMAND = {
  GET_KEY_AGREEMENT: 0x02,
  GET_PIN_TOKEN: 0x05,
} as const;

// ---------------------------------------------------------------------------
// COSE / DER key helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a P-256 public key as a CBOR COSE_Key map (integer keys).
 *
 * COSE key format (RFC 8152):
 *   1  (kty): 2       — EC2
 *   3  (alg): -25     — ECDH-ES+HKDF-256
 *  -1  (crv): 1       — P-256
 *  -2  (x):   32-byte x coordinate
 *  -3  (y):   32-byte y coordinate
 */
function encodeCoseEcPublicKey(x: Buffer, y: Buffer): Map<number, unknown> {
  const coseKey = new Map<number, unknown>();
  coseKey.set(1, 2);   // kty: EC2
  coseKey.set(3, -25); // alg: ECDH-ES+HKDF-256
  coseKey.set(-1, 1);  // crv: P-256
  coseKey.set(-2, x);  // x coordinate
  coseKey.set(-3, y);  // y coordinate
  return coseKey;
}

/**
 * Extracts x and y coordinates from a COSE EC public key map (received from authenticator).
 */
function extractCoseKeyCoordinates(
  coseKeyMap: Map<number, unknown>,
): { x: Buffer; y: Buffer } {
  const x = coseKeyMap.get(-2);
  const y = coseKeyMap.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    throw new Error(
      "Invalid COSE public key: missing x or y coordinate (keys -2 and -3)",
    );
  }
  return { x, y };
}

/** Encodes a DER length in minimal form (supports lengths up to 65535) */
function encodeDerLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len <= 0xff) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/**
 * Constructs a Node.js KeyObject for a P-256 public key from raw x,y coordinates.
 * Builds a DER-encoded SubjectPublicKeyInfo structure.
 */
function buildEcPublicKeyFromCoords(x: Buffer, y: Buffer): ReturnType<typeof createPublicKey> {
  // Uncompressed point: 0x04 || x || y
  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), x, y]);

  // DER AlgorithmIdentifier for P-256:
  //   SEQUENCE { OID id-ecPublicKey (1.2.840.10045.2.1), OID P-256 (1.2.840.10045.3.1.7) }
  const algorithmIdentifier = Buffer.from(
    "301306072a8648ce3d020106082a8648ce3d030107",
    "hex",
  );

  // BIT STRING wrapping: 0x03 + length + 0x00 (no unused bits) + point
  const bitStringPayload = Buffer.concat([Buffer.from([0x00]), uncompressedPoint]);
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    encodeDerLength(bitStringPayload.length),
    bitStringPayload,
  ]);

  // SEQUENCE wrapping algorithmIdentifier + bitString
  const spkiContent = Buffer.concat([algorithmIdentifier, bitString]);
  const spki = Buffer.concat([
    Buffer.from([0x30]),
    encodeDerLength(spkiContent.length),
    spkiContent,
  ]);

  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/**
 * Extracts raw x,y coordinates from an EC public KeyObject via JWK export.
 */
function extractKeyCoords(publicKey: KeyObject): { x: Buffer; y: Buffer } {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("Failed to extract EC key coordinates from JWK export");
  }
  return {
    x: Buffer.from(jwk.x, "base64url"),
    y: Buffer.from(jwk.y, "base64url"),
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Performs CTAP2 authenticatorGetAssertion with the hmac-secret extension.
 *
 * This is the critical wallet-derivation path:
 *   hmacOutput (32 bytes) IS the PRF_Output → fed into HKDF to derive the Solana keypair.
 *
 * Implements PIN Protocol 1:
 *   1. getKeyAgreement → get authenticator's ECDH public key
 *   2. Generate ephemeral P-256 key pair (single key reused for PIN token + hmac-secret)
 *   3. ECDH(ephemeral_private, auth_public) → SHA-256 → sharedSecret
 *   4. getPinToken with encrypted PIN hash
 *   5. Encrypt hmac-secret salt using sharedSecret
 *   6. Send authenticatorGetAssertion with hmac-secret extension
 *   7. Decrypt hmac-secret output with sharedSecret
 *
 * SECURITY:
 *   - sharedSecret, pinToken, and all intermediate key material are zeroed after use.
 *   - The PIN is never logged, stored, or returned.
 *   - Uses node:crypto for all cryptographic operations.
 *
 * @param device  An open node-hid HID device (channel already allocated).
 * @param cid     The allocated CTAPHID channel ID.
 * @param params  Request parameters including rpId, credentialId, hmacSalt, and PIN.
 * @returns The 32-byte hmacOutput (PRF_Output) and the responding credentialId.
 *
 * Requirements: Req 4.1, Req 23.2, Req 23.4
 */
export async function getAssertion(
  device: HID.HID,
  cid: number,
  params: GetAssertionParams,
): Promise<GetAssertionResult> {
  const { rpId, credentialId, hmacSalt, pin } = params;

  // PIN is required for userVerification: "required"
  if (!pin || pin.length === 0) {
    throw new Error(
      'PIN is required for userVerification: "required". Please provide a PIN.',
    );
  }

  if (hmacSalt.length !== 32) {
    throw new Error(`hmacSalt must be 32 bytes, got ${hmacSalt.length}`);
  }

  // ─── Step 1: getKeyAgreement — fetch authenticator's ECDH public key ─────
  const getKeyAgreementRequest = new Map<number, unknown>();
  getKeyAgreementRequest.set(1, 1); // pinUvAuthProtocol: 1
  getKeyAgreementRequest.set(2, PIN_SUBCOMMAND.GET_KEY_AGREEMENT);

  const gaResponse = await ctap2Exchange(
    device,
    cid,
    CTAP2_CLIENT_PIN_CMD,
    cborEncode(getKeyAgreementRequest),
  );

  if (gaResponse.status !== CTAP2_STATUS.CTAP2_OK) {
    throw new Error(
      `authenticatorClientPIN getKeyAgreement failed: status 0x${gaResponse.status.toString(16)}`,
    );
  }

  const gaMap = decodeCbor2Map(gaResponse.body);
  // Response key 1 = keyAgreement (COSE_Key map)
  const authKeyAgreement = gaMap.get(1);
  if (!(authKeyAgreement instanceof Map)) {
    throw new Error(
      "getKeyAgreement response missing keyAgreement (key 1) or it is not a map",
    );
  }
  const authPubCoords = extractCoseKeyCoordinates(
    authKeyAgreement as Map<number, unknown>,
  );

  // ─── Step 2: Generate ephemeral P-256 key pair ────────────────────────────
  // This SINGLE ephemeral key is reused for both getPinToken and hmac-secret,
  // so the authenticator can verify saltAuth with the same sharedSecret.
  const { privateKey: ephemeralPrivate, publicKey: ephemeralPublic } =
    generateKeyPairSync("ec", { namedCurve: "P-256" });

  const ephemeralCoords = extractKeyCoords(ephemeralPublic);
  const ephemeralCoseKey = encodeCoseEcPublicKey(
    ephemeralCoords.x,
    ephemeralCoords.y,
  );

  // ─── Step 3: Compute sharedSecret = SHA-256(ECDH(ephemeral_priv, auth_pub)) ──
  const authPublicKeyObj = buildEcPublicKeyFromCoords(
    authPubCoords.x,
    authPubCoords.y,
  );

  const ecdhRawSecret = diffieHellman({
    privateKey: ephemeralPrivate,
    publicKey: authPublicKeyObj,
  });
  const sharedSecret = createHash("sha256").update(ecdhRawSecret).digest();
  // Zero the raw ECDH output immediately after use
  ecdhRawSecret.fill(0);

  // All remaining operations use sharedSecret; zero it in the finally block.
  try {
    const zeroIv = Buffer.alloc(16, 0);

    // ─── Step 4: getPinToken ─────────────────────────────────────────────────
    // pinHashEnc = AES-256-CBC(key=sharedSecret, iv=zeros, data=SHA-256(PIN)[0:16] + 16_zero_bytes)
    // Per CTAP2 spec: the platform sends AES256CBC(sharedSecret, SHA-256(PIN)[0:16])
    // The input must be padded to a full AES block; we zero-pad to 32 bytes,
    // then disable PKCS#7 padding to get exactly 32 bytes of output.
    const pinHash = createHash("sha256").update(Buffer.from(pin, "utf8")).digest();
    const pinHashFirst16 = pinHash.slice(0, 16);
    pinHash.fill(0);

    const pinHashPadded = Buffer.concat([pinHashFirst16, Buffer.alloc(16, 0)]);
    const pinHashCipher = createCipheriv("aes-256-cbc", sharedSecret, zeroIv);
    pinHashCipher.setAutoPadding(false);
    const pinHashEnc = Buffer.concat([
      pinHashCipher.update(pinHashPadded),
      pinHashCipher.final(),
    ]);
    pinHashFirst16.fill(0);
    pinHashPadded.fill(0);

    const getPinTokenRequest = new Map<number, unknown>();
    getPinTokenRequest.set(1, 1); // pinUvAuthProtocol: 1
    getPinTokenRequest.set(2, PIN_SUBCOMMAND.GET_PIN_TOKEN); // subCommand: 0x05
    getPinTokenRequest.set(3, ephemeralCoseKey); // keyAgreement (ephemeral pub key)
    getPinTokenRequest.set(6, pinHashEnc); // pinHashEnc

    const ptResponse = await ctap2Exchange(
      device,
      cid,
      CTAP2_CLIENT_PIN_CMD,
      cborEncode(getPinTokenRequest),
    );

    if (ptResponse.status !== CTAP2_STATUS.CTAP2_OK) {
      throw new Error(
        `authenticatorClientPIN getPinToken failed: status 0x${ptResponse.status.toString(16)}`,
      );
    }

    const ptMap = decodeCbor2Map(ptResponse.body);
    // Response key 2 = pinUvAuthToken (AES-encrypted PIN token)
    const pinTokenEnc = ptMap.get(2);
    if (!Buffer.isBuffer(pinTokenEnc)) {
      throw new Error(
        "getPinToken response missing pinUvAuthToken (key 2)",
      );
    }

    // Decrypt pinToken = AES-256-CBC(key=sharedSecret, iv=zeros, data=pinTokenEnc)
    const pinTokenDecipher = createDecipheriv("aes-256-cbc", sharedSecret, zeroIv);
    pinTokenDecipher.setAutoPadding(false);
    const pinToken = Buffer.concat([
      pinTokenDecipher.update(pinTokenEnc),
      pinTokenDecipher.final(),
    ]);

    try {
      // ─── Step 5: Encrypt HMAC salt ─────────────────────────────────────────
      // iv = first 16 bytes of sharedSecret (PIN Protocol 1 spec for hmac-secret)
      const saltIv = sharedSecret.slice(0, 16);
      const salt32 = Buffer.from(hmacSalt);

      // saltEnc = AES-256-CBC(key=sharedSecret, iv=saltIv, data=salt32)
      // With default PKCS#7 padding: 32-byte input → 48 bytes output
      const saltCipher = createCipheriv("aes-256-cbc", sharedSecret, saltIv);
      const saltEnc = Buffer.concat([saltCipher.update(salt32), saltCipher.final()]);
      salt32.fill(0);

      // saltAuth = first 16 bytes of HMAC-SHA256(pinToken, saltEnc)
      const saltAuth = createHmac("sha256", pinToken)
        .update(saltEnc)
        .digest()
        .slice(0, 16);

      // ─── Step 6: Build assertion clientDataHash ─────────────────────────────
      // A minimal webauthn.get clientData JSON (random challenge per invocation)
      const clientData = JSON.stringify({
        type: "webauthn.get",
        challenge: randomBytes(32).toString("base64url"),
        origin: `ctap2://${rpId}`,
      });
      const clientDataHash = createHash("sha256")
        .update(Buffer.from(clientData, "utf8"))
        .digest();

      // ─── Step 7: Build CBOR GetAssertion request ─────────────────────────────
      // hmac-secret extension inner map (integer keys per CTAP2 hmac-secret spec):
      //   0x01 = keyAgreement (COSE public key — same ephemeral key as getPinToken)
      //   0x02 = saltEnc (AES-encrypted salt, 48 bytes)
      //   0x03 = saltAuth (HMAC-SHA256(pinToken, saltEnc)[0:16])
      const hmacSecretExtMap = new Map<number, unknown>();
      hmacSecretExtMap.set(0x01, ephemeralCoseKey);
      hmacSecretExtMap.set(0x02, saltEnc);
      hmacSecretExtMap.set(0x03, saltAuth);

      // Top-level extensions map: { "hmac-secret": hmacSecretExtMap }
      const extensions = new Map<string, unknown>();
      extensions.set("hmac-secret", hmacSecretExtMap);

      // allowList entry: [{ type: "public-key", id: credentialId }]
      const allowListEntry = new Map<string, unknown>();
      allowListEntry.set("type", "public-key");
      allowListEntry.set("id", Buffer.from(credentialId));

      // options map: { uv: true }
      const options = new Map<string, unknown>();
      options.set("uv", true);

      // authenticatorGetAssertion CBOR request (integer keys):
      //   1 = rpId (string)
      //   2 = clientDataHash (32-byte SHA-256)
      //   3 = allowList (array of PublicKeyCredentialDescriptor)
      //   4 = extensions
      //   5 = options
      const assertionRequest = new Map<number, unknown>();
      assertionRequest.set(1, rpId);
      assertionRequest.set(2, clientDataHash);
      assertionRequest.set(3, [allowListEntry]);
      assertionRequest.set(4, extensions);
      assertionRequest.set(5, options);

      // ─── Step 8: Send authenticatorGetAssertion (CTAP2 command 0x02) ────────
      const assertionResponse = await ctap2Exchange(
        device,
        cid,
        CTAP2_CMD.GET_ASSERTION,
        cborEncode(assertionRequest),
      );

      if (assertionResponse.status !== CTAP2_STATUS.CTAP2_OK) {
        throw new Error(
          `authenticatorGetAssertion failed: status 0x${assertionResponse.status.toString(16)}`,
        );
      }

      // ─── Step 9: Parse assertion response ────────────────────────────────────
      const assertionMap = decodeCbor2Map(assertionResponse.body);

      // Key 1: credential { type: string, id: Buffer }
      let responseCredentialId: Uint8Array = credentialId;
      const responseCredential = assertionMap.get(1);
      if (responseCredential instanceof Map) {
        const credId = (responseCredential as Map<unknown, unknown>).get("id");
        if (Buffer.isBuffer(credId)) {
          responseCredentialId = new Uint8Array(credId);
        }
      }

      // Key 4: extensionResults map { "hmac-secret": encrypted_output }
      const extensionResults = assertionMap.get(4);
      if (!(extensionResults instanceof Map)) {
        throw new Error(
          "authenticatorGetAssertion response missing extensionResults (key 4)",
        );
      }

      const hmacSecretEncOutput = (extensionResults as Map<unknown, unknown>).get("hmac-secret");
      if (!Buffer.isBuffer(hmacSecretEncOutput)) {
        throw new Error(
          "authenticatorGetAssertion response missing hmac-secret extension output",
        );
      }

      if (hmacSecretEncOutput.length < 32) {
        throw new Error(
          `hmac-secret encrypted output too short: expected ≥32 bytes, got ${hmacSecretEncOutput.length}`,
        );
      }

      // ─── Step 10: Decrypt hmac-secret output ─────────────────────────────────
      // outputDecrypted = AES-256-CBC(key=sharedSecret, iv=sharedSecret[0:16], data=hmacSecretEncOutput[0:32])
      const outputIv = sharedSecret.slice(0, 16);
      const outputDecipher = createDecipheriv(
        "aes-256-cbc",
        sharedSecret,
        outputIv,
      );
      outputDecipher.setAutoPadding(false);
      const decryptedOutput = Buffer.concat([
        outputDecipher.update(hmacSecretEncOutput.slice(0, 32)),
        outputDecipher.final(),
      ]);

      if (decryptedOutput.length < 32) {
        decryptedOutput.fill(0);
        throw new Error(
          `Decrypted hmac-secret output is too short: ${decryptedOutput.length} bytes`,
        );
      }

      // Extract the 32-byte PRF_Output
      const hmacOutput = new Uint8Array(decryptedOutput.slice(0, 32));
      // Zero the decrypted buffer (only the Uint8Array view is returned)
      decryptedOutput.fill(0);

      return {
        hmacOutput,
        credentialId: responseCredentialId,
      };
    } finally {
      // Always zero the PIN token
      pinToken.fill(0);
    }
  } finally {
    // Always zero the shared secret — regardless of success or failure
    sharedSecret.fill(0);
  }
}
