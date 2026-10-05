# Requirements Document

## Introduction

This spec governs a structured audit and repair of the KeyWallet hardware integration layer.
The goal is to reach a single, verified, end-to-end path:

```
Physical FIDO2 security key (YubiKey 5C NFC, firmware 5.7.4)
  → CTAP2 resident credential (rpId = "key-wallet.local")
  → hmac-secret extension → 32-byte deterministic PRF_Output
  → HKDF-SHA256 (info = "key-wallet:solana:ed25519:v1") → 32-byte Ed25519 seed
  → Solana keypair → wallet address → devnet interaction
```

After multiple incremental patching rounds the integration is still unreliable.
This spec mandates a formal audit pass, exact correctness requirements, mandatory diagnostic
tooling, a comprehensive test suite, a self-contained packaging requirement, and documentation
deliverables — all before further code changes are made.

All requirements in this document are independent of the existing `key-wallet` spec.

---

## Glossary

- **Audit_Report**: The file `docs/hardware-audit.md` produced by Requirement 1.
- **CTAP2**: Client to Authenticator Protocol version 2 — the wire protocol spoken over USB HID or NFC between the application and a FIDO2 authenticator.
- **Credential_ID**: The opaque byte string identifying a specific FIDO2 resident credential on the authenticator.
- **DerivationService**: The TypeScript class `src/main/derivation/DerivationService.ts` responsible for orchestrating PRF derivation and HKDF.
- **DeviceMonitor**: The TypeScript class `src/main/device/DeviceMonitor.ts` responsible for polling connected FIDO2 devices.
- **Diagnostic_Runner**: The npm scripts `npm run hardware:diagnose`, `npm run hardware:test`, and `npm run diagnostics` required by Requirement 4.
- **EnrollmentService**: The TypeScript class `src/main/enrollment/EnrollmentService.ts`.
- **Fido2_CLI_Provider**: `Fido2CliHardwareIdentityProvider` — the provider that spawns the bundled `fido2-assert.exe` / `fido2-cred.exe` / `fido2-token.exe` subprocess tools.
- **HKDF**: HMAC-based Key Derivation Function, RFC 5869.
- **hmac-secret**: The CTAP2 extension that instructs the authenticator to compute `HMAC-SHA256(device_key, PRF_Salt)` and return the 32-byte result as `PRF_Output`.
- **IHardwareIdentityProvider**: The interface `src/main/hardware/IHardwareIdentityProvider.ts` that all hardware provider implementations must satisfy.
- **Info_String**: The HKDF `info` parameter `"key-wallet:solana:ed25519:v1"` encoded as UTF-8.
- **MockHardwareIdentityProvider**: The deterministic software mock at `test/mocks/MockHardwareIdentityProvider.ts`.
- **NodeHidHardwareIdentityProvider**: The provider class `src/main/hardware/NodeHidHardwareIdentityProvider.ts`.
- **PRF_Output**: The 32-byte value returned by the authenticator's hmac-secret extension for a given Credential_ID and PRF_Salt pair.
- **PRF_Salt**: The fixed 32-byte domain-separated constant `PRF_SALT_CONSTANT` defined in `src/main/derivation/hkdf.ts`, derived via HKDF-SHA256 from `"key-wallet-prf-salt-v1"`.
- **Provider**: Any concrete implementation of `IHardwareIdentityProvider`.
- **Wallet_Seed**: The 32-byte output of HKDF applied to `PRF_Output`; used as the Ed25519 seed.
- **Windows_Hello_Path**: The synthetic device path string `"windows://hello"` used by the libfido2 CLI on Windows to route through `webauthn.dll`.

---

## Requirements

---

### Requirement 1: Audit Documentation

**User Story:** As a developer, I want a complete written audit of every file in the hardware integration layer, so that all known defects, architectural deviations, and untested paths are visible before any code changes are made.

#### Acceptance Criteria

