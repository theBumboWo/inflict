# Hardware Integration Audit Report

**Spec:** `hardware-integration-audit`
**Date:** 2025-07-09
**Auditor:** Kiro (task 1.2)
**Status:** Gate document — no code fixes may be applied until this file exists and is committed.

---

## Section 1 — Executive Summary

This audit covers every file in the KeyWallet hardware integration layer as required by Requirement 1. The goal is to establish the exact state of the code before any repair work begins, and to identify every defect, architectural deviation, and untested path.

### Audit scope

The files inspected are:

- `src/main/hardware/Fido2CliHardwareIdentityProvider.ts`
- `src/main/hardware/NodeHidHardwareIdentityProvider.ts`
- `src/main/hardware/Libfido2HardwareIdentityProvider.ts`
- `src/main/hardware/MockHardwareIdentityProvider.ts` (in `src/main/hardware/`)
- `test/mocks/MockHardwareIdentityProvider.ts`
- `src/main/derivation/DerivationService.ts`
- `src/main/enrollment/EnrollmentService.ts`
- `src/main/device/DeviceMonitor.ts`
- `src/main/hardware/ctap2/cbor.ts`
- `src/main/hardware/ctap2/credential-management.ts`
- `src/main/hardware/ctap2/get-assertion.ts`
- `src/main/hardware/ctap2/get-info.ts`
- `src/main/hardware/ctap2/hid-transport.ts`
- `src/main/hardware/ctap2/make-credential.ts`
- `src/main/hardware/ctap2/types.ts`

### Overall assessment

The integration is in a **partially repaired** state. The three critical input-format bugs described in Requirement 1.5 have already been fixed in `Fido2CliHardwareIdentityProvider.ts` (stdin line order, stdout line index, `discoverCredentials` non-blocking behaviour). Path resolution uses `app.getAppPath()` / `process.resourcesPath` correctly; `__dirname` is not used in any hardware or derivation file. Secret zeroization in `DerivationService.ts` follows the required `finally`-block pattern.

However, four significant gaps remain before the integration can be considered production-ready:

1. **No CLI executable existence check** — `Fido2CliHardwareIdentityProvider` spawns the subprocess without first verifying the `.exe` exists at the resolved path (Req 11.4 not implemented).
2. **No unit tests for CLI format** — There is no `test/unit/Fido2CliProvider.test.ts`; the stdin/stdout parsing logic has zero test coverage.
3. **No integration or failure-injection tests** — `EnrollmentService` and `DerivationService` mock-based integration tests are missing.
4. **CTAP2 `get-assertion.ts` PIN requirement** — The pure-CTAP2 path requires a PIN to be passed as a string, but `NodeHidHardwareIdentityProvider.getAssertion()` passes `undefined`. This means the raw-HID CTAP2 path currently **always throws "PIN is required"** for any device.

The active production path on Windows is entirely through `Fido2CliHardwareIdentityProvider` → `windows://hello`. That path is functionally correct but untested against real hardware.

---

## Section 2 — File-by-File Analysis

---

### 2.1 `src/main/hardware/Fido2CliHardwareIdentityProvider.ts`

**Implementation status:** Active — sole delegate for all `windows://hello` CTAP2 operations on Windows.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| CLI-1 | No executable existence check before `childProcess.spawn`. If `fido2-assert.exe` / `fido2-cred.exe` / `fido2-token.exe` are missing (e.g. packaging failure), the process throws a raw OS error instead of a descriptive `CtapError`. | Lines 162–194 (`spawnCli`), never checks `path.existsSync(exePath)` before spawning | No |
| CLI-2 | `NodeHidHardwareIdentityProvider` JSDoc comment (lines 14–17) still states the Windows fallback uses `@vaultys/webauthn-node` / `Libfido2HardwareIdentityProvider`. The code now correctly delegates to `Fido2CliHardwareIdentityProvider`, but the stale comment is misleading. | `NodeHidHardwareIdentityProvider.ts` line 14 | No |
| CLI-3 | `stdinData` parameter of `spawnCli` is always `""` (empty string) — stdin is written via a temp file (`-i <file>` flag). The `spawnCli` signature still accepts and writes `stdinData` to the process stdin pipe, which creates a dead code path. This is not a correctness defect but will confuse future maintainers. | Lines 162–230 | No |

