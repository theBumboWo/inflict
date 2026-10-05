# Design Document — KeyWallet

## Overview

KeyWallet is a cross-platform Electron desktop application (devnet only) that derives a deterministic Solana Ed25519 wallet from a FIDO2/WebAuthn hardware security key. There is no account registration, no seed phrase, no server, and no cloud component. The same physical hardware key produces the same wallet identity on any computer; different physical keys produce different identities.

This document covers the full technical design: architecture, component interfaces, data models, cryptographic derivation pipeline, IPC schema, threat model, error handling, testing strategy, and the concrete plan for all seven Kiro feature integration lessons (spec-driven dev, steering documents, hooks, property-based testing, Powers, MCP, custom agents).

### Key Design Principles

1. **Main-process isolation** — all CTAP2/libfido2 interactions happen exclusively in the Electron main process. The renderer never touches native hardware.
2. **Abstraction boundary** — a `HardwareIdentityProvider` interface wraps every CTAP2 operation so the software mock can substitute for real hardware in tests and CI.
3. **No secret persistence** — PRF_Output, Wallet_Seed, and private key bytes never leave memory. All sensitive buffers are zero-overwritten immediately after use.
4. **Devnet only** — the Solana layer is hard-wired to the devnet cluster; no mainnet endpoint is configurable or reachable.
5. **Prototype scope** — KeyWallet is an explicit prototype demonstrating spec-driven, hardware-key-bound wallet derivation. It is not a production wallet.

### Research Findings (Summary)

The following findings, validated in the requirements document, directly inform the design:

| Finding | Design Impact |
|---|---|
| PRF is authenticator-bound (Finding 1) | Same PRF_Output on any machine → portable identity |
| Discoverable credentials required for cross-machine use (Finding 2) | `requireResidentKey: true` at enrollment |
| hmac-secret broadly supported on roaming hardware keys (Finding 3) | No device allowlist — use capability flag |
| node-hid + TypeScript CTAP2 chosen as integration path (Finding 4) | `NodeHidHardwareIdentityProvider`; N-API binary; no system DLLs required |
| PRF output → HKDF → Ed25519 seed (Finding 5) | Two-step HKDF chain (see §Wallet Derivation) |
| Platform authenticators must be rejected (Finding 6) | `authenticatorAttachment: "cross-platform"` enforced |
| Architecture: libfido2 in main process via HardwareIdentityProvider (Finding 7) | All CTAP2 calls go through the abstraction |

---

## Architecture

### Layer Diagram

```
┌────────────────────────────────────────────────────────────┐
│                  Electron Renderer Process                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            React UI (src/renderer/)                  │  │
│  │  IdleView │ EnrollView │ WalletView │ SendView │ ...  │  │
│  └────────────────────┬─────────────────────────────────┘  │
│                       │ contextBridge API (typed)           │
│  ┌────────────────────▼─────────────────────────────────┐  │
│  │         Preload Script (src/preload/index.ts)         │  │
│  │  Exposes: wallet.*, device.*, tx.*, session.*        │  │
│  └────────────────────┬─────────────────────────────────┘  │
└───────────────────────│────────────────────────────────────┘
                        │ ipcRenderer.invoke / ipcMain.handle
┌───────────────────────▼────────────────────────────────────┐
│                  Electron Main Process                       │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  DeviceMonitor  │  │ EnrollmentService│                  │
│  │  (src/main/     │  │ (src/main/       │                  │
│  │   device/)      │  │  enrollment/)    │                  │
│  └────────┬────────┘  └────────┬────────┘                  │
│           │                    │                            │
│  ┌────────▼────────────────────▼────────────────────────┐  │
│  │          HardwareIdentityProvider interface           │  │
│  │          (src/main/hardware/IHardwareIdentity         │  │
│  │           Provider.ts)                                │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │  Libfido2HardwareIdentityProvider               │ │  │
│  │  │  (src/main/hardware/Libfido2HardwareIdentity    │ │  │
│  │  │   Provider.ts) — production                     │ │  │
│  │  ├─────────────────────────────────────────────────┤ │  │
│  │  │  MockHardwareIdentityProvider                   │ │  │
│  │  │  (src/test/mocks/MockHardwareIdentityProvider   │ │  │
│  │  │   .ts) — tests/CI                               │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │ DerivationService│  │ SessionService  │                  │
│  │ (src/main/       │  │ (src/main/      │                  │
│  │  derivation/)    │  │  session/)      │                  │
│  └─────────────────┘  └─────────────────┘                  │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  SolanaService  │  │TransactionService│                 │
│  │ (src/main/      │  │ (src/main/       │                  │
│  │  solana/)       │  │  transaction/)   │                  │
│  └─────────────────┘  └─────────────────┘                  │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────────────────────┐  │
│  │ CredentialStore │  │       MCP Server                │  │
│  │ (src/main/      │  │  (src/mcp/server.ts)            │  │
│  │  storage/)      │  │  inspect_transaction            │  │
│  └─────────────────┘  │  query_devnet                   │  │
│                        └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Process Separation Rule

> **All CTAP2 operations and native libfido2 calls execute in the main process only.**  
> The renderer process runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.  
> The preload script exposes a minimal typed API via `contextBridge`. No renderer module may `require` or `import` any CTAP2, libfido2, or `@solana/web3.js` module.

### Platform Support Tiers

| Tier | Platform | Status |
|---|---|---|
| 1 | Windows 10 1903+ x64 | Fully tested |
| 2 | macOS 12+ x64/arm64 | Packaged, hardware verification pending |
| 3 | Linux x64 | Development only |

### Module Directory Layout

```
src/
├── main/
│   ├── index.ts                  # Electron app entry, IPC handler registration
│   ├── hardware/
│   │   ├── IHardwareIdentityProvider.ts   # Interface definition
│   │   ├── Libfido2HardwareIdentityProvider.ts
│   │   └── types.ts
│   ├── device/
│   │   └── DeviceMonitor.ts
│   ├── enrollment/
│   │   └── EnrollmentService.ts
│   ├── derivation/
│   │   ├── DerivationService.ts
│   │   └── hkdf.ts              # HKDF-SHA256 wrapper (Node crypto)
│   ├── session/
│   │   └── SessionService.ts
│   ├── solana/
│   │   └── SolanaService.ts
│   ├── transaction/
│   │   └── TransactionService.ts
│   └── storage/
│       └── CredentialStore.ts
├── preload/
│   └── index.ts                  # contextBridge exposure
├── renderer/
│   ├── App.tsx
│   ├── views/
│   │   ├── IdleView.tsx
│   │   ├── EnrollView.tsx
│   │   ├── WalletView.tsx
│   │   └── SendView.tsx
│   └── hooks/
│       └── useWalletState.ts
├── mcp/
│   └── server.ts                 # MCP server: inspect_transaction, query_devnet
└── shared/
    └── ipc-types.ts              # Shared IPC message types (main ↔ preload)

test/
├── unit/
│   ├── DerivationService.test.ts
│   ├── TransactionService.test.ts
│   ├── SessionService.test.ts
│   └── EnrollmentService.test.ts
├── property/
│   ├── derivation.property.test.ts
│   └── transaction.property.test.ts
├── integration/
│   └── DeviceMonitor.integration.test.ts
└── mocks/
    └── MockHardwareIdentityProvider.ts

.kiro/
├── specs/key-wallet/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
├── steering/
│   ├── security.md
│   ├── architecture.md
│   └── testing.md
└── hooks/
    ├── security-lint-on-save.json
    └── derivation-pbt-on-save.json

powers/
└── hardware-wallet-security/
    ├── README.md
    ├── power.json
    └── mcp/
        └── server.ts   (symlink or reference)