1. THE Audit_Report SHALL document the implementation status, known defects, and test coverage gap for each of the following source files: `Fido2CliHardwareIdentityProvider.ts`, `NodeHidHardwareIdentityProvider.ts`, `Libfido2HardwareIdentityProvider.ts`, `MockHardwareIdentityProvider.ts`, `DerivationService.ts`, `EnrollmentService.ts`, `DeviceMonitor.ts`, and every file under `src/main/hardware/ctap2/`.
2. THE Audit_Report SHALL record, for each known defect, the defect description, the file and line range where it occurs, and whether a test currently catches it.
3. THE Audit_Report SHALL identify every code path that claims to perform an hmac-secret assertion but has never been executed against real hardware, labelling each as "untested against hardware".
4. THE Audit_Report SHALL include a comparison table listing each Provider, its target platform, whether it supports `createCredential` with a resident key, and whether it supports `getAssertion` with the hmac-secret extension.
5. WHEN the Audit_Report is produced, THE Audit_Report SHALL also record the exact sequence of input-format bugs found during the investigation: wrong `userId`/`userName` order in `fido2-cred` stdin, wrong credential-ID line index in `fido2-cred` stdout, and the `discoverCredentials` timeout caused by `fido2-assert -G -r` triggering a user-interaction dialog.
6. THE Audit_Report SHALL be placed at `docs/hardware-audit.md` and committed before any code fix is applied.

---

### Requirement 2: Hardware Architecture — Windows FIDO2 Path

**User Story:** As a developer, I want a single, well-defined platform-specific code path for Windows FIDO2 hmac-secret operations, so that the OS HID claim on Windows 10 1903+ does not silently prevent key derivation.

#### Acceptance Criteria

1. THE System SHALL use `Fido2CliHardwareIdentityProvider` as the exclusive provider for all CTAP2 operations routed through the `windows://hello` device path.
2. WHEN `NodeHidHardwareIdentityProvider.listDevices()` is called on Windows and the FIDO HID usage-page filter returns zero devices, THE NodeHidHardwareIdentityProvider SHALL check the full HID device list for any vendor ID in the known FIDO2 vendor set before returning an empty result.
3. WHEN a known FIDO2 vendor ID is detected on Windows and no FIDO HID interface is accessible, THE NodeHidHardwareIdentityProvider SHALL delegate all subsequent `createCredential`, `getAssertion`, and `discoverCredentials` calls for the `windows://hello` path to `Fido2CliHardwareIdentityProvider`.
4. IF no known FIDO2 vendor ID is present in the HID device list on Windows, THEN THE NodeHidHardwareIdentityProvider SHALL return an empty device list without delegating to `Fido2CliHardwareIdentityProvider`.
5. THE System SHALL NOT instantiate `@vaultys/webauthn-node` for any operation that requires the hmac-secret extension, because the `@vaultys/webauthn-node` C++ binding does not implement hmac-secret in its `GetAssertion` path.
6. WHEN a `getAssertion` call is routed to `Fido2CliHardwareIdentityProvider`, THE Fido2CliHardwareIdentityProvider SHALL spawn `fido2-assert.exe` with the `-G -h -v -w -i <tmpfile>` flags and the `windows://hello` device path argument.
7. THE System SHALL NOT fall back to a software-derived wallet address under any error condition; IF `getAssertion` fails, THEN THE System SHALL return an error to the caller.

---

### Requirement 3: fido2-cred Input/Output Format Correctness

**User Story:** As a developer, I want the fido2-cred subprocess invocation to use the exact stdin format and output-line index that libfido2 1.15.0 specifies, so that enrollment does not fail due to malformed input or misread credential IDs.

#### Acceptance Criteria

1. WHEN `Fido2CliHardwareIdentityProvider.createCredential()` constructs the stdin payload for `fido2-cred -M -h -r -v -w`, THE Fido2_CLI_Provider SHALL write lines in the order: `clientDataBase64`, `rpId`, `userName`, `userIdBase64` — exactly matching the libfido2 1.15.0 `-M` input specification.
2. WHEN `Fido2CliHardwareIdentityProvider.createCredential()` parses the stdout of `fido2-cred -M -h -r -v -w`, THE Fido2_CLI_Provider SHALL read the credential ID from output line index 4 (zero-based), which carries the base64-encoded credential ID according to the libfido2 1.15.0 output specification.
3. IF `fido2-cred` stdout contains fewer than 5 lines, THEN THE Fido2_CLI_Provider SHALL throw a `CtapError` with code `"UNKNOWN"` and a message that includes the actual line count and the first 200 characters of stdout.
4. THE Fido2_CLI_Provider SHALL pass the `-es256` algorithm flag when invoking `fido2-cred`, matching the ES256 public key type required by the `windows://hello` path.