**Grep evidence:**
- `spawn` call: line 179 — `childProcess.spawn(exePath, args, ...)`
- `fido2-cred.exe` invocation: line 458 — `-M -h -r -v -w -i <tmpFile> windows://hello es256`
- `fido2-assert.exe` invocation: line 547 — `-G -h -v -w -i <tmpFile> windows://hello`
- `fido2-token.exe` invocation: line 328 — `-I windows://hello`
- `hmacBuf.fill(0)`: lines 593, 604 — correct zeroization
- `console.warn` calls: lines 331–335, 339–343 — diagnostic only, do not log secrets
- No `__dirname` usage

**Test coverage gaps:**
- `test/unit/Fido2CliProvider.test.ts` does not exist
- stdin line order, stdout parsing, error handling, path resolution, and `discoverCredentials` non-blocking behaviour are all untested

---

### 2.2 `src/main/hardware/NodeHidHardwareIdentityProvider.ts`

**Implementation status:** Active for direct-HID devices (non-Windows) and for Windows device detection. Delegates `windows://hello` operations to `Fido2CliHardwareIdentityProvider` via `getWindowsProvider()`.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| HID-1 | JSDoc header (lines 13–22) describes a fallback to `@vaultys/webauthn-node` and `Libfido2HardwareIdentityProvider`. The actual runtime code (`getWindowsProvider()`, lines 191–202) correctly instantiates `Fido2CliHardwareIdentityProvider`. The stale comment is actively misleading. | Lines 13–22 | No |
| HID-2 | `getAssertion()` passes `(options as AssertionOptions & { pin?: string }).pin` to the underlying `getAssertion` in `ctap2/get-assertion.ts` (line 399–402). The `AssertionOptions` interface has no `pin` field, so this cast always produces `undefined`. The pure-CTAP2 path then throws `"PIN is required"` unconditionally for any device requiring user verification. This means `NodeHidHardwareIdentityProvider.getAssertion()` is **broken for all real hardware** on non-Windows platforms. | Line 399–402 in `getAssertion()` | No |
| HID-3 | `discoverCredentials` for `windows://hello` delegates to `getWindowsProvider().discoverCredentials()`, which returns `{ credentials: [] }` — correct per Req 5.1. For direct-HID paths the method calls `enumerateResidentCredentials()`, which requires a PIN token but no PIN is supplied, so it will fail on PIN-protected devices. | Lines 295–335 (`discoverCredentials`) | No |

**Grep evidence:**
- `console.log` at line 257 — vendor detection announcement, no secrets
- `console.warn` at line 239 — getInfo failure, no secrets
- No `__dirname` usage; no subprocess spawns in this file

**Test coverage gaps:**
- Windows delegation path (`getWindowsProvider()`) has no test
- Vendor-ID detection logic is not unit-tested
- Direct-HID `getAssertion()` PIN flow is untested

---

### 2.3 `src/main/hardware/Libfido2HardwareIdentityProvider.ts`

**Implementation status:** Present but **not active** for any operation in the current production code. `NodeHidHardwareIdentityProvider.getWindowsProvider()` was updated to use `Fido2CliHardwareIdentityProvider` instead.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| LIB-1 | `getAssertion()` calls `fido2.getAssertion()` via `@vaultys/webauthn-node`. The C++ binding does **not** implement the `hmac-secret` extension in its `GetAssertion` path. `result.response.hmacSecret` will always be `undefined` or absent, causing a `CtapError("UNKNOWN", "The security key did not return an hmac-secret output")`. This is the root cause of the original integration failure. | Lines 396–438 | No |
| LIB-2 | Module-level `require("@vaultys/webauthn-node")` at line 97 runs at import time. If the native addon is not built, the entire module load silently records the error in `libfido2LoadError`. No warning is emitted at startup. The failure is deferred until a method is called, which may be surprising. | Lines 96–105 | No |

