# KeyWallet

A cross-platform Electron desktop app that derives a deterministic Solana Ed25519 wallet from a FIDO2/WebAuthn hardware security key (YubiKey, etc.) via the CTAP2 `hmac-secret` extension. The private key never touches disk — it is derived on demand from a hardware secret and zeroed from memory when the session ends.

> **Status**: Devnet only. Real hardware integration requires a FIDO2 key with `hmac-secret` support (YubiKey 5 series, SoloKey v2, or equivalent).

---

## How it works

```
Hardware key (hmac-secret)
        │
        │  PRF_Output (32 bytes, never stored)
        ▼
  HKDF-SHA256  ──► Wallet_Seed (32 bytes, never stored)
        │
        ▼
  Ed25519 Keypair  ──►  Solana wallet address (public, stored in session only)
```

1. A **credential** is created on the hardware key once (enrollment).  
2. On each login, the app sends a fixed salt (`PRF_SALT_CONSTANT`) to the key via `hmac-secret`; the key returns a deterministic 32-byte output.  
3. That output is fed through two rounds of HKDF-SHA256 to produce a 32-byte Ed25519 seed.  
4. `Keypair.fromSeed()` constructs the wallet. The seed and PRF output are zeroed immediately after.  
5. When the hardware key is removed (or the session is explicitly ended), `keypair.secretKey` is zeroed with `.fill(0)`.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 20+ |
| npm | 10+ |
| Electron | 44 (bundled as dev dep) |
| OS | Windows 10 1903+, macOS 12+, Ubuntu 22.04+ |

For real hardware: a FIDO2 key with the `hmac-secret` extension (YubiKey 5, SoloKey v2). Development and all tests run with a software mock — no hardware required.

---

## Quick start

```bash
# Install dependencies
npm install

# Run all tests (no hardware needed)
npm test

# Build TypeScript
npm run build

# Launch the Electron app (build first)
npm start
```

---

## All commands

| Command | What it does |
|---|---|
| `npm install` | Install all dependencies |
| `npm run build` | Compile TypeScript (main + renderer targets) |
| `npm run build:main` | Compile main process only (`tsconfig.main.json`) |
| `npm run build:renderer` | Compile renderer only (`tsconfig.renderer.json`) |
| `npm test` | Run full test suite (unit + property + integration) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | ESLint across `src/` |
| `npm start` | Build then launch Electron |
| `npm run dev` | Launch Electron without rebuilding (fast iteration) |
| `npm run dist` | Package distributable (NSIS on Windows, DMG on macOS, AppImage on Linux) |

---

## Running the MCP server

The MCP server exposes two tools (`inspect_transaction`, `query_devnet`) for AI agent use.

```bash
# Run directly with ts-node
npx ts-node src/mcp/server.ts

# Or after building
node dist/mcp/server.js
```

Add it to your MCP client config:

```json
{
  "mcpServers": {
    "key-wallet": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "/path/to/inflict"
    }
  }
}
```

---

## Project structure

```
inflict/
├── src/
│   ├── main/                     # Electron main process (Node.js, CJS)
│   │   ├── index.ts              # App entry point, IPC handlers, service wiring
│   │   ├── hardware/             # FIDO2/CTAP2 abstraction
│   │   │   ├── IHardwareIdentityProvider.ts
│   │   │   ├── Libfido2HardwareIdentityProvider.ts   # Real hardware (libfido2)
│   │   │   ├── MockHardwareIdentityProvider.ts       # Development/test stub
│   │   │   └── types.ts
│   │   ├── derivation/           # HKDF key derivation pipeline
│   │   │   ├── DerivationService.ts
│   │   │   └── hkdf.ts
│   │   ├── device/               # USB device polling (500ms interval)
│   │   │   └── DeviceMonitor.ts
│   │   ├── enrollment/           # Credential creation + storage
│   │   │   └── EnrollmentService.ts
│   │   ├── session/              # In-memory keypair session
│   │   │   └── SessionService.ts
│   │   ├── solana/               # Balance queries, devnet RPC
│   │   │   └── SolanaService.ts
│   │   ├── storage/              # JSON credential metadata persistence
│   │   │   └── CredentialStore.ts
│   │   └── transaction/          # Transaction construction + signing
│   │       └── TransactionService.ts
│   ├── preload/
│   │   └── index.ts              # contextBridge — exposes typed wallet API to renderer
│   ├── renderer/                 # React UI (browser ESM)
│   │   ├── App.tsx               # State machine: Idle → Enroll → Wallet → Send
│   │   ├── hooks/
│   │   │   └── useWalletState.ts # Subscribes to all IpcEvent channels
│   │   └── views/
│   │       ├── IdleView.tsx
│   │       ├── EnrollView.tsx
│   │       ├── WalletView.tsx
│   │       └── SendView.tsx
│   ├── mcp/
│   │   └── server.ts             # MCP server (inspect_transaction, query_devnet)
│   └── shared/
│       └── ipc-types.ts          # IpcRequest / IpcEvent type unions (no secrets)
│
├── test/
│   ├── unit/                     # Per-service unit tests (8 files, ~83 tests)
│   ├── property/                 # fast-check property-based tests (2 files, 9 props)
│   ├── integration/              # Wired service integration tests (3 files, ~39 tests)
│   └── mocks/
│       └── MockHardwareIdentityProvider.ts
│
├── scripts/
│   └── security-lint.js          # Scans files for secret-logging violations
│
├── agents/
│   └── crypto-security-reviewer.json
│
├── powers/
│   └── hardware-wallet-security/
│       ├── plugin.json           # Kiro Power manifest (Agent Plugins v1)
│       ├── mcp.json              # MCP server config for the power
│       └── README.md
│
└── .kiro/
    ├── steering/
    │   ├── security.md           # 4 non-negotiable security rules
    │   ├── architecture.md       # 3 architecture constraints
    │   └── testing.md            # 3 testing rules
    └── hooks/
        ├── security-lint-on-save.json
        └── derivation-pbt-on-save.json
```