---

### Requirement 4: fido2-assert Input/Output Format Correctness

**User Story:** As a developer, I want the fido2-assert subprocess invocation to use the exact stdin format and hmac-secret output-line index that libfido2 1.15.0 specifies, so that key derivation reliably retrieves the 32-byte PRF_Output.

#### Acceptance Criteria

1. WHEN `Fido2CliHardwareIdentityProvider.getAssertion()` constructs the stdin payload for `fido2-assert -G -h -v -w`, THE Fido2_CLI_Provider SHALL write lines in the order: `clientDataBase64`, `rpId`, `credentialIdBase64`, `hmacSaltBase64`.
2. WHEN `fido2-assert` stdout contains 6 or more non-empty lines, THE Fido2_CLI_Provider SHALL read the HMAC secret from line index 5 (zero-based).
3. WHEN `fido2-assert` stdout contains exactly 5 non-empty lines, THE Fido2_CLI_Provider SHALL read the HMAC secret from line index 4 (zero-based), because `windows://hello` does not emit a user ID line for non-resident credential assertions.
4. IF the decoded HMAC secret buffer is not exactly 32 bytes, THEN THE Fido2_CLI_Provider SHALL zero the buffer, then throw a `CtapError` with code `"UNKNOWN"` and a message that includes the actual byte length.
5. WHEN the HMAC secret is decoded, THE Fido2_CLI_Provider SHALL zero the intermediate parse `Buffer` immediately after copying its contents into the returned `Uint8Array`.

---

### Requirement 5: discoverCredentials Non-Blocking Behaviour

**User Story:** As a developer, I want credential discovery to return results from the local store without triggering any hardware interaction or user-facing dialog, so that the app startup flow is not blocked by a Windows Hello security prompt.

#### Acceptance Criteria

1. WHEN `Fido2CliHardwareIdentityProvider.discoverCredentials()` is called, THE Fido2_CLI_Provider SHALL return an empty `DiscoveryResult` without spawning any subprocess.
2. THE System SHALL NOT call `fido2-assert -G -r` for passive credential discovery, because this flag combination triggers a Windows Hello user-interaction dialog.
3. WHEN the main process needs to display the list of available credentials, THE System SHALL read from the local `CredentialStore` via the `credential:discover` IPC handler rather than invoking hardware-level discovery.

---

### Requirement 6: Cryptographic Correctness — PRF_Salt

**User Story:** As a developer, I want the PRF_Salt constant to be computed by a deterministic, domain-separated derivation, so that it is consistent across machines and cannot accidentally collide with salts used by other applications.

#### Acceptance Criteria

1. THE System SHALL define a single `PRF_SALT_CONSTANT` of exactly 32 bytes, computed at module load time as `HKDF-SHA256(IKM=UTF-8("key-wallet-prf-salt-v1"), salt=<empty>, info=UTF-8("solana-wallet-derivation"), length=32)`.
2. THE System SHALL use `PRF_SALT_CONSTANT` as the `hmacSalt` in every call to `IHardwareIdentityProvider.getAssertion()`.
3. THE DerivationService SHALL NOT accept a caller-supplied salt; the salt is always `PRF_SALT_CONSTANT`.
4. WHEN `PRF_SALT_CONSTANT` is computed, THE value SHALL be treated as read-only; THE System SHALL NOT mutate it at runtime.

---

### Requirement 7: Cryptographic Correctness — HKDF

**User Story:** As a developer, I want the wallet seed derivation to follow a fully specified HKDF-SHA256 call, so that the derivation is reproducible and auditable.

#### Acceptance Criteria

1. WHEN `DerivationService.deriveWallet()` runs HKDF, THE DerivationService SHALL call `HKDF-SHA256` with `IKM = PRF_Output`, `salt = <empty 0-byte buffer>`, `info = UTF-8("key-wallet:solana:ed25519:v1")`, `length = 32`.
2. THE DerivationService SHALL use Node.js `hkdfSync` from `node:crypto` as the sole HKDF implementation.
3. THE DerivationService SHALL NOT apply any additional mixing, stretching, or transformation to `Wallet_Seed` before passing it to `Keypair.fromSeed()`.
4. THE DerivationService SHALL NOT accept a caller-supplied HKDF info string; the info string is always the constant `"key-wallet:solana:ed25519:v1"`.

