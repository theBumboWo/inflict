# Security Audit: Secret Material Handling

**Date:** 2025  
**Scope:** All locations in `src/main/` where `PRF_Output` (`hmacOutput`), `Wallet_Seed` (`walletSeed`), or `keypair.secretKey` is created, read, transformed, or zeroed.  
**Requirements:** 22.1, 22.2, 22.3, 22.4

---

## Section 1: Secret Material Locations

The table below records every site in `src/main/` where a secret buffer is created, transformed, zeroed, or returned. Column definitions:

- **Secret** — `PRF_Output` = the 32-byte hmac-secret output from the authenticator; `Wallet_Seed` = the 32-byte HKDF output; `secretKey` = the 64-byte Ed25519 private key held in the active session keypair.
- **Zeroed in `finally`** — whether the buffer is zero-filled inside a `finally` block that runs on both normal exit and exception.
- **Passed over IPC** — whether the buffer is ever forwarded to the renderer process via `ipcMain` / `webContents.send`.
- **Written to log** — whether the buffer bytes appear in any `console.*` call.

### 1.1 `src/main/derivation/DerivationService.ts`

| # | Line range | Secret | Operation | Zeroed in `finally` | Passed over IPC | Written to log |
|---|-----------|--------|-----------|---------------------|-----------------|----------------|
| 1 | 54–57 | `PRF_Output` (`hmacOutput`) | Declared `null`; assigned from `assertionResult.hmacOutput` at line ~97 | **Yes** — `hmacOutput.fill(0)` at line ~116 inside `finally` | No | No |
| 2 | 55–57 | `Wallet_Seed` (`walletSeed`) | Declared `null`; assigned from `hkdf(hmacOutput, …)` at lines ~100–106 | **Yes** — `walletSeed.fill(0)` at line ~119 inside `finally` | No | No |
| 3 | ~108–109 | `Wallet_Seed` → `Keypair` | `Keypair.fromSeed(walletSeed)` copies the seed bytes into the nacl keypair; `walletSeed` is zeroed in `finally` after this call | **Yes** (walletSeed zeroed; keypair handled by SessionService) | No | No |
| 4 | ~140 | `PRF_Output` copy (`hmacOutput`) | `new Uint8Array(prfOutput)` — a mutable copy created in `deriveFromPrfOutput()` | **Yes** — `hmacOutput.fill(0)` at line ~157 inside `finally` | No | No |
| 5 | ~144–150 | `Wallet_Seed` (`walletSeed`) | Assigned from `hkdf(hmacOutput, …)` inside `deriveFromPrfOutput()` | **Yes** — `walletSeed.fill(0)` at line ~159 inside `finally` | No | No |

**Note:** The `Keypair` object constructed at step 3 is returned to the caller (`index.ts`) and stored in `SessionService`. Its private key bytes are zeroed separately by `SessionService.terminateSession()` — see Section 1.3.

---

### 1.2 `src/main/hardware/Fido2CliHardwareIdentityProvider.ts`

| # | Line range | Secret | Operation | Zeroed in `finally` | Passed over IPC | Written to log |
|---|-----------|--------|-----------|---------------------|-----------------|----------------|
| 6 | ~604 | `PRF_Output` intermediate (`hmacBuf`) | `Buffer.from(hmacB64, "base64")` — decodes the base64 HMAC output from `fido2-assert` stdout into a temporary `Buffer` | **Yes (best-effort)** — `hmacBuf.fill(0)` at line ~616 immediately after `hmacOutput.set(hmacBuf)`. On the error path (wrong length), `hmacBuf.fill(0)` at line ~605 before throwing. Not in a `finally` block; but both exit paths (success and error) zero the buffer. | No | No |
| 7 | ~613–615 | `PRF_Output` (`hmacOutput`) | `new Uint8Array(32)` filled from `hmacBuf` — this is the canonical `PRF_Output` returned to `DerivationService` | No (zeroed upstream by `DerivationService` — see rows 1 and 4) | No | No |