**Grep evidence:**
- `@vaultys/webauthn-node` import: line 97 (`require(...)`)
- `hmacSecret` field access: line 424 (`result.response.hmacSecret`)
- `console.warn` at line 252 — getInfo failure per device, no secrets
- No `__dirname` usage; no subprocess spawns

**Test coverage gaps:**
- No tests for `Libfido2HardwareIdentityProvider` at all (not needed for the active path, but defect LIB-1 is undetected)

---

### 2.4 `src/main/hardware/MockHardwareIdentityProvider.ts` (src copy) and `test/mocks/MockHardwareIdentityProvider.ts`

**Implementation status:** The `src/main/hardware/MockHardwareIdentityProvider.ts` is a copy of the canonical test mock. Both files implement the same deterministic HMAC-SHA256-based mock device.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| MOCK-1 | Two copies of this file exist (`src/main/hardware/` and `test/mocks/`). The files are described as "kept in sync" manually. A divergence between the two copies would silently change behaviour depending on which import path is used. | Both files | No |
| MOCK-2 | `getAssertion()` returns the same `hmacOutput` reference from `_hmacCache` on repeated calls. The caller (`DerivationService`) zeroes the buffer with `.fill(0)` in its `finally` block. On the next call for the same `credentialId`, the cached buffer is all zeros — the mock is not idempotent across calls when `DerivationService` zeroes it. This will cause Property 11 (round-trip determinism) to fail unless `MockHardwareIdentityProvider` is fixed to return a fresh copy each time. | `test/mocks/MockHardwareIdentityProvider.ts` lines 67–79 (`getAssertion`) | No |

**Test coverage gaps:**
- The mock itself is not unit-tested for idempotency or cache behaviour

---

### 2.5 `src/main/derivation/DerivationService.ts`

**Implementation status:** Correct. Implements both `deriveWallet()` (hardware path) and `deriveFromPrfOutput()` (renderer PRF path). Both follow the required `finally`-block zeroization pattern.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| DERIV-1 | `deriveWallet()` receives the `keypair.secretKey` bytes as a by-product of `Keypair.fromSeed(walletSeed)`. The keypair is included in the returned `DerivationResult` and is not zeroed here — that is the responsibility of `SessionService`. However, if the caller (IPC handler) forgets to call `SessionService.terminateSession()`, the keypair leaks. The audit trail from `DerivationResult.keypair` to `SessionService` is not enforced. | Lines 109–116 | No |

**Grep evidence:**
- `hmacOutput.fill(0)` in `finally`: line 116 ✓
- `walletSeed.fill(0)` in `finally`: line 119 ✓
- `hmacOutput.fill(0)` in `deriveFromPrfOutput finally`: line 157 ✓
- `walletSeed.fill(0)` in `deriveFromPrfOutput finally`: line 159 ✓
- `PRF_SALT_CONSTANT` from `./hkdf`: correct constant use
- No `console.*` calls in this file ✓
- No `__dirname` usage ✓

**Test coverage gaps:**
- `test/unit/DerivationService.test.ts` exists and covers determinism/injectivity
- Zeroization behaviour (Property 10) is not explicitly tested — no assertion that `hmacOutput` bytes equal zero after the call
- Integration test with `EnrollmentService` is missing

---

### 2.6 `src/main/enrollment/EnrollmentService.ts`