---

### Requirement 8: Determinism

**User Story:** As a developer, I want the wallet address to be completely determined by the hardware key and the credential, so that the same physical key always produces the same Solana address regardless of which machine is running the app.

#### Acceptance Criteria

1. FOR ALL valid Credential_IDs stored in the CredentialStore, WHEN `DerivationService.deriveWallet()` is called twice with the same device and the same Credential_ID on the same machine without resetting the key, THE DerivationService SHALL return the same wallet address both times.
2. FOR ALL valid Credential_IDs stored in the CredentialStore, WHEN `DerivationService.deriveWallet()` is called on two different machines with the same physical key and the same Credential_ID, THE DerivationService SHALL return the same wallet address on both machines.
3. THE wallet address SHALL be independent of the machine hostname, operating system locale, Electron version, and Node.js version.
4. WHEN two different physical keys each hold credentials for the same `rpId`, THE DerivationService SHALL return different wallet addresses for each key.

---

### Requirement 9: Secret Material Lifetime

**User Story:** As a developer, I want all secret material to be zeroed as soon as it is no longer needed, so that PRF_Output and Wallet_Seed do not persist in process heap memory beyond the minimal required lifetime.

#### Acceptance Criteria

1. WHEN `DerivationService.deriveWallet()` completes — whether by success or exception — THE DerivationService SHALL zero the `PRF_Output` buffer using `.fill(0)` in a `finally` block.
2. WHEN `DerivationService.deriveWallet()` completes — whether by success or exception — THE DerivationService SHALL zero the `Wallet_Seed` buffer using `.fill(0)` in a `finally` block.
3. WHEN a session is terminated for any reason (user logout, device removal, app quit), THE SessionService SHALL zero the `keypair.secretKey` bytes using `.fill(0)` before deleting the session record.
4. THE System SHALL NOT pass `PRF_Output` or `Wallet_Seed` buffers across the IPC boundary to the renderer process.
5. THE System SHALL NOT write `PRF_Output`, `Wallet_Seed`, or `keypair.secretKey` bytes to any log, file, or persistent store.

---

### Requirement 10: No Software Fallback

**User Story:** As a developer, I want the application to refuse to derive a wallet when hardware is absent or when the hmac-secret extension is unavailable, so that no machine-specific entropy ever substitutes for hardware-backed derivation.

#### Acceptance Criteria

1. IF `IHardwareIdentityProvider.getAssertion()` throws any error, THEN THE DerivationService SHALL return a `DerivationError` and SHALL NOT attempt any alternative derivation path.
2. IF no FIDO2 device is detected, THEN THE System SHALL display a "no device" state to the user and SHALL NOT derive a wallet address.
3. THE System SHALL NOT implement, call, or permit any code path that derives a wallet address from machine-local secrets, environment variables, random bytes, or any input that is not produced by the hmac-secret extension.
4. IF the `hmac-secret` extension string is absent from `DeviceInfo.extensions`, THEN THE System SHALL mark the device as unsupported and SHALL NOT attempt `getAssertion` on that device.

---

### Requirement 11: CLI Tool Path Resolution

**User Story:** As a developer, I want the libfido2 CLI tool path to resolve correctly in both development and packaged builds, so that the subprocess invocation never fails due to a path resolution bug.

#### Acceptance Criteria

1. WHEN the app is running in development mode (`app.isPackaged === false`), THE Fido2_CLI_Provider SHALL resolve the CLI directory as `path.join(app.getAppPath(), "libfido2-win/libfido2-1.15.0-win/Win64/Release/v143/dynamic")`.
2. WHEN the app is running in a packaged build (`app.isPackaged === true`), THE Fido2_CLI_Provider SHALL resolve the CLI directory as `path.join(process.resourcesPath, "libfido2-win/libfido2-1.15.0-win/Win64/Release/v143/dynamic")`.
3. WHEN a CLI subprocess is spawned, THE Fido2_CLI_Provider SHALL prepend the resolved CLI directory to the child process `PATH` environment variable so that `fido2.dll`, `cbor.dll`, `crypto.dll`, and `zlib1.dll` can be located by the Windows DLL loader without a separate install step.
4. IF the CLI executable file does not exist at the resolved path, THEN THE Fido2_CLI_Provider SHALL throw a `CtapError` with code `"UNKNOWN"` and a message that includes the full resolved path.

