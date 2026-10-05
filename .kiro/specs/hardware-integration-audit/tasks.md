# Implementation Plan: Hardware Integration Audit

## Overview

This plan repairs and verifies the end-to-end FIDO2 hardware path from a physical YubiKey to a Solana devnet wallet on Windows. It proceeds in strict phase order: audit documentation first, then code fixes, then tests, then packaging and real-hardware verification. No code changes are made until the audit document exists.

## Tasks

- [x] 1. Phase 1 — Audit documentation (no code changes)
  - [x] 1.1 Inspect all hardware and derivation source files using the grep patterns from the design doc
    - Run grep patterns against: `Fido2CliHardwareIdentityProvider.ts`, `NodeHidHardwareIdentityProvider.ts`, `Libfido2HardwareIdentityProvider.ts`, `MockHardwareIdentityProvider.ts`, `DerivationService.ts`, `EnrollmentService.ts`, `DeviceMonitor.ts`, and all files under `src/main/hardware/ctap2/`
    - Patterns to run: hmac-secret callers, subprocess spawns, `@vaultys/webauthn-node` imports, secret buffer handling (`.fill(0)`), `__dirname` usage, `console.*` in hardware/derivation paths, fido2-assert/fido2-cred/fido2-token invocations
    - Record each finding (defect description, file, line range, whether a test currently catches it)
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Create `docs/hardware-audit.md` with all six required sections
    - Section 1: Executive summary
    - Section 2: File-by-file analysis — implementation status, known defects, test coverage gap for each file listed in Req 1.1
    - Section 3: Known input-format bugs — wrong `userId`/`userName` order, wrong stdout line index for credential ID, `discoverCredentials` timeout from `fido2-assert -G -r`
    - Section 4: Provider comparison table — platform, resident key support, hmac-secret support for each provider
    - Section 5: Paths never executed against real hardware ("untested against hardware" label)
    - Section 6: Recommended fix order
    - File must exist and be committed before any code fix task begins
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.3 Create `docs/hardware-test-matrix.md`
    - Table rows: each tested authenticator model
    - Table columns: OS platform, node-hid direct access, `windows://hello` via fido2 CLI, `createCredential` with resident key, `getAssertion` with hmac-secret, full derivation flow result
    - Include entry for YubiKey 5C NFC on Windows 10 1903+ via `windows://hello`
    - Mark operations tested with mock-only using "mock only" label
    - _Requirements: 21.1, 21.2, 21.3_

- [x] 2. Phase 3 — Fix `Fido2CliHardwareIdentityProvider.ts`
  - [x] 2.1 Fix `createCredential()` stdin line order: write `userName` at line index 2 and `userIdBase64` at line index 3
    - Correct order is `[clientDataBase64, rpId, userName, userIdBase64]` — userName before userId
    - Previous code had userId before userName, causing `fido2-cred` to reject or mis-enroll
    - Verify the `-M -h -r -v -w -i <file> windows://hello es256` flags are all present
    - Verify `-es256` flag is included in the args array
    - _Requirements: 3.1, 3.4_

  - [x] 2.2 Fix `createCredential()` stdout parsing: read `credentialId` from line index 4 (zero-based)
    - If stdout has fewer than 5 lines, throw `CtapError("UNKNOWN")` with the actual line count and first 200 chars of stdout
    - _Requirements: 3.2, 3.3_

  - [x] 2.3 Verify and fix `getAssertion()` stdin line order and stdout hmacSecret disambiguation
    - Stdin must be `[clientDataBase64, rpId, credentialIdBase64, hmacSaltBase64]` in that exact order
    - Stdout disambiguation: `if (lines.length >= 6) { hmacLineIndex = 5 } else { hmacLineIndex = 4 }`
    - If decoded hmac buffer is not exactly 32 bytes: zero the buffer, then throw `CtapError("UNKNOWN")` with the actual byte length
    - Zero the intermediate parse `Buffer` immediately after copying into the returned `Uint8Array`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 2.4 Verify `discoverCredentials()` returns empty result without spawning any subprocess
    - Must return `{ credentials: [] }` without calling `spawnCli` or any `fido2-assert -G -r` invocation
    - _Requirements: 5.1, 5.2_

  - [x] 2.5 Fix path resolution to use `app.getAppPath()` / `process.resourcesPath` instead of `__dirname`
    - Dev mode (`app.isPackaged === false`): `path.join(app.getAppPath(), "libfido2-win/libfido2-1.15.0-win/Win64/Release/v143/dynamic")`
    - Packaged mode (`app.isPackaged === true`): `path.join(process.resourcesPath, "libfido2-win/libfido2-1.15.0-win/Win64/Release/v143/dynamic")`
    - Prepend resolved `cliDir` to child process `PATH` via `{ ...process.env, PATH: \`\${cliDir}\${path.delimiter}\${process.env.PATH ?? ""}\` }`
    - _Requirements: 11.1, 11.2, 11.3_

  - [x] 2.6 Add CLI executable existence check with actionable error message
    - Before spawning any subprocess, verify the executable file exists at the resolved path
    - If missing, throw `CtapError("UNKNOWN")` with a message containing the full resolved path
    - _Requirements: 11.4_

