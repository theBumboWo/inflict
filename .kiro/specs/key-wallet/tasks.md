# Implementation Plan: KeyWallet

## Overview

KeyWallet is a cross-platform Electron desktop application that derives a deterministic Solana Ed25519 wallet from a FIDO2/WebAuthn hardware security key via the CTAP2 `hmac-secret` extension. This plan implements the full system in small, independently testable increments: scaffolding → core cryptography → services → IPC → UI → hardware integration → Kiro feature integrations (MCP, steering, hooks, agent, Power).

All CTAP2 operations are isolated to the Electron main process. A `HardwareIdentityProvider` abstraction enables all service-layer code and property-based tests to run against a deterministic software mock without real hardware.

## Tasks

- [x] 1. Project scaffolding and build tooling
  - [x] 1.1 Initialize Electron + TypeScript project with `electron-builder`, configure `tsconfig.json` for main/renderer/shared split, add `vitest` and `fast-check` as dev dependencies, add `@solana/web3.js` and `@modelcontextprotocol/sdk` as runtime dependencies
    - Create `package.json` with pinned exact versions for all dependencies
    - Configure separate tsconfig targets for `src/main` (Node CJS), `src/renderer` (browser ESM), and `src/shared` (both)
    - Add `vitest.config.ts` with `environment: "node"`, `globals: true`, `include: ["test/unit/**/*.test.ts", "test/property/**/*.test.ts"]`
    - Add npm scripts: `build`, `test` (`vitest run`), `lint`, `start`
    - Create the full directory skeleton: `src/main/hardware/`, `src/main/device/`, `src/main/enrollment/`, `src/main/derivation/`, `src/main/session/`, `src/main/solana/`, `src/main/transaction/`, `src/main/storage/`, `src/preload/`, `src/renderer/views/`, `src/renderer/hooks/`, `src/mcp/`, `src/shared/`, `test/unit/`, `test/property/`, `test/integration/`, `test/mocks/`, `scripts/`, `.kiro/steering/`, `.kiro/hooks/`, `powers/hardware-wallet-security/`, `agents/`
    - _Requirements: Req 15_

- [x] 2. Shared IPC types and error categories
  - [x] 2.1 Create `src/shared/ipc-types.ts` with all `IpcRequest`, `IpcEvent`, `SessionPublicData`, `ErrorCategory`, `TransferParams`, `EnrollmentState`, and `TransactionPreview` type definitions exactly as specified in the design
    - `IpcRequest` union must cover all channels: `device:list`, `enrollment:start`, `enrollment:cancel`, `credential:discover`, `credential:select`, `wallet:derive`, `session:get`, `session:terminate`, `balance:get`, `balance:refresh`, `transaction:validate`, `transaction:preview`, `transaction:submit`, `address:copy`
    - `IpcEvent` union must cover all events: `device:connected`, `device:removed`, `device:unsupported`, `session:changed`, `balance:updated`, `balance:unavailable`, `enrollment:progress`, `error`
    - `SessionPublicData` must contain only non-secret fields: `sessionId`, `walletAddress`, `displayName`, `credentialId`
    - `ErrorCategory` must enumerate all 13 categories from the design
    - _Requirements: Req 5.8, Req 8_

- [x] 3. HardwareIdentityProvider interface and types
  - [x] 3.1 Create `src/main/hardware/types.ts` with `DeviceInfo`, `EnrollmentOptions`, `EnrollmentResult`, `DiscoveryResult`, `AssertionOptions`, `AssertionResult`, `CtapErrorCode`, and `CtapError` class
    - `CtapError` extends `Error` with `code: CtapErrorCode` and `userMessage: string` fields
    - `EnrollmentOptions` must enforce `requireResidentKey: true`, `userVerification: "required"`, `authenticatorAttachment: "cross-platform"` as literal types
    - _Requirements: Req 1, Req 2, Req 3, Req 4, Req 13_
  - [x] 3.2 Create `src/main/hardware/IHardwareIdentityProvider.ts` with the `IHardwareIdentityProvider` interface defining `listDevices()`, `discoverCredentials()`, `createCredential()`, and `getAssertion()` methods exactly as specified in the design
    - _Requirements: Req 1, Req 2, Req 3, Req 4, Req 13_

- [x] 4. MockHardwareIdentityProvider
  - [x] 4.1 Create `test/mocks/MockHardwareIdentityProvider.ts` implementing `IHardwareIdentityProvider` with deterministic behavior
    - `getAssertion()` returns a deterministic 32-byte `hmacOutput` derived from `credentialId` via `HMAC-SHA256(Buffer.from("mock-secret"), credentialId)`, cached in a `Map` so the same `credentialId` always returns the same output within a test run
    - `listDevices()` returns a single mock device with `supportsHmacSecret: true`, `supportsResidentKey: true`, `extensions: ["hmac-secret"]`
    - `discoverCredentials()` returns `{ credentials: [] }` by default; expose a method to configure test return values
    - `createCredential()` returns a random 32-byte `credentialId` with `authenticatorAttachment: "cross-platform"`
    - Never connects to real hardware
    - _Requirements: Req 18.6_