agents/
└── crypto-security-reviewer.json
```

---

## Components and Interfaces

### HardwareIdentityProvider

This is the central abstraction. All CTAP2/libfido2 operations flow through this interface. The production implementation uses libfido2; the test implementation uses a deterministic software mock.

```typescript
// src/main/hardware/IHardwareIdentityProvider.ts

export interface DeviceInfo {
  /** CTAP2 device path (e.g. "/dev/hidraw0", USB HID path on Windows) */
  devicePath: string;
  /** Whether the device supports hmac-secret extension */
  supportsHmacSecret: boolean;
  /** Whether the device supports discoverable (resident) credentials */
  supportsResidentKey: boolean;
  /** Raw authenticatorGetInfo response extensions array */
  extensions: string[];
}

export interface EnrollmentOptions {
  rpId: string;                    // "key-wallet.local"
  rpName: string;                  // "KeyWallet"
  userId: Uint8Array;              // 16-byte CSPRNG random
  userName: string;                // Display name for credential selector
  userDisplayName: string;
  requireResidentKey: true;
  userVerification: "required";
  authenticatorAttachment: "cross-platform";
}

export interface EnrollmentResult {
  credentialId: Uint8Array;
  /** "cross-platform" | "platform" — must be "cross-platform" to be accepted */
  authenticatorAttachment: string;
  /** Public key bytes (Ed25519 public key on the FIDO credential, not the Solana key) */
  publicKeyBytes: Uint8Array;
}

export interface DiscoveryResult {
  credentials: Array<{
    credentialId: Uint8Array;
    userDisplayName: string;
    userId: Uint8Array;
  }>;
}

export interface AssertionOptions {
  rpId: string;
  credentialId: Uint8Array;
  /** Fixed 32-byte domain-separated PRF_Salt constant */
  hmacSalt: Uint8Array;
  userVerification: "required";
}

export interface AssertionResult {
  /** The 32-byte PRF_Output from hmac-secret extension */
  hmacOutput: Uint8Array;
  credentialId: Uint8Array;
}

export type CtapErrorCode =
  | "CTAP2_ERR_PIN_INVALID"
  | "CTAP2_ERR_PIN_BLOCKED"
  | "CTAP2_ERR_NO_CREDENTIALS"
  | "CTAP2_ERR_KEY_STORE_FULL"
  | "CTAP2_ERR_OPERATION_DENIED"
  | "CTAP2_ERR_NOT_ALLOWED"
  | "UNKNOWN";

export class CtapError extends Error {
  constructor(
    public readonly code: CtapErrorCode,
    public readonly userMessage: string,
    message?: string
  ) {
    super(message ?? userMessage);
    this.name = "CtapError";
  }
}

export interface IHardwareIdentityProvider {
  /**
   * Returns info about all currently connected FIDO2 devices.
   * Uses authenticatorGetInfo command.
   */
  listDevices(): Promise<DeviceInfo[]>;

  /**
   * Enumerates discoverable credentials for the given RP ID on the device.
   * Requires CTAP2 credential management support.
   */
  discoverCredentials(
    devicePath: string,
    rpId: string
  ): Promise<DiscoveryResult>;

  /**
   * Creates a new discoverable (resident) credential on the device.
   * Must set requireResidentKey: true and authenticatorAttachment: "cross-platform".
   */
  createCredential(
    devicePath: string,
    options: EnrollmentOptions
  ): Promise<EnrollmentResult>;

  /**
   * Performs a CTAP2 GetAssertion with hmac-secret extension.
   * Returns the 32-byte PRF_Output.
   */
  getAssertion(
    devicePath: string,
    options: AssertionOptions
  ): Promise<AssertionResult>;
}
```

### DeviceMonitor

```typescript
// src/main/device/DeviceMonitor.ts

export type DeviceEvent =
  | { type: "device-connected"; devicePath: string; info: DeviceInfo }
  | { type: "device-removed"; devicePath: string }
  | { type: "device-unsupported"; devicePath: string; reason: string };

export interface IDeviceMonitor {
  start(): void;
  stop(): void;
  on(event: "device-connected", listener: (e: DeviceEvent) => void): void;
  on(event: "device-removed", listener: (e: DeviceEvent) => void): void;
  on(event: "device-unsupported", listener: (e: DeviceEvent) => void): void;
}
```

The monitor uses a 500ms polling interval against `IHardwareIdentityProvider.listDevices()`. On each poll it diffs the current device list against the previous one, emitting `device-connected` for new entries and `device-removed` for entries that disappeared. On first detection, it issues `authenticatorGetInfo` (through the provider) and emits `device-unsupported` if the `hmac-secret` extension flag is absent.

### EnrollmentService

```typescript
// src/main/enrollment/EnrollmentService.ts

export type EnrollmentState =
  | "idle"
  | "checking-pin"
  | "awaiting-touch"
  | "storing-metadata"
  | "complete"
  | "failed";

export interface IEnrollmentService {
  /**
   * Initiates credential enrollment on the connected device.
   * Returns the Credential_ID on success.
   * Throws CtapError with appropriate code on failure.
   */
  enroll(
    devicePath: string,
    displayName: string,
    signal: AbortSignal
  ): Promise<{ credentialId: Uint8Array }>;
}
```

### DerivationService

```typescript
// src/main/derivation/DerivationService.ts

import type { Keypair } from "@solana/web3.js";

export interface DerivationResult {
  keypair: Keypair;
  walletAddress: string;   // Base58-encoded public key
}

export type DerivationError =
  | { kind: "user-cancelled" }
  | { kind: "authenticator-error"; ctapCode: CtapErrorCode }
  | { kind: "key-derivation-error"; detail: string };

export interface IDerivationService {
  /**
   * Invokes hmac-secret on the device, runs two-step HKDF,
   * constructs the Ed25519 keypair.
   * Zero-overwrites PRF_Output and Wallet_Seed before returning.
   */
  deriveWallet(
    devicePath: string,
    credentialId: Uint8Array,
    signal: AbortSignal
  ): Promise<DerivationResult>;
}
```

### SessionService

```typescript
// src/main/session/SessionService.ts

import type { Keypair } from "@solana/web3.js";

export interface Session {
  sessionId: string;           // UUID v4
  walletAddress: string;       // Base58 public key
  /** Keypair held in memory only — never persisted */
  keypair: Keypair;
  devicePath: string;
  credentialId: Uint8Array;
  displayName: string;
  createdAt: Date;
}

export interface ISessionService {
  createSession(
    devicePath: string,
    credentialId: Uint8Array,
    displayName: string,
    keypair: Keypair
  ): Session;

  getActiveSession(): Session | null;

  /**
   * Zero-overwrites keypair private key bytes and clears session state.
   * Must complete within 200ms of device-removed event.
   */
  terminateSession(sessionId: string): void;

  isSessionActive(): boolean;
}
```

### SolanaService

```typescript
// src/main/solana/SolanaService.ts

export interface BalanceResult {
  lamports: bigint;
  sol: string;   // Formatted to 4 decimal places
  fetchedAt: Date;
}

export interface ISolanaService {
  /**
   * Fetches lamport balance from devnet RPC.
   * Throws on timeout (>15s) or network error.
   */
  getBalance(walletAddress: string): Promise<BalanceResult>;

  /**
   * Returns the most recent 10 transaction signatures for the address.
   */
  getRecentTransactions(walletAddress: string): Promise<string[]>;

  /**
   * Fetches a recent blockhash with 10-second timeout.
   */
  getRecentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;

  startPeriodicRefresh(walletAddress: string, intervalMs: number): void;
  stopPeriodicRefresh(): void;
}
```

The connection is constructed once at startup with:
```typescript
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
```
No user-configurable RPC endpoint exists. Mainnet and testnet cluster URLs are absent from the codebase entirely.

### TransactionService

```typescript
// src/main/transaction/TransactionService.ts

