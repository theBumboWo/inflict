# Design Document: Hardware Integration Audit

## Overview

This audit spec repairs a single, verified end-to-end path from a physical FIDO2 security key to a Solana devnet wallet address on Windows 10 1903+. The OS HID claim prevents raw USB access, so the only viable Windows path routes through the bundled libfido2 1.15.0 CLI tools via the `windows://hello` synthetic device path.

The audit covers three activities that run in strict sequence:
1. **Audit documentation** — write `docs/hardware-audit.md` before touching any code
2. **Code repair** — fix format bugs, path resolution, and secret handling confirmed by the audit
3. **Test completion** — add CLI format unit tests, new property tests, and integration tests that were missing

## Architecture

### Windows FIDO2 Exclusive Path

```
Physical YubiKey (USB HID)
  ↓ vendor-ID scan (node-hid, read-only — OS does NOT claim VID scan)
NodeHidHardwareIdentityProvider.listDevices()
  ↓ known FIDO2 vendor detected → windows://hello path
Fido2CliHardwareIdentityProvider
  ↓ fido2-cred.exe / fido2-assert.exe (subprocess)
webauthn.dll (Windows Hello OS API)
  ↓ hmac-secret extension
32-byte PRF_Output
  ↓ hkdfSync("sha256", prfOutput, "", "key-wallet:solana:ed25519:v1", 32)
32-byte Wallet_Seed
  ↓ Keypair.fromSeed()
Ed25519 Keypair → Solana wallet address (Base58)
```

**Why `@vaultys/webauthn-node` is excluded:** The C++ binding does not implement `hmac-secret` in its `GetAssertion` path. It is used for nothing in this flow; `Fido2CliHardwareIdentityProvider` is the sole delegate for all `windows://hello` operations.

### Provider Routing Decision Tree

```
NodeHidHardwareIdentityProvider.listDevices()
├─ Filter HID list with FIDO_USAGE_PAGE (0xF1D0) + FIDO_USAGE (0x01)
│   ├─ Results found → return direct CTAP2 over HID (non-Windows or raw HID access)
│   └─ No results found AND platform is win32
│       ├─ Scan all HID entries for KNOWN_FIDO2_VENDORS set
│       │   ├─ No known vendor → return [] (key not plugged in)
│       │   └─ Known vendor found → delegate to getWindowsProvider().listDevices()
│       │       ├─ fido2-token -I windows://hello succeeds → return [DeviceInfo for windows://hello]
│       │       └─ fido2-token fails → return [] (CLI not available)
└─ Any subsequent operation on devicePath === "windows://hello"
    → delegate entire operation to Fido2CliHardwareIdentityProvider
```

### Lazy Windows Provider Instantiation

`NodeHidHardwareIdentityProvider.getWindowsProvider()` uses `require()` at call time (not a top-level import) to avoid loading the CLI provider on non-Windows platforms. The returned instance is cached in `this.windowsProvider` so only one `Fido2CliHardwareIdentityProvider` instance exists per `NodeHidHardwareIdentityProvider` instance.

## Components and Interfaces

### Component Inventory

| File | Action | Scope |
|---|---|---|
| `src/main/hardware/Fido2CliHardwareIdentityProvider.ts` | **Modify** | Fix stdin/stdout format, path resolution |
| `src/main/hardware/NodeHidHardwareIdentityProvider.ts` | **Verify** | Confirm delegation logic is correct |
| `src/main/derivation/hkdf.ts` | **Verify** | Confirm PRF_SALT_CONSTANT derivation is correct |
| `src/main/derivation/DerivationService.ts` | **Verify** | Confirm zeroization in finally blocks |
| `scripts/hardware-diagnose.ts` | **Create** | Diagnostic — getInfo only, no PRF |
| `scripts/hardware-test.ts` | **Create** | Full enrollment → derivation in test namespace |
| `scripts/diagnostics.ts` | **Create** | Runs both scripts, writes logs/hardware-diagnostics.txt |
| `scripts/hardware-acceptance-test.ts` | **Create** | Real-hardware acceptance test (manual run) |
| `docs/hardware-audit.md` | **Create** | Audit report — must exist before any code fix |
| `docs/hardware-test-matrix.md` | **Create** | Hardware compatibility matrix |
| `docs/security-audit.md` | **Create** | Secret material location audit |
| `test/unit/Fido2CliProvider.test.ts` | **Create** | CLI stdin/stdout format unit tests (Req 14) |
| `test/property/hardware-derivation.property.test.ts` | **Create** | New property tests (Req 15 gaps) |
| `test/integration/enrollment-derivation.integration.test.ts` | **Create** | End-to-end mock flow (Req 16) |
| `test/integration/failure-injection.integration.test.ts` | **Create** | CTAP2 failure injection (Req 17) |
| `package.json` | **Modify** | Add hardware:diagnose, hardware:test, diagnostics scripts |