**Accepted limitation:** The base64-encoded secret travels through the child process's stdout pipe (a Node.js `Buffer` accumulated in `spawnCli`). That pipe buffer is not under direct control and cannot be zeroed after reading. This is documented in the class-level JSDoc as an accepted limitation of the CLI-subprocess approach.

---

### 1.3 `src/main/session/SessionService.ts`

| # | Line range | Secret | Operation | Zeroed in `finally` | Passed over IPC | Written to log |
|---|-----------|--------|-----------|---------------------|-----------------|----------------|
| 8 | 16–22 | `keypair.secretKey` (internal buffer) | `zeroKeypairSecret()` accesses `keypair._keypair.secretKey` (the nacl internal buffer, not the public getter copy) and calls `.fill(0)` | N/A — this function *is* the zeroing operation | No | No |
| 9 | 132 | `keypair.secretKey` | `zeroKeypairSecret(this.activeSession.keypair)` called inside `terminateSession()` before clearing the session reference — runs unconditionally on every termination path | N/A (synchronous, no `try/finally` needed) | No | No |

**Note on `keypair.secretKey` getter:** The public `Keypair.secretKey` getter in `@solana/web3.js` returns a fresh copy of the underlying bytes on every call. `SessionService` zeroes the *internal* nacl buffer at `(keypair as any)._keypair.secretKey` directly, which is the canonical storage location. This ensures the actual key material in memory is overwritten, not merely a transient copy.

---

### 1.4 `src/main/hardware/ctap2/get-assertion.ts`

This file implements the low-level CTAP2 GetAssertion with PIN Protocol 1 used by `NodeHidHardwareIdentityProvider`. It handles several derived secrets during the PIN authentication and hmac-secret decryption flow.

| # | Line range | Secret | Operation | Zeroed in `finally` | Passed over IPC | Written to log |
|---|-----------|--------|-----------|---------------------|-----------------|----------------|
| 10 | ~264–265 | ECDH raw secret (`ecdhRawSecret`) | `diffieHellman(…)` result used to derive `sharedSecret` via SHA-256 | No `finally` — zeroed immediately on the next line after use (`ecdhRawSecret.fill(0)`) | No | No |
| 11 | ~277–288 | PIN hash intermediate buffers (`pinHash`, `pinHashFirst16`, `pinHashPadded`) | Derived from user PIN to construct `pinHashEnc` for `getPinToken` request | `pinHash.fill(0)` at ~278; `pinHashFirst16.fill(0)` at ~287; `pinHashPadded.fill(0)` at ~288 — immediately after use | No | No |
| 12 | ~335–336 | Salt buffer (`salt32`) | 32-byte AES-encrypted hmac salt; zeroed after `saltEnc` is computed | `salt32.fill(0)` at ~336 immediately after use | No | No |
| 13 | ~454 | Decrypted hmac-secret output (`decryptedOutput`) | AES-decrypted authenticator response containing `PRF_Output` | `decryptedOutput.fill(0)` at ~463 after copying first 32 bytes to `hmacOutput` | No | No |
| 14 | ~461–466 | `PRF_Output` (`hmacOutput`) | `new Uint8Array(decryptedOutput.slice(0, 32))` — canonical `PRF_Output` returned to caller | No (zeroed upstream by `DerivationService`) | No | No |
| 15 | ~471 | PIN token (`pinToken`) | 32-byte token received from authenticator for session authorization | **Yes** — `pinToken.fill(0)` in inner `finally` block at ~471 | No | No |
| 16 | ~475 | `sharedSecret` | SHA-256 of ECDH output; used to encrypt/decrypt PIN material and salt | **Yes** — `sharedSecret.fill(0)` in outer `finally` block at ~475 | No | No |

---

### 1.5 `src/main/enrollment/EnrollmentService.ts`

| # | Line range | Secret | Operation | Zeroed in `finally` | Passed over IPC | Written to log |
|---|-----------|--------|-----------|---------------------|-----------------|----------------|
| 17 | ~143–144 | `userId` (enrollment only) | 16-byte random user ID generated for CTAP2 enrollment. Not a wallet secret, but zeroed as hygiene per the code comment. | **Yes** — `userId.fill(0)` in `finally` at ~144 | No | No |