- [x] 5. HKDF utility and PRF_SALT_CONSTANT
  - [x] 5.1 Create `src/main/derivation/hkdf.ts` with an `hkdf()` function wrapping `crypto.hkdfSync("sha256", ...)` from `node:crypto`, and export the `PRF_SALT_CONSTANT` as a frozen `Uint8Array` computed by HKDF with IKM = UTF-8(`"key-wallet-prf-salt-v1"`), salt = empty, info = UTF-8(`"solana-wallet-derivation"`), length = 32
    - The `PRF_SALT_CONSTANT` must be computed once at module load time and frozen (`Object.freeze`)
    - `hkdf()` signature: `(ikm: Buffer | Uint8Array, salt: Buffer | Uint8Array, info: Buffer | Uint8Array, length: number) => Buffer`
    - Export the constant for use in `DerivationService` and tests
    - _Requirements: Req 4.2_

- [x] 6. DerivationService
  - [x] 6.1 Create `src/main/derivation/DerivationService.ts` implementing `IDerivationService` with the full two-step HKDF derivation pipeline
    - Constructor accepts `IHardwareIdentityProvider`
    - `deriveWallet(devicePath, credentialId, signal)` must: (1) call `provider.getAssertion()` with `PRF_SALT_CONSTANT` and `userVerification: "required"`, (2) compute `Wallet_Seed = hkdf(PRF_Output, empty, "key-wallet:solana:ed25519:v1", 32)`, (3) call `Keypair.fromSeed(walletSeed)`, (4) zero-overwrite `PRF_Output` and `Wallet_Seed` in a `finally` block, (5) return `{ keypair, walletAddress }`
    - On CTAP2 error: discard all partial state and return `DerivationError` with `kind: "authenticator-error"`
    - On user cancel or `AbortSignal` fired: discard all partial state and return `DerivationError` with `kind: "user-cancelled"`
    - Must NOT log, emit, store, or transmit `PRF_Output`, `Wallet_Seed`, or private key bytes
    - _Requirements: Req 4_
  - [x] 6.2 Write unit tests for DerivationService
    - Test correct HKDF info string used in Step 2 (`"key-wallet:solana:ed25519:v1"`)
    - Test that `PRF_Output.fill(0)` and `Wallet_Seed.fill(0)` are called even when an error is thrown (inject a spy)
    - Test that user-cancel returns `{ kind: "user-cancelled" }` error type
    - Test that two different `credentialId` values (via mock) produce different `walletAddress` values
    - Use `MockHardwareIdentityProvider`
    - _Requirements: Req 4_

- [x] 7. Property-based tests for DerivationService
  - [x] 7.1 Create `test/property/derivation.property.test.ts` using `fast-check`; implement Property 1: for any fixed 32-byte PRF_Output array, `deriveFromPrfOutput(prfOutput)` called twice returns the same `walletAddress`
    - Use `fc.uint8Array({ minLength: 32, maxLength: 32 })` as the arbitrary
    - Use `MockHardwareIdentityProvider` seeded with the test PRF_Output value
    - Annotate: `// Feature: key-wallet, Property 1: Derivation Determinism`
    - `numRuns: 100`
    - _Requirements: Req 18.1_
  - [x] 7.2 Implement Property 2 in `test/property/derivation.property.test.ts`: for any two distinct 32-byte PRF_Output arrays `a ≠ b`, derived `walletAddress` values must differ
    - Use `fc.tuple(prfOutputArb, prfOutputArb).filter(([a, b]) => !Buffer.from(a).equals(Buffer.from(b)))` 
    - Annotate: `// Feature: key-wallet, Property 2: Derivation Injectivity`
    - `numRuns: 100`
    - _Requirements: Req 18.2_
  - [x] 7.3 Implement Property 3 in `test/property/derivation.property.test.ts`: for any 32-byte PRF_Output, the HKDF derivation chain produces a 32-byte seed that `Keypair.fromSeed()` accepts without throwing
    - Annotate: `// Feature: key-wallet, Property 3: HKDF Output is a Valid Ed25519 Seed`
    - `numRuns: 100`
    - _Requirements: Req 18.3_
  - [x] 7.4 Implement Property 7 in `test/property/derivation.property.test.ts`: for any 32-byte PRF_Output, after a complete derivation call, no intercepted logger call contains the hex-encoded PRF_Output bytes
    - Inject a mock logger with `info`, `error`, `debug` methods that capture all calls
    - Check that `Buffer.from(prfOutput).toString("hex")` does not appear in any captured log entry
    - Annotate: `// Feature: key-wallet, Property 7: No Secret Material in Derivation Output Logs`
    - `numRuns: 100`
    - _Requirements: Req 18.7_

