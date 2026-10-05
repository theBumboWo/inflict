# KeyWallet

A vendor-neutral Electron desktop app that derives a deterministic Solana Ed25519 wallet from a FIDO2 hardware security key via the CTAP2 `hmac-secret` extension. The private key never touches disk — it is derived on demand from a hardware secret and zeroed from memory when the session ends.

> **⚠️ Devnet only.** This is a prototype. No mainnet support. No backup or recovery mechanism. No code signing.

---

## For Users

### What you need

- A FIDO2 hardware security key with `hmac-secret` support (see [Hardware compatibility](#hardware-compatibility))
- Windows 10 version 1903 or later (Tier 1 — tested and supported)
- A USB or NFC port for your key

### Getting started

1. **Download** the installer from the `release/` folder: `KeyWallet Setup 0.1.0.exe`
2. **Install** — double-click the installer and follow the prompts
3. **SmartScreen warning** — Windows will show a blue warning because the installer is unsigned. Click **"More info"** → **"Run anyway"** to proceed (see [Known limitations](#known-limitations))
4. **Launch** KeyWallet from the Start menu or desktop shortcut
5. **Insert your security key** — the app detects it automatically (500ms polling)
6. **Enroll** — on first use, click "Enroll" and touch your key when prompted. This creates a FIDO2 credential on the key
7. **Use your wallet** — your Solana wallet address is derived from the key. View balance, copy address, and send SOL on devnet

### What happens when you remove the key

The wallet session terminates immediately (within 200ms). Your private key is zeroed from memory. Reinserting the key and touching it again restores access.

---

## Hardware Compatibility

### Tested hardware

| Device | Firmware | Connection | Status |
|---|---|---|---|
| YubiKey 5C NFC | 5.7.4 | USB-C / NFC | ✅ Fully tested on Windows 11 |

### Compatible (not tested by this project)

Any FIDO2 key that supports the `hmac-secret` extension should work. This includes:

- YubiKey 5 series (5Ci, 5 NFC, 5C, 5C NFC)
- SoloKey v2
- Other keys advertising FIDO2 + hmac-secret support

Keys that support FIDO2 **without** `hmac-secret` (e.g., some FIDO2-only keys) are not compatible.

### Platform support

| Platform | Tier | Status |
|---|---|---|
| Windows 10 1903+ / Windows 11 | **Tier 1** | Tested — YubiKey 5C NFC on Windows 11 |
| macOS 12+ | **Tier 2** | Build target configured, not tested with hardware |
| Linux (Ubuntu 22.04+) | **Tier 3** | AppImage build configured, hardware untested |

---

## Known Limitations

- **Devnet only** — Solana mainnet is not supported and not planned for this prototype
- **No backup or recovery** — if you lose your hardware key, you lose access to your devnet wallet. There is no seed phrase, no export, no recovery path
- **No code signing** — the Windows installer is unsigned. SmartScreen will warn on every install. To suppress this, configure an EV certificate in `scripts/notarize.js`
- **Single key, single credential** — the app uses the first detected device and the first matching credential
- **Transaction mocking** — `buildTransactionPreview` builds a real unsigned transaction but the submit path talks to devnet only

---

## For Developers

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 20+ |
| npm | 10+ |
| OS | Windows 10 1903+, macOS 12+, Ubuntu 22.04+ |
| Hardware (optional) | FIDO2 key with `hmac-secret` — not needed for tests |

### Architecture

KeyWallet is an Electron app with strict process isolation:

```
┌──────────────────────────────────────────┐
│  Renderer (untrusted UI — React)         │
│  contextIsolation: true                  │
│  nodeIntegration: false, sandbox: true   │
│                                          │
│  App.tsx → views → hooks                 │
│                │                         │
│                │  window.wallet.*        │
└────────────────┼─────────────────────────┘
                 │  contextBridge (preload/index.ts)
┌────────────────┼─────────────────────────┐
│  Main Process (trusted Node.js)          │
│                │                         │
│  ipcMain.handle() ──────────────────┐    │
│                                     │    │
│  DerivationService                  │    │
│  EnrollmentService   ───►  IHardwareIdentityProvider
│  SessionService                     │    │
│  SolanaService (devnet RPC)         │    │
│  TransactionService                 │    │
│  CredentialStore (metadata only)    │    │
│                                     │    │
│  NodeHidHardwareIdentityProvider ───┘    │
│  (node-hid + TypeScript CTAP2)           │
└──────────────────────────────────────────┘
```

The hardware integration layer uses `node-hid` and a TypeScript CTAP2 implementation (not libfido2). All hardware operations go through the `IHardwareIdentityProvider` interface, which is swapped for `MockHardwareIdentityProvider` during tests.

### Key derivation flow

```
Hardware key (hmac-secret)
        │
        │  PRF_Output (32 bytes — never stored, never logged)
        ▼
  HKDF-SHA256  ──► Wallet_Seed (32 bytes — never stored, never logged)
        │
        ▼
  Ed25519 Keypair  ──►  Solana wallet address (public key only stored in session)
```

1. A credential is created on the hardware key once (enrollment).
2. On each login the app sends a fixed salt to the key via `hmac-secret`; the key returns a deterministic 32-byte output.
3. That output is fed through HKDF-SHA256 to produce a 32-byte Ed25519 seed.
4. `Keypair.fromSeed()` constructs the wallet. The seed and PRF output are zeroed immediately after.
5. When the hardware key is removed, `keypair.secretKey` is zeroed with `.fill(0)`.

### Build

```bash
# Install dependencies (also rebuilds native modules for the current Electron version)
npm install

# Compile TypeScript (main + renderer)
npm run build

# Compile main process only
npm run build:main

# Compile renderer only
npm run build:renderer

# Launch (build first, then start Electron)
npm start

# Fast iteration — launch without rebuilding
npm run dev

# Produce distributable
# Windows: NSIS installer  → release/KeyWallet Setup 0.1.0.exe
# macOS:   DMG             → release/
# Linux:   AppImage        → release/
npm run dist
```

### Running tests

All tests use `MockHardwareIdentityProvider` — no hardware required.

```bash
# Full test suite (unit + property + integration)
npm test

# Watch mode during development
npm run test:watch

# Single file
npx vitest run test/integration/e2e-smoke.test.ts
```

**Test layout:**

```
test/
├── unit/              # Per-service unit tests (~83 tests across 8 files)
├── property/          # fast-check property-based tests (9 properties across 2 files)
├── integration/       # Full service wiring tests (~39 tests across 3 files)
└── mocks/
    └── MockHardwareIdentityProvider.ts
```

Property tests validate:
- Derivation determinism — same key + credential → same wallet address
- Derivation injectivity — different credentials → different addresses
- Seed validity — derived seed always produces a valid Ed25519 keypair
- No secret logging — derivation code satisfies security Rule 2
- Transaction serialisation roundtrip
- Amount bounds
- Address validation

### Hardware diagnostics

To inspect the state of a connected device without performing any cryptographic operation:

```bash
# From the running app (DevTools console or IPC test harness):
await window.wallet.invoke('hardware:diagnose')
```

The `hardware:diagnose` IPC handler returns:

```json
{
  "deviceDetected": true,
  "fido2Supported": true,
  "hmacSecretSupported": true,
  "credentialFound": true,
  "prfOperationResult": "not tested",
  "devicePath": "/dev/hidraw0",
  "extensions": [],
  "versions": [],
  "error": null
}
```

No secret material is ever included in the diagnostic response.

### Linting

```bash
npm run lint
```

The `scripts/security-lint.js` script checks for violations of the four security rules (no secret bytes to disk, no logging of secrets, zero-overwrite after use, CSPRNG only). It runs automatically via the Kiro hook on every save to `src/main/derivation/`, `src/main/hardware/`, and `src/main/session/`.

### Windows installer output

```
release/
├── KeyWallet Setup 0.1.0.exe          # NSIS one-click installer (~114 MB)
├── KeyWallet Setup 0.1.0.exe.blockmap # Delta update block map
├── latest.yml                          # Auto-update manifest
└── win-unpacked/                       # Unpacked app (runs without installing)
```

The `node-hid` native addon is placed in `resources/app.asar.unpacked/` by `electron-builder` so it loads correctly outside the ASAR archive at runtime.

### Project structure

```
inflict/
├── src/
│   ├── main/                     # Electron main process
│   │   ├── index.ts              # Entry point, IPC handlers, service wiring
│   │   ├── hardware/             # FIDO2/CTAP2 abstraction
│   │   │   ├── IHardwareIdentityProvider.ts
│   │   │   ├── NodeHidHardwareIdentityProvider.ts  # Real hardware (node-hid)
│   │   │   ├── Libfido2HardwareIdentityProvider.ts # Alternative (unused)
│   │   │   ├── MockHardwareIdentityProvider.ts     # Tests only
│   │   │   └── ctap2/            # TypeScript CTAP2 implementation
│   │   ├── derivation/           # HKDF key derivation
│   │   ├── device/               # USB device polling (500ms)
│   │   ├── enrollment/           # Credential creation + storage
│   │   ├── session/              # In-memory keypair session
│   │   ├── solana/               # Balance queries, devnet RPC
│   │   ├── storage/              # JSON credential metadata (no secrets)
│   │   └── transaction/          # Transaction construction + signing
│   ├── preload/
│   │   └── index.ts              # contextBridge — the only renderer↔main bridge
│   ├── renderer/                 # React UI
│   │   ├── App.tsx               # State machine: Idle → Enroll → Wallet → Send
│   │   └── views/
│   │       ├── IdleView.tsx
│   │       ├── EnrollView.tsx
│   │       ├── WalletView.tsx
│   │       └── SendView.tsx
│   ├── mcp/
│   │   └── server.ts             # MCP server (inspect_transaction, query_devnet)
│   └── shared/
│       └── ipc-types.ts          # IPC type unions — no secret types
├── test/
├── scripts/
│   └── security-lint.js          # Checks source for security rule violations
├── agents/
│   └── crypto-security-reviewer.json
└── powers/
    └── hardware-wallet-security/
```

---

## What is tested, what is mocked, what requires hardware

| Area | Status |
|---|---|
| Key derivation (HKDF pipeline) | ✅ Fully tested — unit + 4 property tests |
| Derivation determinism | ✅ Property-tested across 100+ random inputs |
| Session lifecycle (create, terminate, zero) | ✅ Fully tested |
| Credential enrollment | ✅ Tested with mock provider |
| Solana balance queries | ✅ Unit tested (mock RPC) |
| Transaction construction + signing | ✅ Unit + property tested |
| MCP tools (inspect_transaction, query_devnet) | ✅ Unit tested |
| End-to-end service wiring | ✅ Integration tested with mock hardware |
| Real FIDO2 hardware touch | 🔧 Hardware required — not automatable |
| `hmac-secret` extension on real key | 🔧 Hardware required — tested manually with YubiKey 5C NFC |
| Windows HID device enumeration | 🔧 Hardware required |
| Mainnet transactions | ❌ Not implemented |

---

## Kiro Features

This project uses several Kiro features to enforce quality and security during development.

### Steering documents (`.kiro/steering/`)

Three auto-loaded steering documents apply to every code change:

- **`security.md`** — four non-negotiable security rules (no secrets to disk, no secret logging, zero-overwrite buffers, CSPRNG only)
- **`architecture.md`** — three architecture constraints (hardware in main process only, all CTAP2 through `IHardwareIdentityProvider`, Solana layer must not import CTAP2 modules)
- **`testing.md`** — three testing rules (PRF arbitraries must be 32-byte `Uint8Array`, no tests connect to real hardware, mock must be deterministic)

### Hooks (`.kiro/hooks/`)

Two hooks run automatically on file save:

- **`security-lint-on-save`** — runs `scripts/security-lint.js` on any save to `src/main/derivation/**`, `src/main/hardware/**`, or `src/main/session/**`
- **`derivation-pbt-on-save`** — runs the derivation property-based test suite (`npx vitest run test/property/derivation.property.test.ts`) on any save to `src/main/derivation/**`

### MCP server (`src/mcp/server.ts`)

The `key-wallet-mcp` MCP server exposes two tools for use in AI agent workflows:

- **`inspect_transaction`** — decodes a base64-encoded unsigned Solana transaction into human-readable fields (program, accounts, instruction data, fee payer). Refuses inputs containing `private_key`, `wallet_seed`, or `prf_output` fields. Rejects payloads over 10 KB.
- **`query_devnet`** — fetches SOL balance and 10 most recent transaction signatures for a devnet address. Accepts only valid 32-byte Base58 public keys. Devnet only.

To add to your Kiro MCP configuration:

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

### Power (`powers/hardware-wallet-security/`)

The **Hardware Wallet Security** power bundles the security steering document, MCP server, and Crypto Security Reviewer agent into a single installable unit. To install in Kiro: open the Powers panel → install from local folder → select `powers/hardware-wallet-security/`.

### Custom agent (`agents/crypto-security-reviewer.json`)

The **Crypto Security Reviewer** agent reviews cryptographic code in `src/main/derivation/`, `src/main/hardware/`, and `src/main/session/` for violations of the four security rules. For each violation it reports the file path, line number, violated rule, exact offending code, and the correct replacement.

---

## Security rules

These four rules are non-negotiable for every file in `src/`. Kiro enforces them via steering documents and the security-lint hook.

1. **No secrets to disk** — `PRF_Output`, `Wallet_Seed`, and private key bytes must never be written to any file, database, or store. Only non-secret credential metadata (credential ID hex, display name, RP ID) is persisted.

2. **No logging of secret material** — those three values must never appear in any `console.*` or logger call at any log level.

3. **Zero-overwrite after use** — any buffer holding secret material is zeroed with `.fill(0)` inside a `finally` block.

4. **Platform CSPRNG only** — `node:crypto.randomBytes()` in the main process; `crypto.getRandomValues()` in the renderer. `Math.random()` is forbidden for all security-relevant values.

---

## License

Private — not for distribution.