### Interfaces (Unchanged)

`IHardwareIdentityProvider`, `DeviceInfo`, `EnrollmentOptions`, `EnrollmentResult`, `AssertionOptions`, `AssertionResult`, and `CtapError` in `src/main/hardware/types.ts` are **not modified** by this spec. The audit may find bugs in implementations, but the interface contract is correct.

## Data Models

### CLI Subprocess Protocol

This is the authoritative format derived from libfido2 1.15.0 source and verified against the bundled binaries.

#### `fido2-cred -M -h -r -v -w -i <file> windows://hello es256`

**Stdin (4 lines, `\n`-terminated):**
```
<clientDataBase64>\n          ← 32 random bytes, base64 (-w = raw/unhashed client data)
<rpId>\n                      ← UTF-8 RP identifier, e.g. "key-wallet.local"
<userName>\n                  ← UTF-8 display name (NOT user ID — name comes before ID)
<userIdBase64>\n              ← base64 of options.userId bytes
```

**Stdout (6–7 lines, indexed from 0):**
```
[0] clientDataHash            ← base64, SHA-256 of the client data
[1] rpId                      ← echoed back
[2] format                    ← e.g. "packed"
[3] authData                  ← base64 authenticator data
[4] credentialId              ← base64, THIS is what we want
[5] attestationSignature      ← base64
[6] attestationCert           ← base64, optional (may be absent for self-attestation)
```

**Critical bug fixed by this spec:** Previous code wrote `userId` before `userName` (reversed order), causing `fido2-cred` to reject the request or enroll under the wrong identity. The correct order is **userName first, userId second** (lines 3 and 4 of the stdin block above).

#### `fido2-assert -G -h -v -w -i <file> windows://hello`

**Stdin (4 lines, `\n`-terminated):**
```
<clientDataBase64>\n          ← 32 random bytes, base64 (-w = raw/unhashed client data)
<rpId>\n                      ← UTF-8 RP identifier
<credentialIdBase64>\n        ← base64 of the enrolled credential ID
<hmacSaltBase64>\n            ← base64 of PRF_SALT_CONSTANT (32 bytes)
```

**Stdout — resident credential (6 lines):**
```
[0] clientDataHash
[1] rpId
[2] authData
[3] assertionSignature
[4] userId                    ← present when credential is resident (has user ID)
[5] hmacSecret                ← 32-byte PRF_Output, base64  ← read from here
```

**Stdout — non-resident credential assertion (5 lines):**
```
[0] clientDataHash
[1] rpId
[2] authData
[3] assertionSignature
[4] hmacSecret                ← no userId line → read from here
```

**Disambiguation rule:** `if (lines.length >= 6) { hmacLineIndex = 5 } else { hmacLineIndex = 4 }`

The wallet uses resident credentials enrolled via `createCredential`, so the 6-line path is the normal case. The 5-line fallback handles assertions against credentials not held as resident (e.g., manual test invocations).

### PRF_Salt Derivation (Authoritative)

```typescript
// Computed once at module load time — never at call time
PRF_SALT_CONSTANT = hkdfSync(
  "sha256",
  IKM  = Buffer.from("key-wallet-prf-salt-v1", "utf8"),
  salt = Buffer.alloc(0),          // empty salt
  info = Buffer.from("solana-wallet-derivation", "utf8"),
  length = 32
)
```

This is already correctly implemented in `src/main/derivation/hkdf.ts`. The audit verifies it hasn't been mutated.

### Wallet Seed HKDF (Authoritative)

```typescript
Wallet_Seed = hkdfSync(
  "sha256",
  IKM  = hmacOutput,               // 32-byte PRF_Output from hardware
  salt = Buffer.alloc(0),          // empty salt (not PRF_SALT_CONSTANT — different step)
  info = Buffer.from("key-wallet:solana:ed25519:v1", "utf8"),
  length = 32
)
```

