# Hardware Test Matrix

This document records which authenticator models have been tested for each
platform and operation combination.  It is the authoritative reference for
"what has actually been verified against real hardware" versus what has only
been exercised through the software mock (`MockHardwareIdentityProvider`).

**Legend**

| Symbol / Label | Meaning |
|---|---|
| ✅ pass | Tested and passing against real hardware |
| ❌ fail | Tested against real hardware; known failure |
| ⚠️ untested | Code path exists but has never been run against real hardware |
| **mock only** | Only exercised through `MockHardwareIdentityProvider`; no real-hardware run |
| N/A | Operation not applicable for this provider/platform combination |

---

## Matrix

| Authenticator | OS Platform | node-hid direct access | `windows://hello` via fido2 CLI | `createCredential` (resident key) | `getAssertion` (hmac-secret) | Full derivation flow |
|---|---|---|---|---|---|---|
| YubiKey 5C NFC (fw 5.7.4) | Windows 10 1903+ | ⚠️ untested — OS HID claim prevents raw access; `node-hid` FIDO filter returns 0 devices | **mock only** — `Fido2CliHardwareIdentityProvider` path exercised by unit/integration tests against stubbed `spawnCli`; real CLI subprocess not invoked in any passing test | **mock only** — `createCredential` called via `MockHardwareIdentityProvider` in all automated tests; real `fido2-cred.exe` not invoked | **mock only** — `getAssertion` + hmac-secret exercised via `MockHardwareIdentityProvider`; real `fido2-assert.exe` not invoked | **mock only** — end-to-end derivation (PRF → HKDF → Solana keypair) verified through mock only; `hardware-hid.integration.test.ts` skipped |
| YubiKey 5C NFC (fw 5.7.4) | macOS / Linux (non-Windows) | ⚠️ untested — `NodeHidHardwareIdentityProvider` compiles and HID filter logic is unit-tested with mocks; no real-device run recorded | N/A — `windows://hello` path is Windows-only | **mock only** | **mock only** | **mock only** |
| Generic FIDO2 key (any vendor in known set) | Windows 10 1903+ | ⚠️ untested — vendor-ID gate logic unit-tested; no real device run | **mock only** | **mock only** | **mock only** | **mock only** |

---

## Provider Coverage Summary

The table below cross-references each provider with its test coverage level.

| Provider | Platform | node-hid direct access | `windows://hello` via CLI | `createCredential` (resident key) | `getAssertion` (hmac-secret) | Full derivation flow |
|---|---|---|---|---|---|---|
| `Fido2CliHardwareIdentityProvider` | Windows 10 1903+ | N/A | **mock only** | **mock only** | **mock only** | **mock only** |
| `NodeHidHardwareIdentityProvider` (HID path) | Non-Windows | **mock only** | N/A | **mock only** | **mock only** | **mock only** |
| `NodeHidHardwareIdentityProvider` (Windows delegate) | Windows 10 1903+ | ⚠️ untested (raw HID) | **mock only** (delegates to `Fido2CliHardwareIdentityProvider`) | **mock only** | **mock only** | **mock only** |
| `Libfido2HardwareIdentityProvider` | Windows / macOS / Linux | ⚠️ untested | ⚠️ untested | ⚠️ untested | ❌ not implemented — `@vaultys/webauthn-node` C++ binding omits hmac-secret in `GetAssertion`; deliberately excluded from the active provider stack | N/A |
| `MockHardwareIdentityProvider` | All (test only) | N/A — software mock | N/A — software mock | ✅ pass — used in all unit, property, and integration tests | ✅ pass — deterministic HMAC-SHA256 mock; verified by property tests | ✅ pass — full mock derivation verified in `e2e-smoke.test.ts` and `session-lifecycle.integration.test.ts` |

---

## Notes

1. **YubiKey 5C NFC on Windows 10 1903+ via `windows://hello`** is the primary
   target platform.  All code paths through `Fido2CliHardwareIdentityProvider`
   are currently **mock only** because the automated test suite stubs out
   `spawnCli` and never invokes `fido2-assert.exe` or `fido2-cred.exe` against
   a real device.  The skipped `test/integration/hardware-hid.integration.test.ts`
   test file documents the manual procedure for real-hardware verification.

2. On Windows, `node-hid` cannot obtain a raw HID handle to the FIDO2 interface
   because the OS claims it.  `NodeHidHardwareIdentityProvider.listDevices()`
   falls back to vendor-ID detection and delegates all CTAP2 operations to
   `Fido2CliHardwareIdentityProvider` when a known FIDO2 vendor is present.

3. `Libfido2HardwareIdentityProvider` (`@vaultys/webauthn-node`) is present as
   a dependency but is **not used** for any operation that requires the
   hmac-secret extension.  Its `getAssertion` path does not implement
   hmac-secret, making it unsuitable for wallet key derivation.

4. The known FIDO2 vendor set used by the Windows fallback logic covers:
   `0x1050` (Yubico), `0x096e` (Feitian), `0x2c97` (Ledger), `0x1ea8` (Nitrokey),
   `0x20a0` (SoloKeys), `0x0483` (STMicro), `0x10c4` (Silicon Labs).

5. To promote any row from **mock only** to **✅ pass**, run
   `npm run hardware:test` (once Task 3.2 is implemented) with the target
   device plugged in and update this table with the result and date.

---

*Last updated: hardware-integration-audit Phase 1 (task 1.3). No real-hardware
runs have been recorded yet. All automated test coverage is via
`MockHardwareIdentityProvider`.*