**Implementation status:** Correct. Enforces resident-key, UV-required, cross-platform-attachment policy. Persists only non-secret metadata (credentialId hex, rpId, displayName, createdAt).

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| ENROLL-1 | `userId` is generated as 16 random bytes at line 127 (`randomBytes(16)`) and zeroed in the `finally` block at line 144 (`userId.fill(0)`). `userId` is NOT secret material (it is stored in the FIDO2 authenticator's resident credential), but the comment correctly notes this is "good hygiene." No correctness defect, but worth documenting. | Lines 127, 144 | N/A |
| ENROLL-2 | The `pin-required` category is thrown when `deviceInfo.clientPin === false` (line 97). The `MockHardwareIdentityProvider` sets `clientPin: true`, so this guard is never exercised in mock-based tests. There is no test that simulates a device with `clientPin === false`. | Lines 92–100 | No |

**Test coverage gaps:**
- `test/unit/EnrollmentService.test.ts` exists but uses `MockHardwareIdentityProvider` exclusively
- No test for `CTAP2_ERR_PIN_BLOCKED` → `pin-locked` EnrollmentError mapping
- No test for `CTAP2_ERR_KEY_STORE_FULL` → `storage-full` EnrollmentError mapping
- No integration test that chains `enroll()` → `deriveWallet()`

---

### 2.7 `src/main/device/DeviceMonitor.ts`

**Implementation status:** Correct. Polls every 500 ms with a 5-second `listDevices()` timeout. Emits `device-connected`, `device-removed`, `device-unsupported` events. Correctly gates `device-connected` on `supportsHmacSecret`.

**Known defects:** None identified.

**Grep evidence:**
- No `console.*` calls ✓
- No `__dirname` usage ✓
- No subprocess spawns ✓
- `supportsHmacSecret` check: line 113 ✓

**Test coverage gaps:**
- `test/unit/DeviceMonitor.test.ts` exists
- The "known FIDO2 vendor detected; using windows://hello" delegation code path in `NodeHidHardwareIdentityProvider.listDevices()` is not exercised by `DeviceMonitor` tests — those tests stub `provider.listDevices()` directly

---

### 2.8 `src/main/hardware/ctap2/cbor.ts`

**Implementation status:** Custom CBOR encoder/decoder. Implements minimal encode/decode sufficient for CTAP2 maps, arrays, strings, byte strings, integers, and booleans.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| CBOR-1 | `decodeCbor2Map` is referenced by `get-assertion.ts`, `get-info.ts`, `make-credential.ts`, and `credential-management.ts` but no unit tests exist for the CBOR decoder. An encoding/decoding round-trip test is absent. | Entire file | No |

**Test coverage gaps:**
- No tests for `cbor.ts`; decoder is exercised only implicitly via other CTAP2 modules

---

### 2.9 `src/main/hardware/ctap2/credential-management.ts`

**Implementation status:** Implements CTAP2 `authenticatorCredentialManagement` (command `0x0A`) with `enumerateCredentialsBegin` (subcommand `0x04`) and `enumerateCredentialsGetNextCredential` (subcommand `0x05`).

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| CREDMGMT-1 | Credential management requires a PIN/UV auth token (PUAT) on most modern authenticators. The implementation sends the raw CTAP2 command with no PIN authentication parameters. On a PIN-protected device this will return `CTAP2_ERR_PUAT_REQUIRED (0x36)`, which is translated to `"PIN required for credential enumeration"`. There is no code path that retrieves a PIN token and retries. | Entire `enumerateResidentCredentials()` function | No |
| CREDMGMT-2 | The module is only called from `NodeHidHardwareIdentityProvider.discoverCredentials()`, which is itself only called for non-Windows-Hello device paths. For `windows://hello` paths, `discoverCredentials` now returns `{ credentials: [] }` without calling this module. | `NodeHidHardwareIdentityProvider.ts` lines 295–335 | N/A |

**Test coverage gaps:**
- No unit or integration tests for `credential-management.ts`
- Untested against real hardware

---

### 2.10 `src/main/hardware/ctap2/get-assertion.ts`

**Implementation status:** Implements full CTAP2 `authenticatorGetAssertion` with PIN Protocol 1 (ECDH key agreement, AES-256-CBC PIN hash encryption, PIN token exchange, hmac-secret salt encryption and output decryption). Secret buffers (`sharedSecret`, `pinToken`, intermediate key material) are zeroed in `finally` blocks.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| GETASSERT-1 | The function requires a non-empty `pin` parameter (`if (!pin || pin.length === 0)` at line 200). `NodeHidHardwareIdentityProvider.getAssertion()` passes `(options as AssertionOptions & { pin?: string }).pin`, which is always `undefined` since `AssertionOptions` has no `pin` field. This means **every call through `NodeHidHardwareIdentityProvider.getAssertion()`** fails with `"PIN is required for userVerification: required"`. The raw CTAP2 path for `getAssertion` is **completely broken** for all real devices. | Line 200 (`get-assertion.ts`), lines 399–402 (`NodeHidHardwareIdentityProvider.ts`) | No |
| GETASSERT-2 | The ephemeral P-256 key pair is generated using `generateKeyPairSync("ec", { namedCurve: "P-256" })`. This is a synchronous call that may block the event loop for several milliseconds. On resource-constrained systems this could cause jitter during the 60-second CTAP2 timeout window. | Line 235 | No |

**Test coverage gaps:**
- No unit tests for `get-assertion.ts`
- PIN Protocol 1 ECDH encryption path is untested
- hmac-secret decryption is untested
- **Untested against real hardware** — entire file is in this category

---

### 2.11 `src/main/hardware/ctap2/get-info.ts`

**Implementation status:** Implements `authenticatorGetInfo` (CTAP2 command `0x04`). Parses extensions, options, AAGUID, versions, maxMsgSize, and pinUvAuthProtocols. Derives `supportsHmacSecret`, `supportsResidentKey`, and `clientPin` convenience flags.

**Known defects:** None identified.

**Test coverage gaps:**
- No unit tests
- Exercised only indirectly via `NodeHidHardwareIdentityProvider.listDevices()` tests
- **Untested against real hardware**

---

### 2.12 `src/main/hardware/ctap2/hid-transport.ts`

**Implementation status:** Implements CTAPHID packet framing (`sendCtaphidMessage`, `receiveCtaphidMessage`), channel allocation (`allocateChannel`), and the CTAP2 CBOR command wrapper (`ctap2Exchange`). Uses a 5-second read timeout per packet and correctly skips KEEPALIVE packets.

**Known defects:**

| # | Defect | File:Lines | Test catches it? |
|---|--------|-----------|-----------------|
| HID-TRANS-1 | `receiveCtaphidMessage` uses `device.once("data", ...)` and `device.once("error", ...)` for each `readPacket` call. On Windows via `node-hid`, `HID.HID` may not support event-driven reads in the same way as on Linux/macOS. The `read()` method (synchronous polling) may be needed instead. This is a potential platform compatibility issue that has not been verified on Windows with node-hid. | `readPacket()` function, lines 114–148 | No |

**Test coverage gaps:**
- No unit tests for CTAPHID packet framing
- **Untested against real hardware**

---

### 2.13 `src/main/hardware/ctap2/make-credential.ts`

**Implementation status:** Implements `authenticatorMakeCredential` (CTAP2 command `0x01`) with `rk: true`, `uv: true`, `hmac-secret: true`, and ES256 algorithm. Correctly parses `authData` to extract `credentialId` and `publicKeyBytes`.

**Known defects:** None identified.

**Test coverage gaps:**
- No unit tests
- `authData` parsing is tested only implicitly through `NodeHidHardwareIdentityProvider` tests
- **Untested against real hardware**

---

### 2.14 `src/main/hardware/ctap2/types.ts`

**Implementation status:** Constants and type definitions for CTAPHID and CTAP2 protocol. No logic.

**Known defects:** None.

**Test coverage gaps:** N/A (constants only).

---

## Section 3 — Known Input-Format Bugs

This section records the three specific input-format bugs required by Requirement 1.5. These bugs existed in an earlier version of the code and have since been repaired. They are documented here as the authoritative record of the defect sequence.

---

### Bug 1 — Wrong `userId` / `userName` order in `fido2-cred` stdin

**Status:** FIXED in `Fido2CliHardwareIdentityProvider.ts`

**Description:**
The `fido2-cred -M` stdin protocol requires lines in the order:
```
[0] clientDataBase64
[1] rpId
[2] userName        ← name comes BEFORE user ID
[3] userIdBase64    ← user ID comes AFTER name
```
An earlier version of the code wrote `userIdBase64` at index 2 and `userName` at index 3 (reversed). The libfido2 1.15.0 source confirms that `name` precedes `id` in the stdin stream for the `-M` make-credential command. This reversal caused `fido2-cred` to either reject the request entirely or enroll a credential under the wrong identity, producing a silent misattribution.

**Current code (FIXED):**
```typescript
// Fido2CliHardwareIdentityProvider.ts, lines 441-451
const stdinLines = [
  clientData,
  options.rpId,
  options.userName || options.userDisplayName,  // ← line 2: userName (CORRECT)
  userIdB64,                                     // ← line 3: userId   (CORRECT)
].join("\n") + "\n";
```

**File:** `src/main/hardware/Fido2CliHardwareIdentityProvider.ts`, `createCredential()` method, lines 438–461

**Test coverage:** None — this fix has no regression test.

---

### Bug 2 — Wrong stdout line index for credential ID in `fido2-cred` output

**Status:** FIXED in `Fido2CliHardwareIdentityProvider.ts`

**Description:**
The `fido2-cred -M` stdout protocol produces lines in this order:
```
[0] clientDataHash (base64)
[1] rpId (echoed)
[2] format (e.g. "packed")
[3] authData (base64)
[4] credentialId (base64)   ← CORRECT index for credential ID
[5] attestationSignature (base64)
[6] attestationCert (base64, optional)
```
An earlier version of the code read `credentialId` from a wrong line index (not index 4). This caused either a crash (wrong base64 decoded length), a nonsense credential ID that would never match on subsequent assertions, or silent enrollment of an unusable credential.

**Current code (FIXED):**
```typescript
// Fido2CliHardwareIdentityProvider.ts, lines 470-491
const credentialId = Buffer.from(lines[4], "base64");  // ← index 4 (CORRECT)
const publicKeyBytes = Buffer.from(lines[3], "base64"); // authData at index 3
```

**File:** `src/main/hardware/Fido2CliHardwareIdentityProvider.ts`, `createCredential()` method, lines 470–495

**Test coverage:** None — this fix has no regression test.

---

### Bug 3 — `discoverCredentials` timeout caused by `fido2-assert -G -r` triggering Windows Hello dialog

**Status:** FIXED in `Fido2CliHardwareIdentityProvider.ts`

**Description:**
An earlier implementation of `discoverCredentials()` spawned `fido2-assert -G -r -h -v -w -i <tmpfile> windows://hello`. The `-r` flag instructs libfido2 to perform a resident-credential assertion without an explicit credential ID. On Windows via `windows://hello`, this triggers a **user-interaction security dialog** (the Windows Security PIN/fingerprint prompt). Since `discoverCredentials()` is called during passive device detection (not at user-initiated assertion time), this dialog appeared unexpectedly and blocked the application. The process either timed out (after 60 seconds) or hung indefinitely while waiting for user input that never came.

The requirement (Req 5.1, 5.2) mandates that `discoverCredentials()` must return results without spawning any subprocess or triggering hardware interaction.

**Current code (FIXED):**
```typescript
// Fido2CliHardwareIdentityProvider.ts, lines 408-418
async discoverCredentials(
  _devicePath: string,
  _rpId: string,
): Promise<DiscoveryResult> {
  // Returns empty — no subprocess spawned, no Windows Hello dialog triggered.
  return { credentials: [] };
}
```

**File:** `src/main/hardware/Fido2CliHardwareIdentityProvider.ts`, `discoverCredentials()` method, lines 406–420

**Test coverage:** None — this fix has no regression test.

---

## Section 4 — Provider Comparison Table

| Provider | Target Platform | `createCredential` with Resident Key | `getAssertion` with hmac-secret | Active in Production |
|---|---|---|---|---|
| `Fido2CliHardwareIdentityProvider` | Windows 10 1903+ (via `windows://hello`) | ✅ Supported via `fido2-cred.exe -M -h -r` | ✅ Supported via `fido2-assert.exe -G -h` | **YES** — sole Windows delegate |
| `NodeHidHardwareIdentityProvider` | Linux, macOS, Windows (raw HID, non-FIDO-usage-page) | ✅ Supported via CTAP2 `makeCredential` | ⚠️ Broken — PIN never supplied (defect GETASSERT-1) | Partial — used for device detection; `getAssertion` broken |
| `Libfido2HardwareIdentityProvider` | Any (via `@vaultys/webauthn-node` native addon) | ✅ Supported | ❌ Not supported — `@vaultys/webauthn-node` C++ binding does not implement hmac-secret in `GetAssertion` | **NO** — not used in current routing |
| `MockHardwareIdentityProvider` (test) | Software / tests only | ✅ Supported (random credential ID) | ✅ Supported (deterministic HMAC-SHA256 mock) | NO — tests only |

**Notes:**
- `Fido2CliHardwareIdentityProvider` is the **only** provider that can successfully complete the full `createCredential` → `getAssertion` with hmac-secret flow on Windows.
- `NodeHidHardwareIdentityProvider` is used on non-Windows platforms for raw CTAP2, but its `getAssertion` path is broken because no PIN UI is wired through.
- `Libfido2HardwareIdentityProvider` is a dead-code path in the current routing. Its dependency (`@vaultys/webauthn-node`) is present in `package.json` but not used for any hmac-secret operation.

---

## Section 5 — Paths Never Executed Against Real Hardware

The following code paths have never been executed against a real physical FIDO2 authenticator. Each is labelled **untested against hardware**.

| # | Code Path | File | Notes |
|---|-----------|------|-------|
| 1 | `ctap2/get-assertion.ts` — entire function | `src/main/hardware/ctap2/get-assertion.ts` | **untested against hardware** — PIN Protocol 1 ECDH, AES-256-CBC salt encryption, hmac-secret decryption. Called only through `NodeHidHardwareIdentityProvider` which has defect GETASSERT-1 (PIN always undefined). |
| 2 | `ctap2/make-credential.ts` — entire function | `src/main/hardware/ctap2/make-credential.ts` | **untested against hardware** — CTAP2 `authenticatorMakeCredential` over raw HID. |
| 3 | `ctap2/get-info.ts` — entire function | `src/main/hardware/ctap2/get-info.ts` | **untested against hardware** — used only by `NodeHidHardwareIdentityProvider.listDevices()` for non-Windows platforms. |
| 4 | `ctap2/hid-transport.ts` — full HID framing | `src/main/hardware/ctap2/hid-transport.ts` | **untested against hardware** — CTAPHID packet framing, channel allocation, KEEPALIVE handling. |
| 5 | `ctap2/credential-management.ts` — entire function | `src/main/hardware/ctap2/credential-management.ts` | **untested against hardware** — PIN-protected CTAP2 credential enumeration. |
| 6 | `ctap2/cbor.ts` — decoder | `src/main/hardware/ctap2/cbor.ts` | **untested against hardware** — no round-trip tests against real device CBOR output. |
| 7 | `Libfido2HardwareIdentityProvider.getAssertion()` | `src/main/hardware/Libfido2HardwareIdentityProvider.ts` lines 396–438 | **untested against hardware** — also functionally broken (hmac-secret not implemented in `@vaultys/webauthn-node`). |
| 8 | `Libfido2HardwareIdentityProvider.discoverCredentials()` | `src/main/hardware/Libfido2HardwareIdentityProvider.ts` lines 261–309 | **untested against hardware** |
| 9 | `NodeHidHardwareIdentityProvider.getAssertion()` — non-Windows direct-HID path | `src/main/hardware/NodeHidHardwareIdentityProvider.ts` lines 348–411 | **untested against hardware** — broken by defect GETASSERT-1 |
| 10 | `NodeHidHardwareIdentityProvider.createCredential()` — non-Windows direct-HID path | `src/main/hardware/NodeHidHardwareIdentityProvider.ts` lines 298–345 | **untested against hardware** |
| 11 | `Fido2CliHardwareIdentityProvider` — full `createCredential()` + `getAssertion()` on real YubiKey | `src/main/hardware/Fido2CliHardwareIdentityProvider.ts` | **untested against hardware** — subprocess invocations via `windows://hello` have been run only against Windows Hello software authenticator in development, not against a physical YubiKey 5C NFC. |
| 12 | `DerivationService.deriveWallet()` — end-to-end with real hardware | `src/main/derivation/DerivationService.ts` | **untested against hardware** — all tests use `MockHardwareIdentityProvider`. |

---

## Section 6 — Recommended Fix Order

The following fix order is designed to gate each phase on the previous one passing, minimising the risk of introducing new defects during repair.

### Phase 1 (this document) — Gate: audit document committed ✅

`docs/hardware-audit.md` must exist and be committed before any code changes begin. This phase is complete when this file is committed.

### Phase 2 — Fix `Fido2CliHardwareIdentityProvider.ts` (tasks 2.1–2.6)

Priority: **Critical** — this is the only working end-to-end path.

1. **Task 2.1** — Verify/confirm `createCredential()` stdin line order is `[clientData, rpId, userName, userIdB64]` (already correct; write test to lock it in).
2. **Task 2.2** — Verify/confirm `createCredential()` reads `credentialId` from `lines[4]` (already correct; write test).
3. **Task 2.3** — Verify/confirm `getAssertion()` stdin order and hmac line disambiguation (`lines.length >= 6 ? 5 : 4`) (already correct; write test).
4. **Task 2.4** — Verify/confirm `discoverCredentials()` returns `{ credentials: [] }` without spawning (already correct; write test).
5. **Task 2.5** — Verify/confirm path resolution uses `app.getAppPath()` / `process.resourcesPath` (already correct; write test).
6. **Task 2.6** — **Implement** the missing CLI executable existence check (defect CLI-1). Before any `childProcess.spawn`, verify `path.existsSync(exePath)` and throw `CtapError("UNKNOWN", ..., fullResolvedPath)` if missing.

### Phase 3 — Add unit test suite for `Fido2CliHardwareIdentityProvider` (task 4.1)

Priority: **High** — locks in all Phase 2 fixes against future regression.

Write `test/unit/Fido2CliProvider.test.ts` with all 12 unit tests covering stdin format, stdout parsing, error cases, path resolution, and PATH prepending.

### Phase 4 — Add property-based tests (task 4.2)

Priority: **High** — validates Properties 3, 5, 10, 11 across many input combinations.

Write `test/property/hardware-derivation.property.test.ts` with Properties 3 (fido2-cred stdin order), 5 (fido2-assert stdin order), 10 (PRF_Output zeroization), 11 (mock round-trip determinism).

Fix defect MOCK-2 (`MockHardwareIdentityProvider` returns a fresh copy of `hmacOutput` on each call rather than a shared reference).

### Phase 5 — Add integration and failure-injection tests (tasks 4.3, 4.4)

Priority: **High** — verifies the `EnrollmentService` → `DerivationService` chain.

- `test/integration/enrollment-derivation.integration.test.ts` (4 tests, Req 16)
- `test/integration/failure-injection.integration.test.ts` (5 tests, Req 17)

### Phase 6 — Stale comment cleanup (no task yet — low risk)

Priority: **Low** — non-functional.

Update the `NodeHidHardwareIdentityProvider` JSDoc header (defect HID-1) to correctly state that `windows://hello` operations delegate to `Fido2CliHardwareIdentityProvider`, not `@vaultys/webauthn-node` / `Libfido2HardwareIdentityProvider`.

### Phase 7 — Diagnostic tooling (tasks 3.1–3.5)

Priority: **Medium** — needed before real-hardware verification.

Create `scripts/hardware-diagnose.ts`, `scripts/hardware-test.ts`, `scripts/diagnostics.ts`, `scripts/hardware-acceptance-test.ts`, and the corresponding `package.json` npm scripts.

### Phase 8 — Packaging verification (tasks 6.1–6.3)

Priority: **Medium** — needed for release.

Verify `libfido2-win/**/*` in `build.files`, `asarUnpack` entries for `node-hid` and `@vaultys/webauthn-node`, and startup existence check for `fido2-assert.exe`.

### Phase 9 — Real-hardware verification (tasks 7.1–7.4)

Priority: **Critical for release** — cannot be automated.

Run `npm run hardware:diagnose` and `npm run hardware:test` with a physical YubiKey 5C NFC plugged in. Verify all steps print PASS. Run the full application and confirm a wallet address is derived and is stable across reconnects.

### Phase 10 — Documentation (tasks 8.1–8.4)

Priority: **Low** — post-verification.

Create `docs/security-audit.md`, update `README.md`, update `.kiro/steering/security.md` and `.kiro/steering/architecture.md`.

---

*End of audit report. This document was produced by automated source inspection (task 1.2) and is the authoritative record required by Requirement 1.6 before any code fix is applied.*