- [x] 8. Checkpoint — Core cryptography complete
  - Ensure all DerivationService unit tests and property tests pass with `vitest run`. Ask the user if any questions arise.

- [x] 9. CredentialStore
  - [x] 9.1 Create `src/main/storage/CredentialStore.ts` implementing `ICredentialStore` with JSON file persistence at `{app.getPath("userData")}/credentials.json`
    - `save(meta)`: append to the credentials array; `credentialId` stored as hex string
    - `findAll()`: read and parse the JSON file, return all entries; return empty array if file does not exist
    - `delete(credentialId)`: filter out the matching entry and rewrite the file; require explicit call (no auto-delete on mismatch)
    - File format: `{ "version": 1, "credentials": [...] }` where each entry has `credentialId` (hex), `rpId`, `displayName`, `createdAt` (ISO 8601)
    - Must NEVER store `PRF_Output`, `Wallet_Seed`, private key bytes, or any intermediate derivation value
    - _Requirements: Req 2.8, Req 2.9, Req 3.1, Req 12.5_
  - [x] 9.2 Write unit tests for CredentialStore
    - Test `save` + `findAll` round-trip
    - Test `delete` removes exactly the matching entry
    - Test `findAll` returns empty array on missing file
    - Use a temp directory so tests do not write to real `userData`
    - _Requirements: Req 2.8, Req 3.1_

- [x] 10. DeviceMonitor
  - [x] 10.1 Create `src/main/device/DeviceMonitor.ts` implementing `IDeviceMonitor` with a 500ms polling loop against `IHardwareIdentityProvider.listDevices()`
    - Constructor accepts `IHardwareIdentityProvider`
    - On each poll, diff the current device set against the previous: emit `device-connected` for new entries and `device-removed` for disappeared entries
    - On first detection of a new device, call `authenticatorGetInfo` (via `provider.listDevices()` response `supportsHmacSecret` flag) — if `hmac-secret` flag is absent, emit `device-unsupported` instead of `device-connected`
    - If `authenticatorGetInfo` does not respond within 5 seconds, emit `device-unsupported` (Req 1.8)
    - If a second device connects while a session is active (tracked via a passed-in `isSessionActive` callback), emit `device-connected` for the new device but do not interrupt the existing session (Req 1.9)
    - `start()` begins polling; `stop()` clears the interval
    - _Requirements: Req 1_
  - [x] 10.2 Write unit tests for DeviceMonitor
    - Test `device-connected` emitted within timing budget when device appears in mock
    - Test `device-removed` emitted when device disappears from mock
    - Test `device-unsupported` emitted when `supportsHmacSecret` is false
    - Test that a second device connected during active session is handled per Req 1.9
    - Use `MockHardwareIdentityProvider` with configurable `listDevices()` return
    - _Requirements: Req 1_

- [x] 11. EnrollmentService
  - [x] 11.1 Create `src/main/enrollment/EnrollmentService.ts` implementing `IEnrollmentService`
    - Constructor accepts `IHardwareIdentityProvider` and `ICredentialStore`
    - `enroll(devicePath, displayName, signal)`:
      1. Check PIN via `authenticatorGetInfo` `clientPin` flag; if not set, surface `"pin-required"` error and wait for user confirmation (up to 300s timeout) before proceeding (Req 2.10)
      2. Call `provider.createCredential()` with `rpId: "key-wallet.local"`, `requireResidentKey: true`, `userVerification: "required"`, `authenticatorAttachment: "cross-platform"`, `userId` = 16 CSPRNG random bytes
      3. Verify `result.authenticatorAttachment === "cross-platform"`; if `"platform"`, reject with error (Req 13.2, 13.3)
      4. Call `credentialStore.save()` with `credentialId` (hex), `rpId`, `displayName`, `createdAt`
      5. Return `{ credentialId }`
    - Abort on `AbortSignal` or 120s timeout; discard all partial state on abort (Req 2.11)
    - Map `CTAP2_ERR_KEY_STORE_FULL` → display storage-full error (Req 2.7)
    - Map all other CTAP2 errors to `ErrorCategory` (Req 3.5)
    - Must NOT store any secret material
    - _Requirements: Req 2, Req 3, Req 13_
  - [x] 11.2 Write unit tests for EnrollmentService
    - Test platform attachment rejection (mock returns `authenticatorAttachment: "platform"`)
    - Test abort on timeout clears partial state
    - Test `CTAP2_ERR_KEY_STORE_FULL` surfaces correct error category
    - Test successful enrollment stores metadata via `ICredentialStore`
    - Use `MockHardwareIdentityProvider`
    - _Requirements: Req 2, Req 13_