import type { Keypair } from "@solana/web3.js";

export interface TransferParams {
  destinationAddress: string;
  lamports: bigint;
  currentBalanceLamports: bigint;
}

export interface TransactionPreview {
  destinationAddress: string;
  amountSol: string;          // Formatted to 9 decimal places
  estimatedFeeSol: string;
  blockhash: string;
}

export interface SubmitResult {
  signature: string;
}

export type TransactionValidationError =
  | { field: "destination"; reason: string }
  | { field: "amount"; reason: string };

export interface ITransactionService {
  validateTransferParams(params: TransferParams): TransactionValidationError | null;
  buildTransactionPreview(params: TransferParams): Promise<TransactionPreview>;
  /**
   * Signs using the in-memory keypair. Never persists the private key.
   */
  signAndSubmit(
    params: TransferParams,
    keypair: Keypair,
    signal: AbortSignal
  ): Promise<SubmitResult>;
}
```

### CredentialStore

```typescript
// src/main/storage/CredentialStore.ts

/** Only non-secret metadata is stored. No PRF_Output, Wallet_Seed, or private key bytes. */
export interface StoredCredentialMetadata {
  credentialId: string;     // hex-encoded bytes
  rpId: string;             // "key-wallet.local"
  displayName: string;
  createdAt: string;        // ISO 8601
}

export interface ICredentialStore {
  save(meta: StoredCredentialMetadata): Promise<void>;
  findAll(): Promise<StoredCredentialMetadata[]>;
  delete(credentialId: string): Promise<void>;
}
```

Storage is in a JSON file at `{app.getPath("userData")}/credentials.json`. The file contains no secret material.

---

## Data Models

### IPC Message Schema

The preload script exposes a typed API via `contextBridge`. All renderer ↔ main communication uses these channels.

```typescript
// src/shared/ipc-types.ts

// ─── Outgoing (renderer → main) ───────────────────────────────────────────────
export type IpcRequest =
  | { channel: "device:list" }
  | { channel: "enrollment:start"; payload: { displayName: string } }
  | { channel: "enrollment:cancel" }
  | { channel: "credential:discover"; payload: { devicePath: string } }
  | { channel: "credential:select"; payload: { credentialId: string } }
  | { channel: "wallet:derive"; payload: { devicePath: string; credentialId: string } }
  | { channel: "session:get" }
  | { channel: "session:terminate" }
  | { channel: "balance:get" }
  | { channel: "balance:refresh" }
  | { channel: "transaction:validate"; payload: TransferParams }
  | { channel: "transaction:preview"; payload: TransferParams }
  | { channel: "transaction:submit"; payload: TransferParams }
  | { channel: "address:copy" };

// ─── Incoming (main → renderer via event) ─────────────────────────────────────
export type IpcEvent =
  | { event: "device:connected"; data: { devicePath: string; supportsHmacSecret: boolean } }
  | { event: "device:removed"; data: { devicePath: string } }
  | { event: "device:unsupported"; data: { reason: string } }
  | { event: "session:changed"; data: SessionPublicData | null }
  | { event: "balance:updated"; data: { sol: string; lamports: string } }
  | { event: "balance:unavailable" }
  | { event: "enrollment:progress"; data: { stage: EnrollmentState } }
  | { event: "error"; data: { category: ErrorCategory; message: string } };

/** Safe public session data: no private key material */
export interface SessionPublicData {
  sessionId: string;
  walletAddress: string;
  displayName: string;
  credentialId: string;
}

export type ErrorCategory =
  | "device-error"
  | "pin-required"
  | "pin-locked"
  | "operation-not-supported"
  | "enrollment-failed"
  | "derivation-failed"
  | "rpc-timeout"
  | "rpc-unreachable"
  | "rpc-invalid-response"
  | "transaction-invalid"
  | "session-locked"
  | "unknown";
