---
inclusion: auto
---

# Security Rules

These four rules are non-negotiable for every file in `src/`. Kiro enforces them on every code change.

---

## Rule 1 — No secret bytes to disk

`PRF_Output`, `Wallet_Seed`, and private key bytes **must never be written to any file, database, or persistent store**.

Only non-secret credential metadata may be persisted. The canonical schema (from `src/main/storage/CredentialStore.ts`) is:

```json
{
  "version": 1,
  "credentials": [
    {
      "credentialId": "a3f1...",   // hex — public identifier only
      "rpId": "key-wallet.local",
      "displayName": "YubiKey 5C",
      "createdAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

**✅ Correct — persist only metadata**

```typescript
// src/main/storage/CredentialStore.ts
async save(meta: StoredCredentialMetadata): Promise<void> {
  const storage = await this.read();
  storage.credentials.push(meta);          // credentialId is hex, no secret bytes
  await this.write(storage);               // writes credentials.json — safe
}
```

**❌ Incorrect — writing secret bytes to disk**

```typescript
// NEVER do this
await writeFile("wallet.bin", walletSeed);           // Wallet_Seed to disk
await writeFile("prf.dat", prfOutput);               // PRF_Output to disk
await writeFile("key.bin", keypair.secretKey);        // private key to disk
localStorage.setItem("seed", walletSeed.toString()); // renderer storage — also banned
```

---

## Rule 2 — No logging of secret material

`PRF_Output`, `Wallet_Seed`, and keypair secret keys **must never appear in any log call**: `console.log`, `console.error`, `console.debug`, `console.info`, `logger.info`, `logger.error`, or any equivalent.

Safe to log: credential IDs (hex), wallet addresses (public key, Base58), error codes, `ErrorCategory` strings, device paths.

**✅ Correct — log only public/safe data**

```typescript
// Log the wallet address (public key) — safe
console.log("Session created", {
  sessionId,
  walletAddress: keypair.publicKey.toBase58(),  // public key only
  credentialId: credentialId.toString("hex"),   // public identifier
});

// Log error categories — safe
console.error("CTAP2 error", { category: ErrorCategory.AuthenticatorError, code: err.code });
```

**❌ Incorrect — logging secret material**

```typescript
// NEVER do this
console.log("PRF output:", prfOutput);                           // secret bytes
console.log("Wallet seed:", walletSeed.toString("hex"));         // secret bytes
console.log("Keypair:", keypair.secretKey);                      // private key
logger.debug("Derivation data", { prfOutput, walletSeed });      // any logger — banned
console.error("Failed", { seed: walletSeed, prf: prfOutput });   // even in error paths
```

---

## Rule 3 — Zero-overwrite secret buffers immediately after use

Any `Buffer` or `Uint8Array` holding `PRF_Output`, `Wallet_Seed`, or private key bytes **must be overwritten with zeros as soon as they are no longer needed**, using a `finally` block so the zeroing happens even when an exception is thrown.

The canonical pattern is in `src/main/derivation/DerivationService.ts`:

**✅ Correct — zero in a `finally` block**

```typescript
// src/main/derivation/DerivationService.ts
let hmacOutput: Uint8Array | null = null;
let walletSeed: Buffer | null = null;

try {
  const result = await provider.getAssertion(devicePath, options);
  hmacOutput = result.hmacOutput;  // PRF_Output

  walletSeed = hkdf(hmacOutput, Buffer.alloc(0), Buffer.from("key-wallet:solana:ed25519:v1", "utf8"), 32);

  const keypair = Keypair.fromSeed(walletSeed);
  return { keypair, walletAddress: keypair.publicKey.toBase58() };
} finally {
  // Always runs — even if an exception was thrown above
  if (hmacOutput !== null) hmacOutput.fill(0);   // zero PRF_Output
  if (walletSeed !== null) walletSeed.fill(0);   // zero Wallet_Seed
}
```

**✅ Correct — session termination zeroes the private key**

```typescript
// src/main/session/SessionService.ts
terminateSession(sessionId: string): void {
  const session = this.sessions.get(sessionId);
  if (!session) return;
  session.keypair.secretKey.fill(0);  // zero private key bytes before GC
  this.sessions.delete(sessionId);
}
```

The minimal canonical form of the zero-in-finally rule (null guards before zeroing):

```typescript
let hmacOutput: Uint8Array | null = null;
let walletSeed: Buffer | null = null;
try {
  // ... use buffers ...
} finally {
  if (hmacOutput !== null) hmacOutput.fill(0);
  if (walletSeed !== null) walletSeed.fill(0);
}
```

The null-initialisation pattern ensures that the `finally` block never attempts to call `.fill()` on a variable that was never assigned — important when the error is thrown before any buffer is allocated.

**❌ Incorrect — letting secret buffers fall out of scope without zeroing**

```typescript
// NEVER do this
async function deriveWallet(...) {
  const prfOutput = await provider.getAssertion(...);
  const walletSeed = hkdf(prfOutput, ...);
  const keypair = Keypair.fromSeed(walletSeed);
  return keypair;
  // prfOutput and walletSeed are NOT zeroed — they linger in the heap
}

// Also incorrect — zeroing only on the happy path
try {
  ...
  prfOutput.fill(0);  // skipped if an exception is thrown above
} catch (e) {
  throw e;            // prfOutput still in memory
}
```

### Accepted limitation — stdout pipe buffer

The base64-encoded PRF_Output travels through the `fido2-assert.exe` stdout pipe. This pipe buffer is a Node.js-managed heap allocation that cannot be zeroed after reading. The intermediate `Buffer` used to decode the base64 value is zeroed immediately after copying into the returned `Uint8Array`, but the underlying pipe accumulation buffer is not. This is an accepted limitation of the CLI-subprocess architecture.

---

## Rule 4 — Use platform CSPRNG only

All random byte generation **must use the platform CSPRNG**: `randomBytes` from `node:crypto` in the main process, or `crypto.getRandomValues()` in browser/renderer contexts.

`Math.random()`, custom PRNGs, seeded generators, and any other non-CSPRNG source are banned for credential `userId` generation, session IDs, nonces, and any other security-relevant value.

**✅ Correct — `node:crypto` in the main process**

```typescript
// src/main/enrollment/EnrollmentService.ts
import { randomBytes } from "node:crypto";

// Generate a 16-byte CSPRNG userId for the new credential
const userId: Buffer = randomBytes(16);

await provider.createCredential(devicePath, {
  rpId: "key-wallet.local",
  userId,
  // ...
});
```

**✅ Correct — `crypto.getRandomValues()` in renderer/preload contexts**

```typescript
// renderer or preload (no Node.js access)
const nonce = new Uint8Array(16);
crypto.getRandomValues(nonce);  // Web Crypto — CSPRNG guaranteed
```

**❌ Incorrect — `Math.random()` or seeded generators**

```typescript
// NEVER do this for any security-relevant value
const userId = Buffer.alloc(16);
for (let i = 0; i < 16; i++) {
  userId[i] = Math.floor(Math.random() * 256);  // NOT cryptographically random
}

// Also banned — seeded or custom PRNGs
import { createRng } from "some-prng-library";
const rng = createRng(seed);
const sessionId = rng.nextBytes(16);  // predictable — banned

// Also banned — Date.now() or counter-based IDs for security values
const sessionId = `session-${Date.now()}-${Math.random()}`;  // not CSPRNG
```