- [x] 12. SessionService
  - [x] 12.1 Create `src/main/session/SessionService.ts` implementing `ISessionService`
    - `createSession(devicePath, credentialId, displayName, keypair)`: creates a `Session` with UUID v4 `sessionId`, stores in memory only
    - `terminateSession(sessionId)`: zero-overwrites `session.keypair.secretKey` (`Uint8Array.fill(0)`), clears all session state from memory; must complete within 200ms
    - `getActiveSession()`: returns current session or `null`
    - `isSessionActive()`: returns boolean
    - Session data structure matches the design exactly (no serialization to disk)
    - When no session is active, reject all transaction-related calls with `"session-locked"` error category (Req 5.8)
    - _Requirements: Req 5, Req 9_
  - [x] 12.2 Write unit tests for SessionService
    - Test `createSession` returns valid session with all required fields
    - Test `terminateSession` calls `secretKey.fill(0)` (use a spy on the `Uint8Array`)
    - Test `getActiveSession` returns `null` after termination
    - Test that calling `terminateSession` on a non-existent session ID is a no-op
    - _Requirements: Req 5_

- [x] 13. SolanaService
  - [x] 13.1 Create `src/main/solana/SolanaService.ts` implementing `ISolanaService`
    - Hard-code `new Connection("https://api.devnet.solana.com", "confirmed")` — no configurable RPC endpoint (Req 7.5)
    - `getBalance(walletAddress)`: fetches lamport balance; throws typed error on timeout (>15s) or network failure
    - `getRecentTransactions(walletAddress)`: returns the 10 most recent transaction signatures
    - `getRecentBlockhash()`: fetches with 10-second timeout; throws on timeout
    - `startPeriodicRefresh(walletAddress, intervalMs)`: starts a `setInterval`; emits balance via event or callback; resets timer on manual refresh
    - `stopPeriodicRefresh()`: clears the interval immediately (Req 7.6)
    - Format balance as SOL with exactly 4 decimal places: `(lamports / 1e9).toFixed(4)`
    - On RPC failure, apply exponential backoff starting at 2s, doubling up to 60s maximum (Req 7.4)
    - _Requirements: Req 7_
  - [x] 13.2 Write unit tests for SolanaService
    - Test balance formatting: 1 lamport → `"0.0000"` SOL, 1_000_000_000 lamports → `"1.0000"` SOL
    - Test `stopPeriodicRefresh` halts interval (spy on `clearInterval`)
    - Test that only devnet RPC URL is used (no mainnet URL present in source)
    - Mock `@solana/web3.js` `Connection` for all tests
    - _Requirements: Req 7_

- [x] 14. TransactionService
  - [x] 14.1 Create `src/main/transaction/TransactionService.ts` implementing `ITransactionService`
    - Constructor accepts `ISolanaService`
    - `validateTransferParams(params)`: validate destination address (Base58 decode → must be exactly 32 bytes, length 32–44 chars); validate amount ≥ 1 lamport and ≤ `currentBalanceLamports - estimatedFee`; return `TransactionValidationError | null`
    - `buildTransactionPreview(params)`: fetch recent blockhash (10s timeout); build `SystemProgram.transfer()` instruction; estimate fee via `connection.getFeeForMessage()`; return `TransactionPreview` (no signing)
    - `signAndSubmit(params, keypair, signal)`: build transaction with blockhash (must be < 60s old); call `transaction.sign(keypair)`; call `connection.sendRawTransaction()`; return `{ signature }`; never store the keypair in service state
    - On RPC submission error: hold signed transaction in memory for 30s to allow one retry (Req 8.10)
    - On session termination during signing: abort within 2s, discard all signed bytes (Req 8.11)
    - Only construct transactions for devnet cluster; reject any mainnet-beta or testnet cluster names (Req 8.12)
    - _Requirements: Req 8, Req 9_
  - [x] 14.2 Write unit tests for TransactionService
    - Test `validateTransferParams` rejects 31-byte and 33-byte decoded addresses
    - Test `validateTransferParams` rejects amount = 0 and amount > balance - fee
    - Test `validateTransferParams` accepts exact boundary: amount = balance - fee
    - Test blockhash timeout aborts construction with correct error category
    - Mock `ISolanaService` for all tests
    - _Requirements: Req 8_