---

### Requirement 12: Diagnostic Tooling

**User Story:** As a developer, I want dedicated npm scripts that report the hardware detection and derivation state without modifying any application data, so that hardware setup problems can be diagnosed quickly on any machine.

#### Acceptance Criteria

1. THE System SHALL expose an npm script `npm run hardware:diagnose` that, when executed, connects to the first available FIDO2 device, runs `authenticatorGetInfo`, and prints: device path, detected extensions, hmac-secret support flag, resident-key support flag, and clientPin flag — without performing any PRF derivation or modifying any stored credential.
2. THE System SHALL expose an npm script `npm run hardware:test` that, when executed against a real device with a pre-existing credential, runs the full enrollment-to-derivation flow in a sandboxed test credential namespace and prints pass/fail for each step: device detection, PIN check, credential creation, PRF assertion, HKDF, and wallet address output.
3. THE System SHALL expose an npm script `npm run diagnostics` that runs both `hardware:diagnose` and `hardware:test` in sequence and writes output to `logs/hardware-diagnostics.txt`.
4. WHEN `npm run hardware:diagnose` detects that `fido2-assert.exe` cannot be found at the resolved path, THE Diagnostic_Runner SHALL print the resolved path and exit with a non-zero exit code.
5. WHEN `npm run hardware:diagnose` is run on a machine with no FIDO2 device attached, THE Diagnostic_Runner SHALL print "No FIDO2 device detected" and exit with exit code 1.

---

### Requirement 13: Device Detection Accuracy

**User Story:** As a developer, I want device detection to reflect the presence of a real physical security key, so that the UI does not show a device as "CONNECTED" when no key is plugged in.

#### Acceptance Criteria

1. WHEN the HID device list contains no entry with a vendor ID in the known FIDO2 vendor set, THE NodeHidHardwareIdentityProvider SHALL NOT synthesize a `windows://hello` `DeviceInfo` entry.
2. WHEN the HID device list contains at least one entry with a vendor ID in the known FIDO2 vendor set, THE NodeHidHardwareIdentityProvider SHALL attempt to obtain `DeviceInfo` via `Fido2CliHardwareIdentityProvider.listDevices()` before deciding whether to include a `windows://hello` entry.
3. THE known FIDO2 vendor set SHALL include at minimum the vendor IDs: `0x1050` (Yubico), `0x096e` (Feitian), `0x2c97` (Ledger), `0x1ea8` (Nitrokey), `0x20a0` (SoloKeys), `0x0483` (STMicro), `0x10c4` (Silicon Labs).

---

### Requirement 14: Unit Tests — CLI Format

**User Story:** As a developer, I want unit tests that verify the exact stdin format and stdout parsing for all fido2-cred and fido2-assert invocations, so that any future regression in the subprocess format is caught immediately.

#### Acceptance Criteria

1. THE test suite SHALL include a unit test that exercises `Fido2CliHardwareIdentityProvider.createCredential()` against a mock `spawnCli` stub, asserts that the stdin lines are in the order `[clientData, rpId, userName, userIdBase64]`, and asserts that the returned `credentialId` is decoded from line index 4 of the mocked stdout.
2. THE test suite SHALL include a unit test that exercises `Fido2CliHardwareIdentityProvider.getAssertion()` against a mock `spawnCli` stub with a 6-line stdout, and asserts that `hmacOutput` is decoded from line index 5.
3. THE test suite SHALL include a unit test that exercises `Fido2CliHardwareIdentityProvider.getAssertion()` against a mock `spawnCli` stub with a 5-line stdout, and asserts that `hmacOutput` is decoded from line index 4.
4. THE test suite SHALL include a unit test that asserts that when `fido2-cred` stdout contains fewer than 5 lines, `createCredential()` throws a `CtapError` with code `"UNKNOWN"`.
5. THE test suite SHALL include a unit test that asserts that when the decoded HMAC buffer is not 32 bytes, `getAssertion()` throws a `CtapError` with code `"UNKNOWN"` and zeroes the buffer before throwing.

---

### Requirement 15: Property-Based Tests — Derivation