Verified correct in `DerivationService.ts`. Any deviation from these exact parameters produces a different (wrong) wallet address.

### Path Resolution (Authoritative)

```typescript
function getCliDir(): string {
  const relative = path.join(
    "libfido2-win", "libfido2-1.15.0-win", "Win64", "Release", "v143", "dynamic"
  );
  // NEVER use __dirname — it refers to the compiled JS output location, not the
  // project root or resources directory. Use app.getAppPath() or process.resourcesPath.
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, relative);
}
```

**Development (`app.isPackaged === false`):**
`app.getAppPath()` → `c:\project\` → `c:\project\libfido2-win\libfido2-1.15.0-win\Win64\Release\v143\dynamic\`

**Packaged (`app.isPackaged === true`):**
`process.resourcesPath` → `<install>\resources\` → `<install>\resources\libfido2-win\libfido2-1.15.0-win\Win64\Release\v143\dynamic\`

### Child Process Environment

Every subprocess spawn must prepend `cliDir` to the child's `PATH` so `fido2.dll`, `cbor.dll`, `crypto.dll`, and `zlib1.dll` are found by the Windows loader:

```typescript
const childEnv = {
  ...process.env,
  PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ""}`,
};
```

### Credential Store (Unchanged)

Only four fields are persisted — no secret material:
```typescript
interface StoredCredentialMetadata {
  credentialId: string;  // hex string — public identifier only
  rpId: string;
  displayName: string;
  createdAt: string;     // ISO 8601
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Vendor Detection Routing

*For any* set of HID device entries containing at least one entry whose `vendorId` is a member of `KNOWN_FIDO2_VENDORS`, when `NodeHidHardwareIdentityProvider.listDevices()` is called on Windows with the FIDO usage-page filter returning zero results, the provider SHALL attempt to delegate to `Fido2CliHardwareIdentityProvider` rather than returning an empty array immediately.

**Validates: Requirements 2.2, 13.1, 13.2**

### Property 2: Empty-Vendor No-Delegation

*For any* set of HID device entries where no entry's `vendorId` is a member of `KNOWN_FIDO2_VENDORS`, `NodeHidHardwareIdentityProvider.listDevices()` SHALL return an empty array without instantiating or calling any Windows provider.

**Validates: Requirements 2.4, 13.1**

### Property 3: fido2-cred stdin line order

*For any* valid `EnrollmentOptions` (varying `rpId`, `userName`, `userId`, `userDisplayName`), when `Fido2CliHardwareIdentityProvider.createCredential()` writes to the CLI stdin (captured via a `spawnCli` stub), the non-empty lines SHALL appear in the order `[clientData, rpId, userName, userIdBase64]` — with `userName` at index 2 and `userId` at index 3.

**Validates: Requirements 3.1**

### Property 4: fido2-cred credentialId parsed from line 4

*For any* `fido2-cred` stdout string with 5 or more non-empty lines, the `credentialId` returned by `createCredential()` SHALL be the base64-decoded bytes of the line at index 4.

**Validates: Requirements 3.2**

### Property 5: fido2-assert stdin line order

*For any* valid `AssertionOptions` (varying `rpId`, `credentialId`, `hmacSalt`), when `Fido2CliHardwareIdentityProvider.getAssertion()` writes to the CLI stdin (captured via a `spawnCli` stub), the non-empty lines SHALL appear in the order `[clientData, rpId, credentialIdBase64, hmacSaltBase64]`.

**Validates: Requirements 4.1**

### Property 6: fido2-assert hmacSecret line disambiguation

*For any* `fido2-assert` stdout string with exactly 5 non-empty lines, `hmacOutput` SHALL be decoded from line index 4. *For any* stdout string with 6 or more non-empty lines, `hmacOutput` SHALL be decoded from line index 5.

**Validates: Requirements 4.2, 4.3**

### Property 7: PRF_SALT_CONSTANT immutability

*For any* number of calls to `DerivationService.deriveWallet()`, the bytes of `PRF_SALT_CONSTANT` after all calls complete SHALL equal the bytes before any call began.

**Validates: Requirements 6.4**

### Property 8: Derivation Determinism (existing — extend to cover Req 8.1)

*For any* 32-byte `Uint8Array` used as `PRF_Output`, calling `DerivationService.deriveFromPrfOutput()` twice with the same input SHALL return the same wallet address.

**Validates: Requirements 8.1, 15.1** *(already exists as Property 1 in `derivation.property.test.ts` — verify annotation is updated)*

### Property 9: Derivation Injectivity (existing — extend to cover Req 8.4)

*For any* two distinct 32-byte `Uint8Array` values `a ≠ b`, `deriveFromPrfOutput(a)` SHALL return a different wallet address than `deriveFromPrfOutput(b)`.

**Validates: Requirements 8.4, 15.2** *(already exists as Property 2 — verify annotation)*

### Property 10: PRF_Output zeroization

*For any* 32-byte `PRF_Output` passed to `DerivationService.deriveWallet()` via `MockHardwareIdentityProvider`, after the call returns (success or failure), the `hmacOutput` field of the `AssertionResult` returned by the mock SHALL have all bytes equal to zero.

**Validates: Requirements 9.1, 15.3**

### Property 11: MockHardwareIdentityProvider round-trip determinism

*For any* valid credential ID byte sequence, calling `MockHardwareIdentityProvider.getAssertion()` twice with the same `credentialId` on the same instance SHALL return identical `hmacOutput` bytes, and applying `DerivationService.deriveWallet()` to each result SHALL yield the same wallet address.

**Validates: Requirements 15.4, 24.5**

## Error Handling

### CLI Exit Code Handling

```
spawnCli() outcome             → Action
────────────────────────────────────────────────────────────────
exit code 0                   → parse stdout; throw if format invalid
exit code non-zero             → mapStderrToCtapError(stderr, exitCode)
spawn() throws                → CtapError("UNKNOWN", "Failed to start…")
timeout (60s)                 → CtapError("CTAP2_ERR_OPERATION_DENIED", "timed out")
```

### CLI Output Validation

```
fido2-cred: lines.length < 5  → CtapError("UNKNOWN", includes actual count + first 200 chars stdout)
fido2-assert: lines.length < 5 → CtapError("UNKNOWN", includes actual count)
hmacBuf.length !== 32          → hmacBuf.fill(0); CtapError("UNKNOWN", includes actual length)
CLI executable not found       → CtapError("UNKNOWN", includes full resolved path)
```

### DerivationService Error Flow

```
getAssertion() throws CtapError   → return { kind: "authenticator-error", ctapCode: err.code }
signal.aborted before/after call  → return { kind: "user-cancelled" }
Any other exception               → return { kind: "authenticator-error", ctapCode: "UNKNOWN" }
```

DerivationService never throws — it always returns a typed discriminated union. The `finally` block that zeroes `hmacOutput` and `walletSeed` runs in all cases.

### Secret Buffer Zeroing Policy

Every sensitive buffer follows this pattern exactly — no exceptions:

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

The `hmacBuf` in `Fido2CliHardwareIdentityProvider.getAssertion()` is zeroed immediately after `hmacOutput.set(hmacBuf)` — before the method returns. This is best-effort: the stdout pipe buffer backing the original string is not under our control.

## Testing Strategy

### Unit Tests — CLI Format (`test/unit/Fido2CliProvider.test.ts`)

All CLI format tests use a `spawnCli` stub — the real subprocess is never invoked in tests. The stub is injected by making `spawnCli` an overridable method (or via `vi.spyOn`).

**Test 1 — createCredential stdin order:**
Create `Fido2CliHardwareIdentityProvider`, stub `spawnCli` to capture the `stdinData` arg and return a valid 6-line stdout. Call `createCredential()` with varied options. Assert stdin split by `\n` has `[clientData, rpId, userName, userIdB64]` at indices 0–3.

**Test 2 — createCredential reads credentialId from line 4:**
Stub returns stdout with known base64 at line 4. Assert returned `credentialId` decodes to expected bytes.

**Test 3 — createCredential throws when stdout < 5 lines:**
Stub returns 0, 1, 2, 3, and 4-line stdout variants. Assert each throws `CtapError("UNKNOWN")`.

**Test 4 — getAssertion stdin order:**
Stub captures stdin. Call `getAssertion()`. Assert lines are `[clientData, rpId, credIdB64, hmacSaltB64]`.

**Test 5 — getAssertion reads hmacSecret from line 5 (6-line output):**
Stub returns 6-line stdout with known base64 at line 5. Assert `hmacOutput` matches.

**Test 6 — getAssertion reads hmacSecret from line 4 (5-line output):**
Stub returns 5-line stdout with known base64 at line 4. Assert `hmacOutput` matches.

**Test 7 — getAssertion throws and zeroes on non-32-byte hmac:**
Stub returns base64 of a 16-byte value. Assert `CtapError("UNKNOWN")` is thrown and that the error message includes "16".

**Test 8 — discoverCredentials never spawns CLI:**
Spy on `spawnCli`. Call `discoverCredentials()`. Assert spy not called and result is `{ credentials: [] }`.

**Test 9 — -es256 flag present in fido2-cred invocation:**
Stub captures the `args` array. Assert `"es256"` appears in `args`.

**Test 10 — path resolution dev mode:**
Mock `app.isPackaged = false`, `app.getAppPath()` returns `"/project"`. Assert `getCliDir()` returns path containing `"/project"` and the relative `libfido2-win/...` suffix.

**Test 11 — path resolution packaged mode:**
Mock `app.isPackaged = true`, `process.resourcesPath = "/app/resources"`. Assert `getCliDir()` returns path containing `"/app/resources"`.

**Test 12 — CLI PATH prepended:**
Stub `childProcess.spawn`, capture the `options.env.PATH`. Assert it starts with the resolved `cliDir`.

### Property Tests (`test/property/hardware-derivation.property.test.ts`)

Uses `fast-check` with `numRuns: 100` minimum. All tests use `MockHardwareIdentityProvider` — no real hardware.

**Property 3 — fido2-cred stdin line order** (Req 14.1):
`fc.record({ rpId: fc.string(), userName: fc.string(), userId: fc.uint8Array({ minLength: 1, maxLength: 64 }) })` → for each generated input, capture stdin from stubbed `createCredential`, assert line order.

**Property 5 — fido2-assert stdin line order** (Req 14.2):
`fc.record({ credentialId: fc.uint8Array({ minLength: 1, maxLength: 64 }), hmacSalt: fc.uint8Array({ minLength: 32, maxLength: 32 }) })` → assert line order.

**Property 10 — PRF_Output zeroization** (Req 15.3):
`fc.uint8Array({ minLength: 32, maxLength: 32 })` as `prfOutput`. Seed mock with it. After `deriveWallet()` returns, check `hmacOutput.every(b => b === 0)`.

**Property 11 — Mock round-trip determinism** (Req 15.4):
`fc.uint8Array({ minLength: 1, maxLength: 64 })` as `credentialId`. Call `getAssertion()` twice on same mock instance. Assert `hmacOutput` arrays are equal byte-for-byte. Apply `deriveWallet()` twice. Assert addresses equal.

*Existing properties 1, 2, 7 in `derivation.property.test.ts` are already correct — update their annotation comments to also reference `hardware-integration-audit` requirement numbers.*

### Integration Tests (`test/integration/enrollment-derivation.integration.test.ts`)

Uses `MockHardwareIdentityProvider` and `InMemoryCredentialStore`.

**Test 1** — `EnrollmentService.enroll()` → `DerivationService.deriveWallet()` returns non-null Base58 wallet address.

**Test 2** — Same credentialId called twice on same mock → same wallet address.

**Test 3** — Two different credentialIds → different wallet addresses.

**Test 4** — AbortSignal aborted before `getAssertion` → `deriveWallet()` returns `{ kind: "user-cancelled" }`.

### Failure Injection Tests (`test/integration/failure-injection.integration.test.ts`)

Uses `MockHardwareIdentityProvider` configured to throw specific `CtapError` instances.

**Test 1** — `CTAP2_ERR_PIN_BLOCKED` from `createCredential` → `EnrollmentError` with `category === "pin-locked"`.

**Test 2** — `CTAP2_ERR_KEY_STORE_FULL` from `createCredential` → `EnrollmentError` with `category === "storage-full"`.

**Test 3** — `authenticatorAttachment: "platform"` from `createCredential` → `EnrollmentError` with `category === "enrollment-failed"`.

**Test 4** — `CTAP2_ERR_OPERATION_DENIED` from `getAssertion` → `deriveWallet()` returns `{ kind: "authenticator-error" }`.

**Test 5** — AbortSignal aborted mid-call → `deriveWallet()` returns `{ kind: "user-cancelled" }`.

### Diagnostic Scripts Design (`scripts/`)

All scripts are TypeScript, compiled with `ts-node` (or `tsx`) — no separate build step for diagnostics.

**`scripts/hardware-diagnose.ts`:**
1. Import `NodeHidHardwareIdentityProvider` directly (no Electron `app` in script context).
2. For script context, substitute a minimal `app` shim: `{ isPackaged: false, getAppPath: () => process.cwd() }`.
3. Call `listDevices()`, print each device's path, extensions, hmac-secret flag, resident-key flag, clientPin flag.
4. Check `fido2-assert.exe` exists at resolved path; print path and exit 1 if not.
5. If no devices, print "No FIDO2 device detected" and exit 1.
6. Exit 0 on success.

**`scripts/hardware-test.ts`:**
1. Uses test RP ID `"key-wallet-test.local"` to avoid touching production credentials.
2. Steps: listDevices → authenticatorGetInfo check → createCredential (hmac-secret + resident key) → getAssertion → hkdfSync → Keypair.fromSeed → print wallet address.
3. Each step prints "PASS" or "FAIL: <reason>".
4. Zeroes all secret buffers in `finally` blocks.
5. Does NOT print PRF_Output, walletSeed, or secretKey bytes.
6. Exit 0 if all steps pass, non-zero otherwise.

**`scripts/diagnostics.ts`:**
1. Spawns `hardware-diagnose.ts` via `ts-node`, captures output.
2. Spawns `hardware-test.ts` via `ts-node`, captures output.
3. Writes combined output to `logs/hardware-diagnostics.txt` (creates `logs/` dir if absent).
4. Prints output to console as well.
5. Exit code = max of both child exit codes.

**`scripts/hardware-acceptance-test.ts`:**
Full real-hardware acceptance test. Structure matches `hardware-test.ts` but targets a real device, prints pass/fail per step, and exits with appropriate code. Never prints secret bytes.

### Annotation Convention

All new property tests follow the convention from `testing.md`:

```typescript
// Feature: hardware-integration-audit, Property N: <name>
// Validates: Requirements X.Y
```

### Test File Summary

| File | Type | Tests Added |
|---|---|---|
| `test/unit/Fido2CliProvider.test.ts` | Unit | 12 tests covering CLI format (Req 14) |
| `test/property/hardware-derivation.property.test.ts` | Property | Properties 3, 5, 10, 11 (Req 15 gaps) |
| `test/integration/enrollment-derivation.integration.test.ts` | Integration | 4 tests (Req 16) |
| `test/integration/failure-injection.integration.test.ts` | Integration | 5 tests (Req 17) |

Existing test files are not modified except for annotation updates in `test/property/derivation.property.test.ts` (add `hardware-integration-audit` cross-references to existing properties 1 and 2).

## Audit Process Design (`docs/hardware-audit.md`)

The audit document is produced by manual inspection + automated grep passes. The following grep patterns identify the areas the auditor must examine before writing any code:

```bash
# Find all hmac-secret callers
grep -rn "hmac.secret\|hmacSecret\|hmacSalt\|PRF_Output\|prfOutput" src/

# Find all subprocess spawns
grep -rn "spawn\|execFile\|exec(" src/

# Find any @vaultys/webauthn-node imports
grep -rn "vaultys\|webauthn-node" src/

# Find all secret buffer handling
grep -rn "\.fill(0)\|fill(0)\|walletSeed\|keypair\.secretKey" src/

# Find __dirname usage (path resolution risk)
grep -rn "__dirname\|__filename" src/

# Find all console.log in derivation/hardware paths (secret leak risk)
grep -rn "console\." src/main/hardware/ src/main/derivation/

# Find all fido2-assert/fido2-cred invocations
grep -rn "fido2-assert\|fido2-cred\|fido2-token" src/
```

The audit report structure (sections in `docs/hardware-audit.md`):
1. Executive summary
2. File-by-file analysis (status, known defects, test coverage gaps)
3. Known input-format bugs (userName/userId order, stdout line index, discoverCredentials timeout)
4. Provider comparison table (platform support × capability matrix)
5. "Untested against hardware" paths list
6. Recommended fix order