- [x] 15. Property-based tests for TransactionService
  - [x] 15.1 Create `test/property/transaction.property.test.ts`; implement Property 4: for any valid combination of (destinationAddress, lamports, feePayer public key, blockhash), serializing and deserializing a constructed unsigned transaction produces field-by-field equal program identifiers, account list, and instruction data
    - Generate valid 32-byte addresses as `fc.uint8Array({ minLength: 32, maxLength: 32 }).map(bs => bs58.encode(Buffer.from(bs)))`
    - Use `{ requireAllSignatures: false }` in `serialize()`
    - Annotate: `// Feature: key-wallet, Property 4: Transaction Serialization Round-Trip`
    - `numRuns: 100`
    - _Requirements: Req 18.4_
  - [x] 15.2 Implement Property 5 in `test/property/transaction.property.test.ts`: for any lamports value in the valid range `[1, currentBalanceLamports - estimatedFee]`, the resulting transaction's transfer instruction encodes a positive lamports value that does not exceed the session balance
    - Use `fc.bigInt({ min: 1n, max: 10_000_000_000n })` for balance, `fc.bigInt({ min: 5000n, max: 5000n })` for fee, `fc.nat({ max: 1000 }).map(BigInt)` for offset
    - Use `fc.pre(amount >= 1n)` precondition
    - Annotate: `// Feature: key-wallet, Property 5: Transaction Amount Invariant`
    - `numRuns: 100`
    - _Requirements: Req 18.5_
  - [x] 15.3 Implement Property 6 in `test/property/transaction.property.test.ts`: for any valid 32-byte public key encoded as Base58, `validateDestinationAddress()` returns `true`; for any byte array of length ≠ 32 encoded as Base58 (or any non-Base58 string), `validateDestinationAddress()` returns `false`
    - Use `fc.uint8Array({ minLength: 32, maxLength: 32 })` for valid keys
    - Use `fc.uint8Array({ minLength: 1, maxLength: 64 }).filter(b => b.length !== 32)` for invalid keys
    - Annotate: `// Feature: key-wallet, Property 6: Address Validation Completeness`
    - `numRuns: 100`
    - _Requirements: Req 8.2_

- [x] 16. Checkpoint — All services and property tests complete
  - Ensure all unit tests and property tests pass with `vitest run`. Ask the user if any questions arise.

- [x] 17. IPC handlers in main process
  - [x] 17.1 Create `src/main/index.ts` as the Electron app entry point; register all `ipcMain.handle()` handlers mapped to the `IpcRequest` channel names defined in `src/shared/ipc-types.ts`
    - Instantiate all services (DeviceMonitor, EnrollmentService, DerivationService, SessionService, SolanaService, TransactionService, CredentialStore) and wire up dependencies
    - Register handlers for: `device:list`, `enrollment:start`, `enrollment:cancel`, `credential:discover`, `credential:select`, `wallet:derive`, `session:get`, `session:terminate`, `balance:get`, `balance:refresh`, `transaction:validate`, `transaction:preview`, `transaction:submit`, `address:copy`
    - For `session:get` and all wallet operations: validate that a session is active; return `"session-locked"` error if not (Req 5.8)
    - Push `IpcEvent` payloads to the renderer via `webContents.send()` for all push events (device, session, balance, enrollment progress, error)
    - Never forward raw CTAP2 error codes or secret material to the renderer
    - _Requirements: Req 5.8, Req 8_

- [x] 18. Preload script
  - [x] 18.1 Create `src/preload/index.ts` exposing the typed API via `contextBridge.exposeInMainWorld("wallet", ...)`
    - Expose `invoke(channel, payload?)` that calls `ipcRenderer.invoke(channel, payload)` for all `IpcRequest` channels
    - Expose `on(event, listener)` and `off(event, listener)` wrappers around `ipcRenderer.on/off` for all `IpcEvent` events
    - Renderer window must be configured with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
    - No CTAP2, libfido2, or `@solana/web3.js` imports in this file
    - _Requirements: Req 15_

- [x] 19. React renderer — IdleView
  - [x] 19.1 Create `src/renderer/App.tsx` with top-level state machine routing between views (Idle, Enroll, Wallet, Send) based on session and device state, and create `src/renderer/hooks/useWalletState.ts` that subscribes to all `IpcEvent` events via the preload bridge and exposes typed state to components
    - App renders the correct view based on: no device connected → IdleView; device connected, no session → EnrollView or CredentialSelectionView; session active → WalletView; send flow → SendView
    - _Requirements: Req 1.3_
  - [x] 19.2 Create `src/renderer/views/IdleView.tsx` displaying the idle state prompt
    - Display message prompting user to connect a compatible hardware security key
    - Display "unsupported device" error message when a `device:unsupported` event is received, including a reference to compatible device classes (Req 12.1, 12.2)
    - Display accessible, visible UI (ARIA labels on all interactive elements)
    - _Requirements: Req 1.3_