```

### Credential Storage Schema

```json
{
  "version": 1,
  "credentials": [
    {
      "credentialId": "a1b2c3d4...",
      "rpId": "key-wallet.local",
      "displayName": "My YubiKey",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### In-Memory Session Model

```
Session {
  sessionId:     string       (UUID v4, monotonic per app run)
  walletAddress: string       (Base58 Solana public key, 32-44 chars)
  keypair:       Keypair      (in-memory only, never serialized)
  devicePath:    string       (OS HID path)
  credentialId:  Uint8Array   (binary, from authenticator)
  displayName:   string
  createdAt:     Date
}
```

---

## Data Flows

### Flow 1: First-Time Enrollment

```
User plugs in hardware key
        │
        ▼
DeviceMonitor.poll() detects new device
        │
        ├──> authenticatorGetInfo ──> libfido2 ──> device
        │           hmac-secret flag present?
        │               │ NO ──> emit device-unsupported
        │               │ YES
        ▼
DeviceMonitor emits device-connected
        │
        ▼
EnrollmentService.discoverCredentials(rpId="key-wallet.local")
        │
        │ No credentials found
        ▼
UI: Show EnrollView (prompt user)
        │
        ▼
User clicks "Enroll Key"
        │
        ▼
EnrollmentService.enroll(devicePath, displayName, signal)
  ├── Check PIN set? (authenticatorGetInfo → clientPin flag)
  │       │ Not set → UI: prompt user to set PIN first
  │
  ├── createCredential(devicePath, {
  │       rpId: "key-wallet.local",
  │       requireResidentKey: true,
  │       userVerification: "required",
  │       authenticatorAttachment: "cross-platform"
  │   })
  │       ↓ User touches key, enters PIN on device
  │       ↓ libfido2 ↔ device (120s timeout)
  │
  ├── Verify response.authenticatorAttachment === "cross-platform"
  │       │ "platform" → reject, show error
  │
  └── CredentialStore.save({ credentialId, rpId, displayName })

        │
        ▼
DerivationService.deriveWallet(devicePath, credentialId, signal)
  [see Flow 3]
        │
        ▼
SessionService.createSession(...)
        │
        ▼
UI: WalletView (Wallet_Address, balance)
```

### Flow 2: Returning User (Credential Discovery)

```
User plugs in key (previously enrolled)
        │
        ▼
DeviceMonitor emits device-connected
        │
        ▼
CredentialStore.findAll() → check if credentialId cached locally
        │
  Found in cache? ──YES──> skip CTAP2 enumeration, use cached credentialId
        │ NO
        ▼
EnrollmentService.discoverCredentials(devicePath, "key-wallet.local")
        │
  0 found ──> EnrollView
  1 found ──> deriveWallet(credentialId) [Flow 3]
  N>1 found ──> CredentialSelectionView
                (list by displayName, max 20)
                User selects one
                deriveWallet(selectedCredentialId) [Flow 3]
```

### Flow 3: Wallet Derivation

```
DerivationService.deriveWallet(devicePath, credentialId, signal)

Step 1: Retrieve PRF_Salt constant (computed once at startup)
  PRF_Salt = HKDF-SHA256(
    IKM  = UTF8("key-wallet-prf-salt-v1"),    // 22 bytes
    salt = Buffer.alloc(0),                    // empty
    info = UTF8("solana-wallet-derivation"),   // 26 bytes
    length = 32
  )
  → 32-byte constant, hard-coded at build time after first computation

Step 2: GetAssertion (CTAP2 hmac-secret)
  provider.getAssertion(devicePath, {
    rpId: "key-wallet.local",
    credentialId,
    hmacSalt: PRF_SALT_CONSTANT,   // 32 bytes
    userVerification: "required"
  })
  → { hmacOutput: Uint8Array(32) }  ← PRF_Output
  (User touches key, enters PIN)

Step 3: Derive Wallet_Seed
  Wallet_Seed = HKDF-SHA256(
    IKM  = PRF_Output,                         // 32 bytes from device
    salt = Buffer.alloc(0),                    // empty
    info = UTF8("key-wallet:solana:ed25519:v1"), // 32 bytes
    length = 32
  )

Step 4: Construct Keypair
  keypair = Keypair.fromSeed(Wallet_Seed)      // @solana/web3.js

Step 5: Zero-overwrite sensitive buffers
  PRF_Output.fill(0)
  Wallet_Seed.fill(0)

Step 6: Return { keypair, walletAddress: keypair.publicKey.toBase58() }

Error paths:
  CTAP2 error → CtapError → discard PRF_Output (if any) → return DerivationError
  User cancel → discard PRF_Output (if any) → return { kind: "user-cancelled" }
  AbortSignal fired → same as user cancel
```

### HKDF Parameter Table

| Step | Role | IKM | Salt | Info | Length |
|---|---|---|---|---|---|
| Step 1 (PRF_Salt constant) | Produce deterministic application salt | `"key-wallet-prf-salt-v1"` (UTF-8) | empty | `"solana-wallet-derivation"` (UTF-8) | 32 bytes |
| Step 2 (Wallet_Seed) | Derive Ed25519 seed from PRF output | PRF_Output (32-byte device secret) | empty | `"key-wallet:solana:ed25519:v1"` (UTF-8) | 32 bytes |

Both steps use the Node.js built-in `crypto.hkdfSync` (available since Node 15) or the `panva/hkdf` package for environments where the sync form is unavailable.

### Flow 4: Transaction Construction and Signing

```
User fills SendView form (destination, amount)
        │
        ▼
TransactionService.validateTransferParams({
  destinationAddress,
  lamports,
  currentBalanceLamports
})
  ├── destinationAddress: Base58-decode → must be exactly 32 bytes
  ├── lamports: must be ≥ 1
  └── lamports: must be ≤ (currentBalanceLamports - estimatedFee)
  → null (valid) or TransactionValidationError

        │ valid
        ▼
TransactionService.buildTransactionPreview(params)
  ├── SolanaService.getRecentBlockhash()  (10s timeout)
  ├── SystemProgram.transfer({ fromPubkey, toPubkey, lamports })
  └── returns TransactionPreview (no signing yet)

        │
        ▼
UI: ConfirmationView (destination, amount, fee, blockhash)
User clicks "Confirm & Send"
        │
        ▼
TransactionService.signAndSubmit(params, session.keypair, signal)
  ├── Build Transaction with blockhash (must be < 60s old)
  ├── transaction.sign(session.keypair)
  ├── connection.sendRawTransaction(transaction.serialize())
  └── returns { signature: string }

  Error paths:
    blockhash timeout → abort, show "RPC Timeout" error
    session terminated mid-signing → abort, discard signed bytes
    RPC submission error → hold signed tx in memory (30s), offer retry once
```

### Flow 5: Session Teardown

```
DeviceMonitor emits device-removed (or DeviceMonitor watchdog fires)
        │
        ▼
SessionService.terminateSession(sessionId)
  ├── keypair.secretKey.fill(0)     // zero-overwrite 64-byte private key
  ├── Clear session object from memory
  └── Must complete within 200ms

        │
        ▼
SolanaService.stopPeriodicRefresh()

        │
        ▼
TransactionService: if operation in progress → abort (2s limit)
  ├── Discard signed transaction bytes
  └── Discard all derivation/signing intermediate state

        │
        ▼
UI returns to IdleView within 500ms
```

---

## Threat Model

### Attack Surfaces

| Surface | Threat | Mitigation |
|---|---|---|
| Renderer process | XSS, prototype pollution, renderer compromise | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Renderer never sees private key material. |
| IPC channel (renderer → main) | Malicious renderer invoking signing | IPC handlers in main process validate session state; renderer only receives `SessionPublicData` (no keypair). |
| Disk storage | Credential metadata exfiltration | Only `credentialId` (opaque bytes) + display name stored. No PRF_Output, Wallet_Seed, or private key material ever written to disk. |
| Memory | Cold-boot attack, memory scraping | PRF_Output and Wallet_Seed zero-overwritten immediately after use. Private key bytes zero-overwritten on session termination. |
| libfido2 native addon | Malicious native code | Use official Yubico libfido2 release; pin dependency version; enable reproducible builds. |
| Platform authenticator enrollment | User accidentally enrolls iCloud passkey | `authenticatorAttachment: "cross-platform"` enforced in request + verified in response; platform attachment rejected. |
| PIN not set | Low-assurance derivation (no UV) | `userVerification: "required"` enforced; enrollment aborts if no PIN set. |
| Physical key theft | Attacker with key performs derivation | UV (PIN) required; key alone is insufficient. |
| CTAP2 raw error exposure | Information leakage to renderer | CTAP2 error codes mapped to `ErrorCategory` enum; raw codes never sent to renderer or logged. |
| Mainnet transaction | Accidental mainnet funds loss | Devnet RPC hardcoded; no mainnet RPC URL present in codebase. |
| MCP tool misuse | AI assistant extracts private key via MCP | MCP tools (`inspect_transaction`, `query_devnet`) accept no secret parameters; reject private keys, seeds, PRF outputs. |
| Log leakage | Secret material in log files | Logger wrapper strips all Buffer/Uint8Array values from log arguments in production; `DerivationService` never passes secrets to any logger. |

### Prototype Limitations

These limitations are by design and must be documented in the application UI:

1. **No backup**: Loss or destruction of the hardware key means permanent loss of wallet access. There is no seed phrase backup.
2. **Windows privilege**: On Windows, libfido2 requires either Administrator privileges or Windows 10 1903+ with `WebAuthn.dll` routing.
3. **Resident credential slot exhaustion**: Most hardware keys have 8–100 resident credential slots. The app shows a clear error if the slot is full.
4. **Devnet only**: All SOL on devnet has no real-world monetary value. The app contains no mainnet functionality.
5. **Key reset means wallet loss**: Resetting the hardware key destroys the FIDO2 credential and wallet access is permanently lost.

---

## Wallet Derivation Design

### PRF_Salt Constant Derivation (Build-Time Computation)

The PRF_Salt is computed once using HKDF-SHA256 with domain-separated inputs and stored as a hardcoded constant in the source. It is NOT secret — it is a fixed application constant.

```typescript
// src/main/derivation/hkdf.ts

import { createHmac, hkdfSync } from "node:crypto";

/** Computes HKDF-SHA256 using Node.js built-in crypto */
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
 * PRF_SALT_CONSTANT — a fixed 32-byte application constant.
 * Computed via HKDF-SHA256(
 *   IKM  = UTF8("key-wallet-prf-salt-v1"),
 *   salt = empty,
 *   info = UTF8("solana-wallet-derivation"),
 *   L    = 32
 * )
 *
 * This value is NOT secret. It is a deterministic domain separator
 * supplied to the hardware key's hmac-secret function.
 */
export const PRF_SALT_CONSTANT: Readonly<Uint8Array> = (() => {
  return hkdf(
    Buffer.from("key-wallet-prf-salt-v1", "utf8"),
    Buffer.alloc(0),
    Buffer.from("solana-wallet-derivation", "utf8"),
    32
  );
})();
```

### Wallet_Seed Derivation (Runtime)

```typescript
// src/main/derivation/DerivationService.ts (pseudocode)

async function deriveWallet(
  devicePath: string,
  credentialId: Uint8Array,
  signal: AbortSignal
): Promise<DerivationResult> {
  // Step 1: Invoke hmac-secret via provider
  const assertion = await provider.getAssertion(devicePath, {
    rpId: RP_ID,                    // "key-wallet.local"
    credentialId,
    hmacSalt: PRF_SALT_CONSTANT,    // 32-byte constant
    userVerification: "required",
  });
  // assertion.hmacOutput is PRF_Output: 32 bytes

  // Step 2: Derive Wallet_Seed via HKDF
  let walletSeed: Buffer;
  try {
    walletSeed = hkdf(
      assertion.hmacOutput,
      Buffer.alloc(0),
      Buffer.from("key-wallet:solana:ed25519:v1", "utf8"),
      32
    );

    // Step 3: Construct keypair
    const keypair = Keypair.fromSeed(walletSeed);
    const walletAddress = keypair.publicKey.toBase58();

    return { keypair, walletAddress };
  } finally {
    // Step 4: Zero-overwrite sensitive buffers (always, even on error)
    assertion.hmacOutput.fill(0);
    if (walletSeed!) walletSeed.fill(0);
  }
}
```

### Buffer Zeroing Strategy

All sensitive buffers must be explicitly zeroed. The `finally` block pattern above ensures zeroing even on exception. For Solana's `Keypair`, the private key bytes are in `keypair.secretKey` (a `Uint8Array` of 64 bytes — the first 32 are the seed, the last 32 are the public key). On session termination:

```typescript
session.keypair.secretKey.fill(0);
```

Note: JavaScript's garbage collector may copy objects. The zeroing strategy is best-effort from a GC perspective — it eliminates the primary copies held by the application. JVM-style JIT pinning of sensitive buffers is not available in V8, which is an accepted limitation of the prototype.

---

## Credential Enrollment and Discovery Model

### Enrollment Sequence

```
1. User initiates enrollment via UI
2. EnrollmentService checks if Authenticator has PIN set (via authenticatorGetInfo clientPins field)
   - If not: prompt user to set PIN, poll until confirmed or 300s elapses
3. EnrollmentService calls provider.createCredential() with:
   - rpId: "key-wallet.local"
   - requireResidentKey: true
   - userVerification: "required"
   - authenticatorAttachment: "cross-platform"
   - userId: 16 random bytes from crypto.getRandomValues()
   - userName: userDisplayName (user-supplied label)
4. User touches key and enters PIN (handled by device/OS)
5. On success:
   - Verify response.authenticatorAttachment === "cross-platform"
     → if "platform": reject, display error
   - Store { credentialId (hex), rpId, displayName, createdAt } to CredentialStore
   - Proceed to deriveWallet()
6. On timeout (>120s): abort, clear state, return to idle
7. On CTAP2 error: map to ErrorCategory, display, return to idle
```

### Local Metadata Cache

The `CredentialStore` acts as an optimization cache. When a device is reconnected, the app first checks the local cache for a matching `credentialId`. If found, it skips the CTAP2 `authenticatorEnumerateRPsBegin` command (which requires a PIN on some firmware) and proceeds directly to `getAssertion`.

If the local `credentialId` is not found on the device during assertion (CTAP2_ERR_NO_CREDENTIALS), the app detects the stale metadata, presents the user with re-enroll or clear options, and requires explicit confirmation before deleting the stale entry.

---

## Solana Transaction and Signing Design

### Transaction Construction

```typescript
// Pseudocode — TransactionService.buildTransactionPreview

const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
// blockhash has ~60-second validity window; tracked for expiry

const instruction = SystemProgram.transfer({
  fromPubkey: new PublicKey(session.walletAddress),
  toPubkey: new PublicKey(params.destinationAddress),
  lamports: params.lamports,
});

const transaction = new Transaction()
  .add(instruction);

transaction.recentBlockhash = blockhash;
transaction.feePayer = new PublicKey(session.walletAddress);

// Estimate fee
const feeCalculator = await connection.getFeeForMessage(
  transaction.compileMessage()
);
```

### Address Validation

```typescript
function validateDestinationAddress(address: string): boolean {
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 32 && address.length >= 32 && address.length <= 44;
  } catch {
    return false;
  }
}
```

### Amount Validation

```typescript
function validateAmount(
  lamports: bigint,
  balanceLamports: bigint,
  estimatedFeeLamports: bigint
): boolean {
  if (lamports < 1n) return false;
  if (lamports > balanceLamports - estimatedFeeLamports) return false;
  return true;
}
```

### Signing

The `Keypair` lives exclusively in `SessionService` memory. `TransactionService` receives it as a parameter for the duration of the signing call. It is never stored in `TransactionService` state.

```typescript
transaction.sign(keypair);
const rawTransaction = transaction.serialize();
const signature = await connection.sendRawTransaction(rawTransaction);
```

---

## Error Handling

### Error Classification and UI Mapping

| Error Source | Error Condition | User-Visible Category | UI State | Recovery |
|---|---|---|---|---|
| DeviceMonitor | No CTAP2 response in 5s | "Device could not be verified" | Unsupported device view | Reconnect key |
| DeviceMonitor | hmac-secret flag absent | "Device does not support required PRF capability" | Unsupported device view, compatible devices listed | Try different key |
| EnrollmentService | No PIN set | Guided PIN-setup message | Pause enrollment flow | User sets PIN, then retry |
| EnrollmentService | `authenticatorAttachment: "platform"` in response | "Only portable hardware security keys are supported" | Error view, help text | Use hardware key |
| EnrollmentService | CTAP2_ERR_KEY_STORE_FULL | "Device credential storage is full" | Error view | Free up credential slots |
| EnrollmentService | CTAP2_ERR_PIN_BLOCKED | "Device PIN is locked" | Warning view, retry disabled | Do not reset without backup |
| EnrollmentService | Timeout (120s) | Generic enrollment failed | Return to idle | Retry enrollment |
| EnrollmentService | User cancel | (no error shown) | Return to idle | — |
| CredentialStore | Local credentialId not on device | "Stored credential no longer valid" | Mismatch error view, re-enroll or clear options | Explicit confirmation before delete |
| DerivationService | CTAP2_ERR_PIN_INVALID | PIN incorrect (user-facing count from device) | Error view | Retry (up to device limit) |
| DerivationService | CTAP2_ERR_PIN_BLOCKED | "Device PIN is locked" | Warning, retry disabled | — |
| DerivationService | User cancel | Return to credential selection or idle | — | — |
| SolanaService | RPC timeout (>15s) | "Balance unavailable — RPC timeout" | Balance unavailable indicator | Retry with exponential backoff |
| SolanaService | Network error | "Balance unavailable — RPC unreachable" | Balance unavailable indicator | Automatic retry |
| TransactionService | Invalid destination | Inline validation error on address field | SendView, form invalid | User corrects |
| TransactionService | Invalid amount | Inline validation error on amount field | SendView, form invalid | User corrects |
| TransactionService | Blockhash timeout (>10s) | "Network unavailable — could not fetch blockhash" | Error toast | Retry |
| TransactionService | RPC submission error | Error category + offer retry | Error view, signed tx held 30s | One retry |
| SessionService | Device removed during operation | Session aborted | Return to idle, all wallet UI cleared | Reconnect key |

### Error Category Mapping (CTAP2 → User)

```typescript
function mapCtapError(code: CtapErrorCode): ErrorCategory {
  switch (code) {
    case "CTAP2_ERR_PIN_INVALID":  return "pin-required";
    case "CTAP2_ERR_PIN_BLOCKED":  return "pin-locked";
    case "CTAP2_ERR_NO_CREDENTIALS": return "device-error";
    case "CTAP2_ERR_OPERATION_DENIED": return "operation-not-supported";
    case "CTAP2_ERR_NOT_ALLOWED":  return "operation-not-supported";
    default:                        return "unknown";
  }
}
```

Raw CTAP2 error codes are never forwarded to the renderer or written to logs.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Derivation Determinism (Idempotence)

*For any* fixed 32-byte PRF_Output array, calling `DerivationService.derive(prf_output)` twice returns the same `Wallet_Address` on every invocation.

**Validates: Requirements 4.9, 18.1**

### Property 2: Derivation Injectivity (Distinctness)

*For any* two distinct 32-byte PRF_Output arrays `a` and `b` where `a ≠ b`, the derived `Wallet_Address` values must be different: `derive(a).walletAddress ≠ derive(b).walletAddress`.

**Validates: Requirements 4.8, 11.1, 18.2**

### Property 3: HKDF Output is a Valid Ed25519 Seed

*For any* 32-byte PRF_Output, the HKDF-SHA256 derivation chain (IKM = PRF_Output, salt = empty, info = `"key-wallet:solana:ed25519:v1"`) produces a 32-byte Wallet_Seed that `Keypair.fromSeed()` accepts without throwing.

**Validates: Requirements 4.3, 4.4, 18.3**

### Property 4: Transaction Serialization Round-Trip

*For any* valid combination of (destinationAddress, lamports, feePayer public key, blockhash), serializing a constructed unsigned transaction and then deserializing it produces a transaction with field-by-field equal program identifiers, account list (from and to public keys), and instruction data (transfer lamports value).

**Validates: Requirements 8.4, 18.4**

### Property 5: Transaction Amount Invariant

*For any* call to `buildTransactionPreview` where the lamports amount is in the valid range `[1, currentBalanceLamports - estimatedFee]`, the resulting transaction's transfer instruction encodes a positive lamports value that does not exceed the session balance passed to the service.

**Validates: Requirements 8.3, 18.5**

### Property 6: Address Validation Completeness

*For any* valid 32-byte public key encoded as Base58, `validateDestinationAddress()` accepts it. *For any* byte array of length ≠ 32 encoded as Base58 (or any string that is not valid Base58), `validateDestinationAddress()` rejects it.

**Validates: Requirements 8.2**

### Property 7: No Secret Material in Derivation Output Logs

*For any* 32-byte PRF_Output array, after a complete derivation call through the mock `HardwareIdentityProvider`, no intercepted logger call contains a byte-string representation of the PRF_Output value.

**Validates: Requirements 4.7, 14.2**

---

## Testing Strategy

### Overview

KeyWallet uses a dual testing approach: example-based unit tests for specific scenarios and edge cases, and property-based tests for universal correctness properties across the full input space. All tests run against the software mock `HardwareIdentityProvider` — no test ever connects to real hardware.

### Software Mock HardwareIdentityProvider

```typescript
// test/mocks/MockHardwareIdentityProvider.ts

export class MockHardwareIdentityProvider implements IHardwareIdentityProvider {
  private readonly deterministicMap = new Map<string, Uint8Array>();

  /**
   * Returns a deterministic 32-byte PRF_Output for the same credentialId
   * within a single test run.  Different credentialIds produce different outputs.
   */
  async getAssertion(
    _devicePath: string,
    options: AssertionOptions
  ): Promise<AssertionResult> {
    const key = Buffer.from(options.credentialId).toString("hex");
    if (!this.deterministicMap.has(key)) {
      // Derive deterministic output from credentialId via HMAC-SHA256
      const output = createHmac("sha256", Buffer.from("mock-secret"))
        .update(options.credentialId)
        .digest();
      this.deterministicMap.set(key, output);
    }
    return {
      hmacOutput: new Uint8Array(this.deterministicMap.get(key)!),
      credentialId: options.credentialId,
    };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return [{
      devicePath: "/mock/device/0",
      supportsHmacSecret: true,
      supportsResidentKey: true,
      extensions: ["hmac-secret"],
    }];
  }

  async discoverCredentials(
    _devicePath: string,
    _rpId: string
  ): Promise<DiscoveryResult> {
    return { credentials: [] };
  }

  async createCredential(
    _devicePath: string,
    options: EnrollmentOptions
  ): Promise<EnrollmentResult> {
    const credentialId = randomBytes(32);
    return {
      credentialId,
      authenticatorAttachment: "cross-platform",
      publicKeyBytes: randomBytes(32),
    };
  }
}
```

### Unit Tests

Location: `test/unit/`

| File | Tests |
|---|---|
| `DerivationService.test.ts` | Correct HKDF parameters, zero-overwrite called on error, user-cancel returns correct error kind, different credentials → different addresses |
| `TransactionService.test.ts` | Address validation edge cases (31/32/33 bytes), amount boundary conditions, blockhash timeout aborts correctly |
| `SessionService.test.ts` | createSession returns valid session, terminateSession calls secretKey.fill(0), reject transaction requests when session inactive |
| `EnrollmentService.test.ts` | Platform attachment rejection, enrollment abort on timeout, stale credential metadata detection |

### Property-Based Tests

Location: `test/property/`  
Library: `fast-check` (v3.x)  
Minimum iterations per property: **100** (default fast-check `numRuns`)

```typescript
// test/property/derivation.property.test.ts

import fc from "fast-check";
import { describe, it } from "vitest";

const prfOutputArb = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe("DerivationService properties", () => {
  // Feature: key-wallet, Property 1: Derivation Determinism
  it("Property 1: same PRF_Output always produces same Wallet_Address", async () => {
    await fc.assert(
      fc.asyncProperty(prfOutputArb, async (prfOutput) => {
        const result1 = await deriveFromPrfOutput(prfOutput);
        const result2 = await deriveFromPrfOutput(prfOutput);
        return result1.walletAddress === result2.walletAddress;
      }),
      { numRuns: 100 }
    );
  });

  // Feature: key-wallet, Property 2: Derivation Injectivity
  it("Property 2: distinct PRF_Outputs produce distinct Wallet_Addresses", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(prfOutputArb, prfOutputArb).filter(([a, b]) =>
          !Buffer.from(a).equals(Buffer.from(b))
        ),
        async ([prfA, prfB]) => {
          const resultA = await deriveFromPrfOutput(prfA);
          const resultB = await deriveFromPrfOutput(prfB);
          return resultA.walletAddress !== resultB.walletAddress;
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: key-wallet, Property 3: HKDF Output is valid Ed25519 seed
  it("Property 3: HKDF output is accepted as valid Ed25519 seed", async () => {
    await fc.assert(
      fc.asyncProperty(prfOutputArb, async (prfOutput) => {
        // Does not throw
        const keypair = await deriveKeypairFromPrfOutput(prfOutput);
        return keypair.publicKey.toBytes().length === 32;
      }),
      { numRuns: 100 }
    );
  });

  // Feature: key-wallet, Property 7: No secret material in logger output
  it("Property 7: derivation never logs PRF_Output bytes", async () => {
    await fc.assert(
      fc.asyncProperty(prfOutputArb, async (prfOutput) => {
        const logCapture: string[] = [];
        const mockLogger = { info: (m: string) => logCapture.push(m),
                             error: (m: string) => logCapture.push(m),
                             debug: (m: string) => logCapture.push(m) };
        await deriveFromPrfOutput(prfOutput, mockLogger);
        const prfHex = Buffer.from(prfOutput).toString("hex");
        return logCapture.every((entry) => !entry.includes(prfHex));
      }),
      { numRuns: 100 }
    );
  });
});

// test/property/transaction.property.test.ts

describe("TransactionService properties", () => {
  const validAddressArb = fc.uint8Array({ minLength: 32, maxLength: 32 })
    .map((bytes) => bs58.encode(Buffer.from(bytes)));

  const lamportsArb = fc.bigInt({ min: 1n, max: 1_000_000_000n });

  // Feature: key-wallet, Property 4: Transaction serialization round-trip
  it("Property 4: serialize/deserialize preserves transaction fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        validAddressArb,
        lamportsArb,
        validAddressArb,  // feePayer
        fc.string({ minLength: 43, maxLength: 44 }),  // blockhash (base58-like)
        async (destination, lamports, feePayer, blockhash) => {
          const tx = buildRawTransaction(destination, lamports, feePayer, blockhash);
          const serialized = tx.serialize({ requireAllSignatures: false });
          const deserialized = Transaction.from(serialized);
          return transactionFieldsEqual(tx, deserialized);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: key-wallet, Property 5: Amount invariant
  it("Property 5: constructed transaction amount is positive and within balance", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10_000_000_000n }),   // balance
        fc.bigInt({ min: 5000n, max: 5000n }),           // fixed fee estimate
        fc.nat({ max: 1000 }).map(BigInt),               // offset within valid range
        async (balance, fee, offset) => {
          const amount = balance - fee - offset;
          fc.pre(amount >= 1n);
          const tx = await service.buildTransaction({ amount, balance, fee });
          return tx.lamports > 0n && tx.lamports <= balance - fee;
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: key-wallet, Property 6: Address validation completeness
  it("Property 6: valid 32-byte keys pass address validation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        async (keyBytes) => {
          const address = bs58.encode(Buffer.from(keyBytes));
          return validateDestinationAddress(address) === true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

### Integration Tests

Location: `test/integration/`

| Scenario | Approach |
|---|---|
| Device connect/disconnect timing | Mock USB event emitter + timer assertions |
| Credential discovery (0/1/N results) | Mock HardwareIdentityProvider returning configured discovery results |
| Balance polling lifecycle | Mock SolanaService with fake RPC responses, verify interval start/stop |
| IPC message schema validation | Electron test harness (e.g., `spectron` or `@playwright/test` with Electron) |

### Test Runner

```json
// vitest.config.ts (property and unit tests)
{
  "test": {
    "environment": "node",
    "globals": true,
    "include": ["test/unit/**/*.test.ts", "test/property/**/*.test.ts"],
    "coverage": { "provider": "v8", "reporter": ["text", "lcov"] }
  }
}
```

CI command: `vitest run` (single pass, no watch mode)

---

## Kiro Feature Integration Plan

### Lesson 1: Spec-Driven Development (Requirement 15)

| Deliverable | Location | Requirement Reference |
|---|---|---|
| Requirements document | `.kiro/specs/key-wallet/requirements.md` | — |
| Design document (this file) | `.kiro/specs/key-wallet/design.md` | Req 15.3 |
| Task list | `.kiro/specs/key-wallet/tasks.md` | Req 15.1 |

Every task in `tasks.md` includes a `requirements:` field referencing the requirement identifier(s) it satisfies (e.g., `requirements: ["Req 4", "Req 18.1"]`). This provides a traceable chain from requirement → task → code.

The design document satisfies Req 15.3 by including:
- Technology decisions with justification (§Technology Decisions)
- End-to-end data flow diagrams (§Data Flows)
- Threat model section (§Threat Model)
- WebAuthn PRF feasibility findings (§WebAuthn PRF Feasibility, expanded from requirements.md)

### Lesson 2: Steering Documents (Requirement 16)

Three steering documents govern AI-assisted development throughout the project.

**`.kiro/steering/security.md`** — enforces:
1. No PRF_Output or private key bytes to disk (Req 14.1, 16.1)
2. No logging of secret material (Req 14.2, 16.1)
3. Zero-overwrite memory buffers immediately after use (Req 14.3, 16.1)
4. Use platform CSPRNG only (`crypto.getRandomValues()` or `node:crypto.randomBytes()`) (Req 14.4, 16.1)

**`.kiro/steering/architecture.md`** — enforces:
1. All CTAP2 operations execute in the Electron main process only (Req 16.2)
2. All hardware interactions go through `IHardwareIdentityProvider` interface (Req 16.2)
3. The Solana layer (`src/main/solana/`, `src/main/transaction/`) SHALL NOT import any CTAP2 or libfido2 modules (Req 16.2)

**`.kiro/steering/testing.md`** — enforces:
1. Property-based tests use 32-byte `Uint8Array` values as PRF_Output test data (Req 16.3)
2. No property-based test connects to real hardware; all use `MockHardwareIdentityProvider` (Req 16.3)
3. `MockHardwareIdentityProvider` returns deterministic output for the same credentialId input within a single test run (Req 16.3)

### Lesson 3: Hooks (Requirement 17)

Two Kiro hooks are defined as v2 hook files in `.kiro/hooks/`.

**`.kiro/hooks/security-lint-on-save.json`**
- Trigger: `PostFileSave`
- Matcher: `src/services/**` (also covers `src/main/derivation/**`, `src/main/hardware/**`, `src/main/session/**`)
- Action: `node scripts/security-lint.js {{filePath}}`
- The lint script checks for:
  - Use of `Math.random()` in security-sensitive paths
  - `console.log` or logger calls containing Buffer/Uint8Array variables named `prfOutput`, `walletSeed`, or `secretKey`
  - Missing `.fill(0)` calls after PRF_Output or Wallet_Seed usage
- Exit code 2 blocks further processing; output includes file path, line number, rule violated (Req 17.3)

**`.kiro/hooks/derivation-pbt-on-save.json`**
- Trigger: `PostFileSave`
- Matcher: `src/main/derivation/**`
- Action: `npx vitest run test/property/derivation.property.test.ts`
- Runs the DerivationService property-based test suite on every save to derivation or HKDF source files
- Exit code 2 on test failure; output includes test name and failing example (Req 17.2, 17.3)

### Lesson 4: Property-Based Testing (Requirement 18)

All six requirements in Req 18 are satisfied:

| Req | Property | Test Location | Implementation |
|---|---|---|---|
| 18.1 | Same PRF_Output → same Wallet_Address (idempotence) | `test/property/derivation.property.test.ts` | Property 1 |
| 18.2 | Distinct PRF_Outputs → distinct Wallet_Addresses | `test/property/derivation.property.test.ts` | Property 2 |
| 18.3 | HKDF output accepted as valid Ed25519 seed | `test/property/derivation.property.test.ts` | Property 3 |
| 18.4 | Transaction serialization round-trip | `test/property/transaction.property.test.ts` | Property 4 |
| 18.5 | Amount is positive, ≤ session balance | `test/property/transaction.property.test.ts` | Property 5 |
| 18.6 | All tests use MockHardwareIdentityProvider, no real hardware | All test files | Architecture rule |

PBT library: **fast-check** v3.x (the dominant TypeScript PBT framework; supports arbitrary generation, shrinking, and `numRuns` configuration). Each test runs with `numRuns: 100` minimum.

Tag comment format on each test: `// Feature: key-wallet, Property N: <property_text>`

### Lesson 5: MCP (Requirement 19)

MCP server at `src/mcp/server.ts` using `@modelcontextprotocol/sdk`.

**Tool: `inspect_transaction`**
- Input: `{ transaction_base64: string }` — base64-encoded unsigned Solana transaction
- Validation: must be valid base64; decoded bytes must be parseable as a `Transaction`; rejects if base64 decodes to >10KB (overflow guard)
- Output: `{ program: string; accounts: string[]; instruction_data: string; fee_payer: string }`
- Rejects: any input containing `private_key`, `wallet_seed`, `prf_output` field names (defense in depth)

**Tool: `query_devnet`**
- Input: `{ address: string }` — Solana public key (Base58)
- Validation: address must decode to exactly 32 bytes
- Output: `{ balance_sol: string; balance_lamports: string; recent_signatures: string[] }` (10 most recent)
- Network: connects only to `https://api.devnet.solana.com`

Both tools never accept or return private keys, Wallet_Seeds, or PRF_Outputs (Req 19.3, 19.4).

```typescript
// src/mcp/server.ts (structure)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "keywallet-mcp", version: "1.0.0" });

server.tool(
  "inspect_transaction",
  "Decode a base64 unsigned Solana transaction and return human-readable fields",
  {
    transaction_base64: z.string()
      .describe("Base64-encoded unsigned Solana transaction bytes")
  },
  async ({ transaction_base64 }) => {
    // validate base64, parse transaction, return fields
    // never return private keys
  }
);

server.tool(
  "query_devnet",
  "Get balance and recent transaction signatures for a devnet address",
  {
    address: z.string()
      .describe("Solana public key in Base58 format")
  },
  async ({ address }) => {
    // validate address, query devnet, return balance + signatures
    // never return private keys
  }
);
```

### Lesson 6: Custom Agent (Requirement 20)

Agent configuration at `agents/crypto-security-reviewer.json`:

```json
{
  "name": "Crypto Security Reviewer",
  "description": "Reviews cryptographic and signing code for security vulnerabilities in KeyWallet's sensitive modules",
  "scope": {
    "include": [
      "src/main/hardware/**",
      "src/main/derivation/**",
      "src/main/transaction/**"
    ],
    "exclude": ["**/*.test.ts", "**/*.spec.ts"]
  },
  "rules": [
    "CSPRNG_ONLY: Flag any use of Math.random() for security-sensitive values",
    "NO_SECRET_LOG: Flag any logger call that passes a variable known to hold PRF_Output, Wallet_Seed, or private key bytes",
    "ZERO_AFTER_USE: Flag any code path where a buffer named prfOutput, walletSeed, or secretKey is not followed by .fill(0) before function return or exception exit",
    "AUDITED_CRYPTO: Flag use of cryptographic libraries not in the approved list: [node:crypto, @solana/web3.js, panva/hkdf, @noble/ed25519]",
    "DOMAIN_SEPARATED_SALT: Flag any HKDF or HMAC call that uses an empty or non-domain-separated info string where key derivation is intended"
  ],
  "outputFormat": {
    "fields": ["filePath", "lineNumber", "ruleViolated", "remediationSuggestion"],
    "requireAllFields": true
  }
}
```

Each finding must include all four fields: `filePath`, `lineNumber`, `ruleViolated`, `remediationSuggestion` (Req 20.4). Findings missing any field are suppressed.

### Lesson 7: Powers (Requirement 21)

Power definition at `powers/hardware-wallet-security/power.json`:

```json
{
  "name": "hardware-wallet-security",
  "version": "1.0.0",
  "description": "Reusable hardware wallet security development power for Kiro. Bundles security steering, MCP transaction inspection tools, and the Crypto Security Reviewer agent.",
  "components": {
    "steering": [
      { "ref": ".kiro/steering/security.md", "loadOnSessionStart": true }
    ],
    "mcpServer": {
      "ref": "src/mcp/server.ts",
      "tools": ["inspect_transaction", "query_devnet"]
    },
    "agent": {
      "ref": "agents/crypto-security-reviewer.json"
    }
  }
}
```

**`powers/hardware-wallet-security/README.md`** contains:
- **Capabilities**: What the power does (loads security rules, exposes MCP tools, activates security review agent)
- **Exposed Tools**: `inspect_transaction` and `query_devnet` — description, parameters, return values
- **Enforced Security Rules**: The five rules from the Crypto Security Reviewer agent, plus the four rules from the security steering document

When an AI assistant session begins with this power active, the security steering document is loaded into context (`loadOnSessionStart: true`), enforcing the no-secret-storage and CSPRNG rules from the first interaction (Req 21.3).

---

## Technology Decisions

| Decision | Choice | Justification |
|---|---|---|
| Desktop framework | Electron (v29+) | Cross-platform (Windows, macOS, Linux) with Node.js runtime for libfido2 native addon. Established ecosystem for hardware-key desktop apps. |
| CTAP2 library | libfido2 (Yubico) via Node.js native addon | Only cross-platform C library with `hmac-secret` extension support. Chosen over browser WebAuthn (not available in Electron renderer for hardware keys on all platforms). |
| Node.js native addon wrapper | `@vaultys/webauthn-node` or equivalent | Wraps libfido2 in a Node.js-compatible `N-API` binding; avoids rewriting C bindings. Pinned to exact version. |
| Solana SDK | `@solana/web3.js` v1.x | Official Solana JavaScript SDK. `Keypair.fromSeed()` accepts 32-byte seeds directly, compatible with HKDF output. Well-audited for the prototype use case. |
| HKDF implementation | Node.js built-in `crypto.hkdfSync` | Available since Node 15; no external dependency; uses platform OpenSSL. Falls back to `panva/hkdf` (no external dependencies, uses `SubtleCrypto`) if sync form unavailable. |
| PBT framework | fast-check v3.x | Dominant TypeScript PBT library; strong arbitrary generators for `Uint8Array`; built-in shrinking; `numRuns` configuration; active maintenance. |
| Test runner | Vitest | Native TypeScript/ESM support; fast; compatible with `vitest run` for CI single-pass execution. |
| UI framework | React (with Electron's renderer) | Component-based UI maps cleanly to wallet states (idle, enroll, wallet, send). Renderer runs with `contextIsolation: true`. |
| MCP SDK | `@modelcontextprotocol/sdk` v1.x | Official TypeScript MCP SDK; `McpServer` class with typed tool definitions; Zod schema validation. |
| State management | React Context + `useReducer` | Sufficient for the wallet's linear state machine (idle → enroll/discover → wallet → send); no Redux-scale complexity required. |
| Local storage | Electron `app.getPath("userData")` + JSON file | Simple, non-secret metadata store. No SQLite dependency needed for prototype scale. |

---

## Appendix: WebAuthn PRF Feasibility Findings (Design Expansion)

The requirements document contains seven validated feasibility findings (Findings 1–7). This section expands on their design implications:

**Finding 1 (PRF is authenticator-bound)** drives the core identity model: the `HardwareIdentityProvider.getAssertion()` call is the single trust anchor. All downstream derivation is deterministic given a stable PRF_Output — there is no server, no cloud component, and no other source of entropy.

**Finding 2 (Discoverable credentials required)** mandates `requireResidentKey: true` in all credential creation calls. This has a storage implication (device slot capacity) that is surfaced in the UI and documented as a prototype limitation.

**Finding 4 (node-hid + TypeScript CTAP2 integration path)** drives the entire main-process isolation architecture. The replacement of `@vaultys/webauthn-node` (libfido2 native addon) with `node-hid` + pure TypeScript CTAP2 removes the dependency on system-installed `fido2.dll`, resolves the Node ABI mismatch with Electron 44, and enables distribution via electron-builder `asarUnpack` without requiring developer tooling on the user's machine. The IPC-based design where CTAP2 operations are encapsulated in the main process behind `IHardwareIdentityProvider` is preserved.

**Finding 5 (PRF output → HKDF → Ed25519)** is implemented exactly as specified: two HKDF-SHA256 steps, the first producing a fixed PRF_Salt constant and the second producing Wallet_Seed from PRF_Output. `Keypair.fromSeed(walletSeed)` creates the final Ed25519 keypair.

**Finding 6 (Security considerations)** maps directly to the threat model (§Threat Model) and is surfaced in the application UI via the error handling system (§Error Handling).

**Finding 7 (Architecture decision)** is the direct source for the `HardwareIdentityProvider` abstraction, the main-process-only CTAP2 rule in the architecture steering document, and the `MockHardwareIdentityProvider` test fixture.