- [x] 3. Phase 4 — Diagnostic tooling
  - [x] 3.1 Create `scripts/hardware-diagnose.ts`
    - Import `NodeHidHardwareIdentityProvider` with a minimal `app` shim: `{ isPackaged: false, getAppPath: () => process.cwd() }`
    - Call `listDevices()`, print each device's path, extensions, hmac-secret flag, resident-key flag, clientPin flag
    - Check `fido2-assert.exe` exists at the resolved path; print path and exit 1 if not found
    - If no devices found, print "No FIDO2 device detected" and exit 1
    - Exit 0 on success
    - _Requirements: 12.1, 12.4, 12.5_

  - [x] 3.2 Create `scripts/hardware-test.ts`
    - Use test RP ID `"key-wallet-test.local"` to avoid touching production credentials
    - Steps in sequence: `listDevices()` → `authenticatorGetInfo` check → `createCredential()` with hmac-secret + resident key → `getAssertion()` → `hkdfSync` → `Keypair.fromSeed()` → print wallet address
    - Each step prints "PASS" or "FAIL: <reason>"
    - Zero all secret buffers in `finally` blocks
    - Must NOT print `PRF_Output`, `walletSeed`, or `secretKey` bytes
    - Exit 0 if all steps pass, non-zero otherwise
    - _Requirements: 12.2, 18.5_

  - [x] 3.3 Create `scripts/diagnostics.ts`
    - Spawn `hardware-diagnose.ts` via `ts-node` or `tsx`, capture output
    - Spawn `hardware-test.ts` via `ts-node` or `tsx`, capture output
    - Write combined output to `logs/hardware-diagnostics.txt` (create `logs/` dir if absent)
    - Print output to console as well
    - Exit code = max of both child exit codes
    - _Requirements: 12.3_

  - [x] 3.4 Create `scripts/hardware-acceptance-test.ts`
    - Full real-hardware acceptance test targeting a real device
    - Steps: device detection, `authenticatorGetInfo` check, credential creation with hmac-secret + resident key flags, PRF assertion, HKDF derivation, Solana address output
    - Use test RP ID `"key-wallet-test.local"`
    - Print wallet address and Base58 public key on full pass; exit code 0
    - Print failing step name, error category, and raw error message on failure; exit non-zero
    - Must NOT print or write `PRF_Output`, `Wallet_Seed`, or private key bytes
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [x] 3.5 Add npm scripts to `package.json`: `hardware:diagnose`, `hardware:test`, `diagnostics`
    - `"hardware:diagnose": "tsx scripts/hardware-diagnose.ts"`
    - `"hardware:test": "tsx scripts/hardware-test.ts"`
    - `"diagnostics": "tsx scripts/diagnostics.ts"`
    - _Requirements: 12.1, 12.2, 12.3_