- [x] 20. React renderer — EnrollView
  - [x] 20.1 Create `src/renderer/views/EnrollView.tsx` for the enrollment flow
    - Show enrollment prompt within 2 seconds of `device-connected` event (Req 2.1)
    - Display enrollment stages: `checking-pin`, `awaiting-touch`, `storing-metadata`, `complete`, `failed`
    - Show PIN setup guidance when PIN is not set (Req 12.3)
    - Provide a cancel button that calls `enrollment:cancel` IPC channel; return to IdleView within 2 seconds (Req 2.6)
    - Show credential selection list (max 20 entries, each with display name) when multiple credentials found on device (Req 3.3)
    - Ensure all interactive elements have accessible ARIA attributes
    - _Requirements: Req 2.1, Req 2.6, Req 2.10, Req 12.3_

- [x] 21. React renderer — WalletView
  - [x] 21.1 Create `src/renderer/views/WalletView.tsx` displaying the active wallet session
    - Display `walletAddress` as a Base58 string (32–44 chars) in a dedicated, visible field (Req 6.1)
    - Display a QR code of the `walletAddress` using a QR code library (e.g., `qrcode.react`); show error indicator in QR area on render failure without hiding the text address (Req 6.4, 6.5)
    - Display a copy-address button: on click, call `address:copy` IPC channel, show a transient confirmation indicator for 1–5 seconds (Req 6.2, 6.3)
    - Display balance in SOL with exactly 4 decimal places; show "balance unavailable" when `balance:unavailable` event is received (Req 7.3, 7.4)
    - Display a manual refresh button that calls `balance:refresh` IPC channel (Req 7.2)
    - Display the current credential display name as a persistent indicator (Req 10.4)
    - Show informational notification if a second device is connected while session is active (Req 5.6, 11.2)
    - Must NEVER display, log, or render private key bytes or `Wallet_Seed` (Req 6.6)
    - _Requirements: Req 5.2, Req 6, Req 7_

- [x] 22. React renderer — SendView
  - [x] 22.1 Create `src/renderer/views/SendView.tsx` for the transaction construction and signing flow
    - Show destination address input and amount input fields (Req 8.1)
    - On form submit, call `transaction:validate` IPC channel; display inline field-level validation errors for invalid address (Req 8.8) or invalid amount (Req 8.9)
    - On valid input, call `transaction:preview` to show confirmation screen with destination, amount in SOL, and estimated fee (Req 8.5)
    - On confirmation, call `transaction:submit`; display returned transaction signature on success (Req 8.7)
    - On RPC error, display error category and offer one retry within 30 seconds (Req 8.10)
    - Ensure all form fields have accessible ARIA labels and error announcements
    - _Requirements: Req 8_

- [x] 23. Checkpoint — Renderer and IPC complete
  - Ensure the project builds (`npm run build`) without TypeScript errors and all tests pass. Ask the user if any questions arise.

- [x] 24. Libfido2HardwareIdentityProvider (hardware integration)
  - [x] 24.1 Create `src/main/hardware/Libfido2HardwareIdentityProvider.ts` implementing `IHardwareIdentityProvider` using the `@vaultys/webauthn-node` (or equivalent libfido2 native addon) package
    - `listDevices()`: call `libfido2.list()` and `authenticatorGetInfo` for each device; map response to `DeviceInfo` including `supportsHmacSecret` from the `hmac-secret` extensions flag (Req 1.5, 1.7)
    - `discoverCredentials(devicePath, rpId)`: enumerate resident credentials using CTAP2 credential management; apply 10s timeout (Req 3.1)
    - `createCredential(devicePath, options)`: call `libfido2.makeCredential()` with `requireResidentKey: true`, `userVerification: "required"`, `authenticatorAttachment: "cross-platform"`, `hmac-secret` extension enabled (Req 2.2)
    - `getAssertion(devicePath, options)`: call `libfido2.getAssertion()` with `hmac-secret` extension and the provided `hmacSalt`; return 32-byte `hmacOutput` (Req 4.1)
    - Map all libfido2 error codes to `CtapErrorCode` enum values (Req 3.5)
    - Document Windows privilege requirement (Administrator or Windows 10 1903+ `WebAuthn.dll`) in a comment
    - _Requirements: Req 1.5, Req 1.7, Req 2.2, Req 4.1, Req 13.1_