**Note:** `EnrollmentService` stores only `credentialId` (hex), `displayName`, `rpId`, and `createdAt` in `CredentialStore`. No `PRF_Output`, `Wallet_Seed`, or private key bytes are written to disk.

---

### 1.6 `src/main/transaction/TransactionService.ts`

| # | Line range | Secret | Operation | Zeroed in `finally` | Passed over IPC | Written to log |
|---|-----------|--------|-----------|---------------------|-----------------|----------------|
| 18 | ~352–353 | Serialized transaction bytes (`pendingRetry.serialized`) | Signed transaction bytes held for retry; not a raw keypair secret but contains signed data | `serialized.fill(0)` at ~353 when the pending retry is cleared | No | No |

---

## Section 2: Log Statement Audit

**Confirmed: No log statement in `src/main/` contains secret bytes.**

All `console.log`, `console.warn`, and `console.error` calls in `src/main/` were reviewed. The complete list of what each logs is as follows:

| File | Statement | Content logged |
|------|-----------|----------------|
| `src/main/index.ts` (~92) | `console.log` | `"[hardware] node-hid loaded successfully (dev/prod)"` — environment string only |
| `src/main/index.ts` (~98) | `console.error` | `"[hardware] Failed to load node-hid (env):", e` — error object only, no secret bytes |
| `src/main/index.ts` (~125) | `console.log` | `"[hardware] Added libfido2 DLL directory to PATH: <dllDir>"` — filesystem path only |
| `src/main/index.ts` (~142) | `console.log` | `"[hardware] using mock provider"` — string constant only |
| `src/main/index.ts` (~144) | `console.log` | `"[hardware] using real HID provider"` — string constant only |
| `Fido2CliHardwareIdentityProvider.ts` (~343–347) | `console.warn` | `"fido2-token -I failed:"` + error message string — no secret bytes |
| `Fido2CliHardwareIdentityProvider.ts` (~351–354) | `console.warn` | `"fido2-token -I exited with code"` + integer exit code — no secret bytes |
| `Libfido2HardwareIdentityProvider.ts` (~252–255) | `console.warn` | `"getInfo failed for <device-path>:"` + error — device path and error only |
| `NodeHidHardwareIdentityProvider.ts` (~239–242) | `console.warn` | `"getInfo failed for <device-path>:"` + error — device path and error only |
| `NodeHidHardwareIdentityProvider.ts` (~257–260) | `console.log` | `"Known FIDO2 vendor detected; using windows://hello"` — string constant only |

No `hmacOutput`, `walletSeed`, `secretKey`, `PRF_Output`, or `Wallet_Seed` bytes appear in any log statement.

---

## Section 3: IPC Boundary Audit

### 3.1 `credential:discover` response

**Confirmed: The `credential:discover` IPC response contains only `credentialId` (hex string) and `userDisplayName` (string).**

Handler location: `src/main/index.ts`, lines ~393–407.

The handler reads from `CredentialStore.findAll()` and returns:

```typescript
{
  credentials: storedCreds.map((c) => ({
    credentialId: c.credentialId,   // hex string — opaque identifier, not a secret
    userDisplayName: c.displayName, // human-readable string
  }))
}
```

`CredentialStore` stores only credential metadata (hex credential ID, display name, rpId, timestamps). It never stores `PRF_Output`, `Wallet_Seed`, or private key bytes, so none of those can appear in this response.

### 3.2 Scan for secret bytes crossing the IPC boundary

A search of all `webContents.send()` calls and IPC handler return values in `src/main/index.ts` confirms:

- `hmacOutput` — never forwarded to the renderer. `DerivationService.deriveWallet()` returns a `DerivationResult` containing only `{ keypair, walletAddress }`. The `walletAddress` is a Base58 public key (non-secret). The `keypair` object is held in `SessionService`; only `walletAddress` (the public key string) is forwarded to the renderer via session events.
- `walletSeed` — zeroed in `finally` before `deriveWallet()` returns; never visible outside `DerivationService`.
- `keypair.secretKey` — the `Keypair` object is stored in `SessionService` in the main process only. The renderer receives only the `walletAddress` (Base58 public key string) and `sessionId` (UUID). The private key bytes never cross the IPC boundary.

### 3.3 `credential:select` and session creation

When `credential:select` succeeds, the renderer receives:

```typescript
{
  walletAddress: string,  // Base58 public key — non-secret
  sessionId: string,      // UUID v4 — non-secret
  displayName: string     // human-readable string — non-secret
}
```

No `PRF_Output`, `Wallet_Seed`, or `secretKey` bytes are included.

---

## Section 4: Summary and Findings

### 4.1 Compliance status

| Requirement | Description | Status |
|-------------|-------------|--------|
| 22.1 | Document every secret-material location (file, line, secret name, zeroed in finally, IPC exposure, log exposure) | ✅ Documented in Section 1 |
| 22.2 | Confirm no log statement contains secret bytes | ✅ Confirmed in Section 2 |
| 22.3 | Confirm `credential:discover` returns only `credentialId` (hex) and `userDisplayName` (string) | ✅ Confirmed in Section 3.1 |
| 22.4 | Confirm `PRF_Output`, `Wallet_Seed`, and `secretKey` are not passed over IPC | ✅ Confirmed in Section 3.2–3.3 |
| 9.1 | `PRF_Output` zeroed in `finally` inside `deriveWallet()` | ✅ `hmacOutput.fill(0)` in `finally` |
| 9.2 | `Wallet_Seed` zeroed in `finally` inside `deriveWallet()` | ✅ `walletSeed.fill(0)` in `finally` |
| 9.3 | `keypair.secretKey` zeroed on session termination | ✅ `zeroKeypairSecret()` in `SessionService.terminateSession()` |
| 9.4 | `PRF_Output`/`Wallet_Seed` not passed over IPC | ✅ Confirmed |
| 9.5 | No secret bytes written to any log or file | ✅ Confirmed |

### 4.2 Open limitations

1. **stdout pipe buffer (accepted):** In `Fido2CliHardwareIdentityProvider`, the 32-byte HMAC secret travels as base64 text through the `fido2-assert.exe` stdout pipe. This pipe buffer is a Node.js-managed heap allocation that cannot be controlled or zeroed after reading. The intermediate `Buffer` used to decode the base64 value is zeroed immediately after copying into the returned `Uint8Array` (`hmacBuf.fill(0)` at line ~616), but the underlying pipe accumulation buffer is not. This is documented in the class JSDoc and is an accepted limitation of the CLI-subprocess architecture. A native-addon implementation would eliminate this gap.

2. **`Keypair` public getter copies (informational):** `@solana/web3.js`'s `Keypair.secretKey` getter returns a new copy of the secret key bytes on each invocation. Any code that reads `keypair.secretKey` (e.g., for signing) creates a transient copy that will be garbage-collected. `SessionService` zeroes the *internal* nacl buffer directly via `_keypair.secretKey.fill(0)`, which eliminates the original source; transient copies from getter calls prior to termination are not individually zeroed. This is inherent to the library's API design.

3. **`deriveFromPrfOutput()` caller responsibility:** `DerivationService.deriveFromPrfOutput()` accepts a `Uint8Array` from the caller (intended for renderer-side WebAuthn PRF use cases). The method zeroes its internal copy in `finally`, but it does not zero the caller's original `prfOutput` reference — that is the caller's responsibility.

### 4.3 No actionable defects found

All three primary secrets (`PRF_Output`, `Wallet_Seed`, `keypair.secretKey`) are:
- zeroed in `finally` blocks (or equivalent unconditional post-use zeroing) at every handling site,
- never passed over IPC to the renderer,
- never written to any log, file, or persistent store.

The two open limitations (stdout pipe buffer and getter copy transients) are architectural constraints of the current CLI-subprocess and library design respectively, not code-level defects.