**User Story:** As a developer, I want property-based tests that verify the determinism and domain-separation invariants of the full derivation pipeline, so that regressions in any step of the pipeline are found by fast-check across 100+ input combinations.

#### Acceptance Criteria

1. THE property test suite SHALL include a determinism property: FOR ALL 32-byte `Uint8Array` values used as `PRF_Output`, calling `DerivationService.deriveFromPrfOutput()` twice with the same input SHALL return the same wallet address both times. This property SHALL run with a minimum of 100 fast-check iterations.
2. THE property test suite SHALL include a separation property: FOR ALL pairs of distinct 32-byte `Uint8Array` values `a` and `b` where `a !== b` byte-for-byte, `DerivationService.deriveFromPrfOutput(a)` SHALL return a different wallet address than `DerivationService.deriveFromPrfOutput(b)`. This property SHALL run with a minimum of 100 fast-check iterations.
3. THE property test suite SHALL include a zeroization property: FOR ALL 32-byte `PRF_Output` values, after `DerivationService.deriveFromPrfOutput()` returns, every byte of the internal `hmacOutput` copy SHALL equal zero. This property SHALL run with a minimum of 100 fast-check iterations.
4. THE property test suite SHALL include a round-trip property: FOR ALL valid `Credential_ID` byte sequences, `MockHardwareIdentityProvider.getAssertion()` called twice with the same `credentialId` SHALL return the same `hmacOutput` bytes, and applying `DerivationService.deriveWallet()` twice to those results SHALL return the same wallet address. This property SHALL run with a minimum of 100 fast-check iterations.
5. ALL property tests SHALL use `fc.uint8Array({ minLength: 32, maxLength: 32 })` as the arbitrary for `PRF_Output` values, in compliance with the testing steering rule.
6. ALL property tests SHALL use `MockHardwareIdentityProvider` and SHALL NOT connect to real hardware, in compliance with the testing steering rule.

---

### Requirement 16: Integration Tests — Enrollment and Derivation Flow

**User Story:** As a developer, I want integration tests that exercise the complete enrollment-then-derivation flow using the mock provider, so that the interaction between EnrollmentService, DerivationService, and SessionService is verified without real hardware.

#### Acceptance Criteria

1. THE integration test suite SHALL include a test that calls `EnrollmentService.enroll()` with `MockHardwareIdentityProvider`, then calls `DerivationService.deriveWallet()` with the returned `credentialId`, and asserts that a non-null wallet address in Base58 format is returned.
2. THE integration test suite SHALL include a test that calls `DerivationService.deriveWallet()` twice with the same `MockHardwareIdentityProvider` instance and the same `credentialId`, and asserts that both calls return the same wallet address.
3. THE integration test suite SHALL include a test that calls `DerivationService.deriveWallet()` with two different `credentialId` values on the same `MockHardwareIdentityProvider` instance, and asserts that the wallet addresses differ.
4. THE integration test suite SHALL include a test that verifies that aborting the `AbortSignal` before `getAssertion` is called causes `deriveWallet()` to return `{ kind: "user-cancelled" }`.

---

### Requirement 17: Failure Injection Tests

**User Story:** As a developer, I want tests that inject specific CTAP2 error codes into the mock provider, so that error handling paths in EnrollmentService and DerivationService are verified without real hardware.

#### Acceptance Criteria

1. THE test suite SHALL include a test that configures `MockHardwareIdentityProvider` to throw `CtapError("CTAP2_ERR_PIN_BLOCKED")` from `createCredential()`, and asserts that `EnrollmentService.enroll()` throws an `EnrollmentError` with `category === "pin-locked"`.
2. THE test suite SHALL include a test that configures `MockHardwareIdentityProvider` to throw `CtapError("CTAP2_ERR_KEY_STORE_FULL")` from `createCredential()`, and asserts that `EnrollmentService.enroll()` throws an `EnrollmentError` with `category === "storage-full"`.
3. THE test suite SHALL include a test that configures `MockHardwareIdentityProvider` to return `authenticatorAttachment: "platform"` from `createCredential()`, and asserts that `EnrollmentService.enroll()` throws an `EnrollmentError` with `category === "enrollment-failed"`.
4. THE test suite SHALL include a test that configures `MockHardwareIdentityProvider` to throw `CtapError("CTAP2_ERR_OPERATION_DENIED")` from `getAssertion()`, and asserts that `DerivationService.deriveWallet()` returns `{ kind: "authenticator-error" }`.
5. THE test suite SHALL include a test that simulates a device-removal event during an in-flight `deriveWallet()` call (by aborting the signal mid-call), and asserts that `DerivationService.deriveWallet()` returns `{ kind: "user-cancelled" }`.