- [x] 25. MCP server
  - [x] 25.1 Create `src/mcp/server.ts` using `@modelcontextprotocol/sdk` `McpServer` class with Zod-validated tools
    - `inspect_transaction` tool: accepts `{ transaction_base64: string }`; validate is valid base64; decode and parse as Solana `Transaction`; reject if decoded bytes > 10KB; return `{ program, accounts, instruction_data, fee_payer }`; reject any input with field names `private_key`, `wallet_seed`, `prf_output` (Req 19.1, 19.3, 19.5)
    - `query_devnet` tool: accepts `{ address: string }` (Base58); validate decodes to exactly 32 bytes; fetch balance and 10 most recent transaction signatures from `https://api.devnet.solana.com`; return `{ balance_sol, balance_lamports, recent_signatures }` (Req 19.2)
    - Both tools must NEVER accept or return private keys, `Wallet_Seed`, or `PRF_Output` (Req 19.3, 19.4)
    - Invalid inputs return a structured error with a `failure_reason` field and no partial transaction data (Req 19.5)
    - _Requirements: Req 19_
  - [x] 25.2 Write unit tests for MCP server tools
    - Test `inspect_transaction` with a valid base64-encoded unsigned transaction returns correct decoded fields
    - Test `inspect_transaction` rejects invalid base64 with a structured error containing `failure_reason`
    - Test `inspect_transaction` rejects input containing `private_key` field
    - Test `query_devnet` rejects an address that decodes to ≠ 32 bytes
    - Mock `@solana/web3.js` `Connection` for `query_devnet` tests
    - _Requirements: Req 19_

- [x] 26. Kiro steering documents
  - [x] 26.1 Create `.kiro/steering/security.md` enforcing the four security rules: (1) no PRF_Output or private key bytes to disk, (2) no logging of secret material, (3) zero-overwrite memory buffers immediately after use, (4) use platform CSPRNG only (`crypto.getRandomValues()` or `node:crypto.randomBytes()`)
    - Include code examples of correct and incorrect patterns for each rule
    - _Requirements: Req 16.1_
  - [x] 26.2 Create `.kiro/steering/architecture.md` enforcing the three architecture rules: (1) all CTAP2 operations execute in the Electron main process only, (2) all hardware interactions go through `IHardwareIdentityProvider` interface, (3) the Solana layer (`src/main/solana/`, `src/main/transaction/`) SHALL NOT import any CTAP2 or libfido2 modules
    - Include a brief description of the main-process isolation rationale
    - _Requirements: Req 16.2_
  - [x] 26.3 Create `.kiro/steering/testing.md` enforcing the three testing rules: (1) property-based tests use 32-byte `Uint8Array` values as PRF_Output test data, (2) no property-based test connects to real hardware — all use `MockHardwareIdentityProvider`, (3) `MockHardwareIdentityProvider` returns deterministic output for the same `credentialId` input within a single test run
    - Reference `test/mocks/MockHardwareIdentityProvider.ts` as the canonical test fixture
    - _Requirements: Req 16.3_

- [x] 27. Kiro hooks
  - [x] 27.1 Create `.kiro/hooks/security-lint-on-save.json` as a v2 hook file with trigger `PostFileSave`, matcher `src/services/**` (also matching `src/main/derivation/**`, `src/main/hardware/**`, `src/main/session/**`), action `node scripts/security-lint.js {{filePath}}`
    - The hook JSON must use the v2 format: `{ "version": "v1", "hooks": [{ "name": "...", "trigger": "PostFileSave", "matcher": "...", "action": { "type": "command", "command": "..." } }] }`
    - _Requirements: Req 17.1_
  - [x] 27.2 Create `.kiro/hooks/derivation-pbt-on-save.json` as a v2 hook file with trigger `PostFileSave`, matcher `src/main/derivation/**`, action `npx vitest run test/property/derivation.property.test.ts`
    - _Requirements: Req 17.2_
  - [x] 27.3 Create `scripts/security-lint.js` as a Node.js script that reads the file path from `process.argv[2]`, scans the file for violation patterns, and exits with code 2 if any violation is found
    - Check for: `Math.random()` usage, `console.log` or logger calls where the argument name contains `prfOutput`, `walletSeed`, or `secretKey`, `Buffer` or `Uint8Array` variables named with secret names passed to any log call
    - Output format for each violation: `"<filePath>:<lineNumber>: [<RULE_NAME>] <description>"` — one violation per line
    - Exit code 2 on any violation found; exit code 0 if no violations
    - _Requirements: Req 17.1, Req 17.3_

- [x] 28. Custom agent configuration
  - [x] 28.1 Create `agents/crypto-security-reviewer.json` with the agent configuration for the "Crypto Security Reviewer"
    - `scope.include`: `["src/main/hardware/**", "src/main/derivation/**", "src/main/transaction/**"]`
    - `scope.exclude`: `["**/*.test.ts", "**/*.spec.ts"]`
    - `rules` array must list all five rules: `CSPRNG_ONLY`, `NO_SECRET_LOG`, `ZERO_AFTER_USE`, `AUDITED_CRYPTO`, `DOMAIN_SEPARATED_SALT`
    - `outputFormat.fields` must list all four required fields: `["filePath", "lineNumber", "ruleViolated", "remediationSuggestion"]`
    - `outputFormat.requireAllFields: true`
    - _Requirements: Req 20_