---

## Security rules (enforced by `.kiro/steering/security.md`)

1. **No secrets to disk** — `PRF_Output`, `Wallet_Seed`, and `keypair.secretKey` are never written to any file or store. Only credential metadata (credential ID hex, display name, RP ID) is persisted.

2. **No logging of secrets** — those three values must never appear in any `console.*` or logger call at any log level.

3. **Zero-overwrite after use** — any buffer holding secret material is zeroed with `.fill(0)` inside a `finally` block.

4. **Platform CSPRNG only** — `node:crypto.randomBytes()` in the main process; `crypto.getRandomValues()` in the renderer. `Math.random()` is forbidden for any security-relevant value.

---

## Running with real hardware

The app ships with `MockHardwareIdentityProvider` as the active provider. To switch to real hardware:

1. Install the native addon:
   ```bash
   npm install @vaultys/webauthn-node
   ```

2. In `src/main/index.ts`, swap the import:
   ```ts
   // Replace this:
   import { MockHardwareIdentityProvider } from "./hardware/MockHardwareIdentityProvider";
   // With this:
   import { Libfido2HardwareIdentityProvider } from "./hardware/Libfido2HardwareIdentityProvider";

   // And change the instantiation:
   const hardwareProvider = new Libfido2HardwareIdentityProvider();
   ```

3. Rebuild and run:
   ```bash
   npm run build && npm start
   ```

**Windows note**: libfido2 on Windows requires Administrator privileges or Windows 10 1903+ with WebAuthn.dll routing. Run Electron as Administrator if you get permission errors.

---

## Test suite

```
test/unit/
  CredentialStore.test.ts       — JSON persistence, metadata isolation
  DerivationService.test.ts     — HKDF pipeline, error mapping, zero-overwrite
  DeviceMonitor.test.ts         — 500ms polling, connect/remove events
  EnrollmentService.test.ts     — createCredential → store flow
  McpServer.test.ts             — inspect_transaction, query_devnet tools
  SessionService.test.ts        — createSession, terminateSession, key zeroing
  SolanaService.test.ts         — balance queries, periodic refresh
  TransactionService.test.ts    — validateTransferParams, buildTransactionPreview, signAndSubmit

test/property/
  derivation.property.test.ts   — Properties 1–3, 7 (determinism, injectivity, seed validity, no-logging)
  transaction.property.test.ts  — Properties 4–6 (serialisation roundtrip, amount bounds, address validation)

test/integration/
  DeviceMonitor.integration.test.ts      — Full poll lifecycle with mock USB events
  session-lifecycle.integration.test.ts  — Enroll → derive → session → terminate → zero-check
  e2e-smoke.test.ts                      — All 7 services wired together end-to-end
```

Run a specific file:
```bash
npx vitest run test/integration/e2e-smoke.test.ts
```

Run in watch mode during development:
```bash
npm run test:watch
```

---

## Installing the Kiro Power

In Kiro, open the Powers panel and install from local folder — select `powers/hardware-wallet-security/`. The power bundles:
- Security steering rules (auto-loaded into context)
- The MCP server (`inspect_transaction`, `query_devnet` tools)
- The Crypto Security Reviewer agent

---

## License

Private — not for distribution.