---

### Requirement 18: Real Hardware Acceptance Test Script

**User Story:** As a developer, I want a scripted acceptance test that runs against a real YubiKey 5C NFC and produces a human-readable pass/fail report, so that the end-to-end flow can be verified on actual hardware before a release.

#### Acceptance Criteria

1. THE System SHALL provide a script `scripts/hardware-acceptance-test.ts` that, when executed with a real FIDO2 device attached, performs in sequence: device detection, `authenticatorGetInfo` check, credential creation with `hmac-secret` and `resident key` flags, PRF assertion, HKDF derivation, and Solana address output.
2. WHEN the acceptance test script runs the credential creation step, THE script SHALL use a separate test `rpId` (e.g., `"key-wallet-test.local"`) so that it cannot interfere with production credentials stored under `rpId = "key-wallet.local"`.
3. WHEN the acceptance test script completes a full pass, THE script SHALL print the derived wallet address and the Base58 public key, and SHALL exit with code 0.
4. WHEN any step of the acceptance test script fails, THE script SHALL print the failing step name, the error category, and the raw error message, and SHALL exit with a non-zero exit code.
5. THE acceptance test script SHALL NOT write `PRF_Output`, `Wallet_Seed`, or private key bytes to stdout or to any file.

---

### Requirement 19: Packaging — Self-Contained Build

**User Story:** As an end user, I want to install and run KeyWallet without installing any separate runtime libraries or CLI tools, so that the application works on a clean Windows machine.

#### Acceptance Criteria

1. THE packaged installer SHALL include all four libfido2 1.15.0 DLLs (`fido2.dll`, `cbor.dll`, `crypto.dll`, `zlib1.dll`) and all three CLI tools (`fido2-assert.exe`, `fido2-cred.exe`, `fido2-token.exe`) for the `Win64` architecture inside the application bundle.
2. THE electron-builder configuration SHALL list `"libfido2-win/**/*"` in the `files` array so that the CLI tools are copied into the packaged resources.
3. WHEN the packaged application starts, THE System SHALL verify that `fido2-assert.exe` exists at the resolved packaged path and SHALL log a warning at startup if the file is missing.
4. THE packaged application SHALL NOT require the user to install the Visual C++ Runtime, the Windows SDK, or any other system-level library not included in the standard Windows 10 1903+ installation.
5. WHEN node-hid is loaded in the packaged application, THE System SHALL load the binary from the `app.asar.unpacked` directory, and the electron-builder `asarUnpack` configuration SHALL include `"**/node_modules/node-hid/**"`.

---

### Requirement 20: Packaging — Smoke Test

**User Story:** As a developer, I want an automated smoke test that verifies the packaged application can detect hardware without crashing, so that packaging regressions are caught before a release is published.

#### Acceptance Criteria

1. THE System SHALL provide a smoke test that can be run against the packaged `.exe` or unpacked build that verifies: the application starts without a JavaScript error, the `hardware:diagnose` IPC handler responds within 5000ms, and the response `deviceDetected` field reflects actual hardware state.
2. WHEN the smoke test is run and `fido2-assert.exe` is not found at the resolved path, THE smoke test SHALL fail with a non-zero exit code and print the resolved path.

---

### Requirement 21: Test Hardware Matrix Documentation

**User Story:** As a developer, I want a documented hardware test matrix that records which authenticators have been tested for each platform and operation, so that unsupported combinations are visible to future contributors.

#### Acceptance Criteria

1. THE System SHALL include a file `docs/hardware-test-matrix.md` that contains a table with rows for each tested authenticator model and columns for: OS platform, node-hid direct access, `windows://hello` via fido2 CLI, `createCredential` with resident key, `getAssertion` with hmac-secret, and full derivation flow result.
2. THE hardware test matrix SHALL include at minimum an entry for: YubiKey 5C NFC on Windows 10 1903+ via `windows://hello`.
3. THE hardware test matrix SHALL clearly mark operations that have only been tested with the mock provider (not real hardware) using a distinct label such as "mock only".