- [x] 29. Power definition
  - [x] 29.1 Create `powers/hardware-wallet-security/power.json` referencing the security steering document, the MCP server, and the Crypto Security Reviewer agent by explicit file path
    - `components.steering`: reference `.kiro/steering/security.md` with `loadOnSessionStart: true`
    - `components.mcpServer`: reference `src/mcp/server.ts` with `tools: ["inspect_transaction", "query_devnet"]`
    - `components.agent`: reference `agents/crypto-security-reviewer.json`
    - _Requirements: Req 21.1_
  - [x] 29.2 Create `powers/hardware-wallet-security/README.md` with the three required sections: **Capabilities**, **Exposed Tools**, and **Enforced Security Rules**
    - Capabilities: describe that the power loads security rules on session start, exposes MCP inspection tools, and activates the Crypto Security Reviewer agent
    - Exposed Tools: document `inspect_transaction` (parameters, return values, constraints) and `query_devnet` (parameters, return values, constraints)
    - Enforced Security Rules: list all five agent rules and all four security steering rules
    - _Requirements: Req 21.2_

- [x] 30. Integration tests
  - [x] 30.1 Create `test/integration/DeviceMonitor.integration.test.ts` testing the DeviceMonitor lifecycle with a mock USB event emitter
    - Test device connect → `device-connected` event emitted within 2s
    - Test device disconnect → `device-removed` event emitted within 2s
    - Test `device-unsupported` emitted when `supportsHmacSecret: false`
    - Test 0/1/N credential discovery flows using `MockHardwareIdentityProvider` with configured return values
    - _Requirements: Req 1, Req 3_
  - [x] 30.2 Create `test/integration/session-lifecycle.integration.test.ts` testing the full session lifecycle from credential discovery through termination
    - Test: device connected → credential discovered → wallet derived → session created → balance polling started → device removed → session terminated (keypair zeroed) → balance polling stopped
    - Verify `keypair.secretKey` is zeroed on termination
    - Use `MockHardwareIdentityProvider` and mock `ISolanaService`
    - _Requirements: Req 5, Req 7_

- [x] 31. End-to-end smoke test with mock hardware
  - [x] 31.1 Create `test/integration/e2e-smoke.test.ts` exercising the full main-process service stack end-to-end using `MockHardwareIdentityProvider`
    - Simulate: device connect → credential discovery (0 found → enroll) → derivation → session open → balance fetch → transaction validate + preview → session terminate
    - Assert final state: no session active, no wallet data in memory, all intervals stopped
    - Ensure no TypeScript `any` casts are used in the test itself
    - _Requirements: Req 1, Req 3, Req 4, Req 5, Req 7, Req 8_

- [x] 32. Final checkpoint — All tests pass
  - Run `vitest run` and `npm run build`. Ensure zero TypeScript errors and all tests pass. Ask the user if any questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP implementation
- Task 24 (`Libfido2HardwareIdentityProvider`) requires real hardware and a physical FIDO2 key with `hmac-secret` support; all other tasks are completable in a purely software environment
- Each task references specific requirements for traceability per Req 15.1 and 15.2
- Property-based tests (tasks 7, 15) depend on the `DerivationService` and `TransactionService` being complete but have NO dependency on `Libfido2HardwareIdentityProvider`
- The MCP server (task 25) also has no dependency on hardware integration
- Checkpoints at tasks 8, 16, 23, 32 ensure incremental validation throughout the build

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "3.2"] },
    { "id": 3, "tasks": ["4.1", "5.1"] },
    { "id": 4, "tasks": ["6.1", "9.1"] },
    { "id": 5, "tasks": ["6.2", "7.1", "7.2", "7.3", "7.4", "10.1"] },
    { "id": 6, "tasks": ["9.2", "11.1", "12.1"] },
    { "id": 7, "tasks": ["10.2", "11.2", "12.2", "13.1"] },
    { "id": 8, "tasks": ["14.1", "13.2"] },
    { "id": 9, "tasks": ["14.2", "15.1", "15.2", "15.3"] },
    { "id": 10, "tasks": ["17.1"] },
    { "id": 11, "tasks": ["18.1"] },
    { "id": 12, "tasks": ["19.1", "19.2"] },
    { "id": 13, "tasks": ["20.1"] },
    { "id": 14, "tasks": ["21.1"] },
    { "id": 15, "tasks": ["22.1"] },
    { "id": 16, "tasks": ["24.1", "25.1"] },
    { "id": 17, "tasks": ["25.2", "26.1", "26.2", "26.3"] },
    { "id": 18, "tasks": ["27.1", "27.2", "27.3", "28.1"] },
    { "id": 19, "tasks": ["29.1", "30.1"] },
    { "id": 20, "tasks": ["29.2", "30.2"] },
    { "id": 21, "tasks": ["31.1"] }
  ]
}
```