- [x] 4. Phase 5 — Test suite
  - [x] 4.1 Create `test/unit/Fido2CliProvider.test.ts` with all 12 unit tests
    - All tests use a `spawnCli` stub — real subprocess is never invoked
    - Test 1: `createCredential()` stdin line order is `[clientData, rpId, userName, userIdB64]`
    - Test 2: `createCredential()` reads `credentialId` from stdout line index 4
    - Test 3: `createCredential()` throws `CtapError("UNKNOWN")` when stdout has fewer than 5 lines (test 0, 1, 2, 3, 4-line variants)
    - Test 4: `getAssertion()` stdin line order is `[clientData, rpId, credIdB64, hmacSaltB64]`
    - Test 5: `getAssertion()` reads `hmacSecret` from line index 5 when stdout has 6 lines
    - Test 6: `getAssertion()` reads `hmacSecret` from line index 4 when stdout has 5 lines
    - Test 7: `getAssertion()` throws `CtapError("UNKNOWN")` and zeroes buffer when hmac is not 32 bytes; error message includes actual length
    - Test 8: `discoverCredentials()` never calls `spawnCli`
    - Test 9: `-es256` flag is present in `fido2-cred` args array
    - Test 10: path resolution dev mode — `app.isPackaged = false`, `app.getAppPath()` returns `"/project"`, resolved path contains `"/project"` and the libfido2 relative suffix
    - Test 11: path resolution packaged mode — `app.isPackaged = true`, `process.resourcesPath = "/app/resources"`, resolved path contains `"/app/resources"`
    - Test 12: child process `PATH` starts with resolved `cliDir`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 4.2 Create `test/property/hardware-derivation.property.test.ts` with Properties 3, 5, 10, 11
    - All properties use `MockHardwareIdentityProvider` and `fc.uint8Array({ minLength: 32, maxLength: 32 })` as the arbitrary; `numRuns: 100` minimum
    - Property 3 (fido2-cred stdin order, Req 14.1): generate `{ rpId, userName, userId }` via `fast-check`, capture stdin from stubbed `createCredential`, assert line order
      - Annotation: `// Feature: hardware-integration-audit, Property 3: fido2-cred stdin line order`
      - `// Validates: Requirements 3.1`
    - Property 5 (fido2-assert stdin order, Req 14.2): generate `{ credentialId, hmacSalt }`, assert line order
      - Annotation: `// Feature: hardware-integration-audit, Property 5: fido2-assert stdin line order`
      - `// Validates: Requirements 4.1`
    - Property 10 (PRF_Output zeroization, Req 15.3): after `deriveFromPrfOutput()` returns, assert every byte of the internal `hmacOutput` copy equals zero
      - Annotation: `// Feature: hardware-integration-audit, Property 10: PRF_Output zeroization`
      - `// Validates: Requirements 9.1, 15.3`
    - Property 11 (mock round-trip determinism, Req 15.4): same `credentialId` on same mock instance returns identical `hmacOutput` bytes; applying `deriveWallet()` twice yields same address
      - Annotation: `// Feature: hardware-integration-audit, Property 11: MockHardwareIdentityProvider round-trip determinism`
      - `// Validates: Requirements 15.4, 24.5`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 4.3 Create `test/integration/enrollment-derivation.integration.test.ts` with 4 tests
    - Uses `MockHardwareIdentityProvider` and `InMemoryCredentialStore`; no real hardware
    - Test 1: `EnrollmentService.enroll()` → `DerivationService.deriveWallet()` returns non-null Base58 wallet address
    - Test 2: same `credentialId` on same mock instance called twice → same wallet address both times
    - Test 3: two different `credentialId` values on same mock instance → different wallet addresses
    - Test 4: `AbortSignal` aborted before `getAssertion` is called → `deriveWallet()` returns `{ kind: "user-cancelled" }`
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

  - [x] 4.4 Create `test/integration/failure-injection.integration.test.ts` with 5 tests
    - Uses `MockHardwareIdentityProvider` configured to throw specific `CtapError` instances
    - Test 1: `CTAP2_ERR_PIN_BLOCKED` from `createCredential()` → `EnrollmentService.enroll()` throws `EnrollmentError` with `category === "pin-locked"`
    - Test 2: `CTAP2_ERR_KEY_STORE_FULL` from `createCredential()` → `EnrollmentError` with `category === "storage-full"`
    - Test 3: `authenticatorAttachment: "platform"` from `createCredential()` → `EnrollmentError` with `category === "enrollment-failed"`
    - Test 4: `CTAP2_ERR_OPERATION_DENIED` from `getAssertion()` → `deriveWallet()` returns `{ kind: "authenticator-error" }`
    - Test 5: `AbortSignal` aborted mid-call → `deriveWallet()` returns `{ kind: "user-cancelled" }`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x] 4.5 Update annotation comments in `test/property/derivation.property.test.ts`
    - Add `hardware-integration-audit` cross-reference to existing Property 1 (Determinism): append `// Also validates: hardware-integration-audit Requirements 8.1, 15.1`
    - Add `hardware-integration-audit` cross-reference to existing Property 2 (Injectivity): append `// Also validates: hardware-integration-audit Requirements 8.4, 15.2`
    - Do not modify test logic, only annotation comments
    - _Requirements: 24.4_

- [x] 5. Phase 5 checkpoint — Ensure all tests pass
  - Run `npm test` and confirm all unit, property, and integration tests pass. Ask the user if any questions arise.