---

### Requirement 22: Security Audit Documentation

**User Story:** As a developer, I want a security audit document that records all places where secret material is handled and confirms that each satisfies the project security rules, so that the audit trail is complete and reviewable.

#### Acceptance Criteria

1. THE System SHALL include a file `docs/security-audit.md` that lists every location in the codebase where `PRF_Output`, `Wallet_Seed`, or `keypair.secretKey` is created, read, transformed, or zeroed.
2. FOR EACH location listed in the security audit, the document SHALL state: file path, line range, which secret is handled, whether the buffer is zeroed in a `finally` block, and whether the value is passed over IPC or written to a log.
3. THE security audit SHALL explicitly confirm that no log statement in the codebase contains `PRF_Output`, `Wallet_Seed`, or `keypair.secretKey` bytes.
4. THE security audit SHALL explicitly confirm that the `credential:discover` IPC response contains only `credentialId` (hex string) and `userDisplayName` (string), and no secret material.

---

### Requirement 23: README and Spec Updates

**User Story:** As a developer, I want the README and the Kiro spec to accurately reflect the actual hardware integration architecture, so that contributors do not follow outdated guidance.

#### Acceptance Criteria

1. WHEN the audit is complete and code fixes are applied, THE README SHALL be updated to describe the Windows FIDO2 path: OS HID claim → vendor ID detection → `Fido2CliHardwareIdentityProvider` → `windows://hello` → libfido2 CLI subprocess.
2. THE README SHALL include setup instructions for the YubiKey 5C NFC that cover: setting a PIN, enrolling a credential, unlocking a session, and removing the key to terminate the session.
3. WHEN any Provider is deprecated or replaced, THE architecture steering file `architecture.md` SHALL be updated to reflect the current set of active Provider implementations.

---

### Requirement 24: Kiro Platform Integrity

**User Story:** As a developer, I want the audit and repair process to preserve all existing Kiro platform configuration, so that automation, PBT hooks, and custom agents remain functional throughout and after the audit.

#### Acceptance Criteria

1. THE System SHALL preserve all existing hooks in `.kiro/hooks/` — including `derivation-pbt-on-save.json` and `security-lint-on-save.json` — without modification unless a hook itself contains a defect identified in the audit.
2. THE System SHALL preserve all existing steering files in `.kiro/steering/` — including `architecture.md`, `security.md`, and `testing.md` — and SHALL update them only to add information or correct inaccuracies discovered during the audit.
3. THE System SHALL preserve the existing `agents/crypto-security-reviewer.json` custom agent definition without modification.
4. WHEN new property-based tests are added for this audit spec, THE tests SHALL follow the annotation convention `// Feature: hardware-integration-audit, Property N: <name>` as required by the testing steering rules.
5. THE System SHALL maintain the `MockHardwareIdentityProvider` determinism invariant described in the testing steering rules: for the same `credentialId`, `getAssertion()` SHALL return the same `hmacOutput` within a single test run.

---

### Requirement 25: Final End-to-End Acceptance

**User Story:** As a user, I want to install the application on a clean machine, plug in my hardware security key, and have a working Solana devnet wallet, so that the application fulfils its core purpose.

#### Acceptance Criteria

1. WHEN the packaged application is installed on a clean Windows 10 1903+ machine with no development tools present, THE System SHALL detect a connected YubiKey 5C NFC and display it as "CONNECTED" in the UI within 3000ms of device insertion.
2. WHEN a user with no existing credential clicks "Enroll", THE System SHALL guide the user through PIN verification and touch confirmation, then complete enrollment and derive a wallet address without the user installing any additional software.
3. WHEN a user with an existing credential inserts the key and touches it when prompted, THE System SHALL derive the same wallet address that was derived during enrollment, confirming deterministic derivation.
4. WHEN the hardware key is physically removed, THE System SHALL terminate the active session, zero the keypair in memory, and display a "no device" state within 200ms.
5. WHEN a wallet address has been derived, THE System SHALL successfully retrieve a Solana devnet balance via the Solana RPC, confirming that the derived address is a valid Base58-encoded Ed25519 public key.
6. IF `getAssertion` fails for any reason, THEN THE System SHALL display an error to the user and SHALL NOT display a wallet address derived from any fallback source.