- [x] 6. Phase 6 — Packaging verification
  - [x] 6.1 Verify `libfido2-win` is present in the `build.files` array in `package.json`
    - Must include `"libfido2-win/**/*"` so CLI tools are copied into packaged resources
    - Add the entry if missing
    - _Requirements: 19.1, 19.2_

  - [x] 6.2 Verify `asarUnpack` in `package.json` includes `node-hid` and `@vaultys/webauthn-node`
    - `asarUnpack` must include `"**/node_modules/node-hid/**"` so the native binary is loaded from `app.asar.unpacked`
    - Add entries if missing
    - _Requirements: 19.5_

  - [x] 6.3 Verify startup check: application warns at startup if `fido2-assert.exe` is missing at resolved path
    - Confirm there is a startup-time existence check in the main process that logs a warning if the CLI tools are absent
    - Add the check in `src/main/index.ts` (or appropriate entry point) if missing
    - _Requirements: 19.3_

- [ ] 7. Phase 7 — Real hardware verification (manual)
  - [x] 7.1 Run `npm run hardware:diagnose` with YubiKey plugged in and confirm output shows device path, extensions, and hmac-secret support flag
    - _Requirements: 12.1, 13.1, 13.2_

  - [x] 7.2 Run `npm run hardware:test` with YubiKey plugged in and confirm all steps print "PASS"
    - _Requirements: 12.2_

  - [ ] 7.3 Run the full app (`npm start`), enroll a credential, verify a wallet address appears in the UI
    - _Requirements: 25.1, 25.2_

  - [ ] 7.4 Restart the app, re-insert the same YubiKey, and confirm the same wallet address is derived (determinism check)
    - _Requirements: 8.1, 8.2, 25.3_

- [x] 8. Phase 8 — Documentation
  - [x] 8.1 Create `docs/security-audit.md`
    - List every location in the codebase where `PRF_Output`, `Wallet_Seed`, or `keypair.secretKey` is created, read, transformed, or zeroed
    - For each location: file path, line range, which secret is handled, whether zeroed in a `finally` block, whether passed over IPC or written to a log
    - Explicitly confirm no log statement contains secret bytes
    - Explicitly confirm `credential:discover` IPC response contains only `credentialId` (hex) and `userDisplayName` (string)
    - _Requirements: 22.1, 22.2, 22.3, 22.4_

  - [x] 8.2 Update `README.md` to describe the Windows FIDO2 path and YubiKey setup instructions
    - Describe: OS HID claim → vendor ID detection → `Fido2CliHardwareIdentityProvider` → `windows://hello` → libfido2 CLI subprocess
    - Add YubiKey 5C NFC setup steps: setting a PIN, enrolling a credential, unlocking a session, removing the key to terminate
    - _Requirements: 23.1, 23.2_

  - [x] 8.3 Update `.kiro/steering/security.md` to reflect confirmed secret-handling patterns
    - Add or confirm the zero-in-finally rule with the exact code pattern from the design doc
    - Note the best-effort caveat for stdout pipe buffer
    - Only update to add information or correct inaccuracies; do not remove existing content
    - _Requirements: 24.2_

  - [x] 8.4 Update `.kiro/steering/architecture.md` to reflect the current active provider set
    - Document that `Fido2CliHardwareIdentityProvider` is the sole active Windows provider
    - Document that `@vaultys/webauthn-node` is present as a dependency but is NOT used for hmac-secret operations
    - Only update to add information or correct inaccuracies; do not remove existing content
    - _Requirements: 23.3, 24.2_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Phase 1 (tasks 1.x) must be fully complete before Phase 3 (tasks 2.x) begins — the audit doc is a gate
- Phase 3 (tasks 2.x) and Phase 4 (tasks 3.x) and Phase 5 (tasks 4.x) can proceed in parallel once Phase 1 is done
- Phase 5 tests (4.1–4.4) are written against the fixed implementation from Phase 3; they must pass once 2.x is complete
- Phase 6 packaging checks (6.x) depend on Phase 3 fixes
- Phase 7 real hardware tasks (7.x) require Phase 3, 4, and 6 to be complete
- Phase 8 documentation (8.x) can be written any time after Phase 3 but should reflect final verified state
- `docs/hardware-audit.md` created in task 1.2 is the authoritative record; Phase 2 architecture is already decided (CLI subprocess via windows://hello) and should be recorded there
- Property tests in 4.2 are separate from the existing `derivation.property.test.ts`; task 4.5 only updates annotations in that existing file, not test logic

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.4", "2.5", "3.1", "3.2", "4.1", "4.2", "4.3", "4.4", "4.5"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.3", "3.4", "3.5"] },
    { "id": 4, "tasks": ["2.6"] },
    { "id": 5, "tasks": ["6.1", "6.2", "6.3", "8.1", "8.2", "8.3", "8.4"] },
    { "id": 6, "tasks": ["7.1", "7.2"] },
    { "id": 7, "tasks": ["7.3"] },
    { "id": 8, "tasks": ["7.4"] }
  ]
}
```
