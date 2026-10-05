---
inclusion: auto
---

# KeyWallet Architecture Boundaries

This document enforces three hard architecture rules for the KeyWallet project. These rules exist to preserve security isolation, testability, and clean layer separation across the Electron main/renderer split.

---

## Main-Process Isolation Rationale

KeyWallet runs the Electron renderer with strict security settings:

```
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Under this configuration the renderer process is treated as an **untrusted UI surface** — equivalent to a web page. Native Node.js addons (including `libfido2` and any `@vaultys/webauthn-node`-based module) cannot be loaded inside a sandboxed renderer. Attempting to do so will throw at runtime.

All hardware state (connected devices, active credentials, assertion results) must live in the **main process**, which is the trusted platform side of the Electron boundary. Scattering hardware state across processes would introduce race conditions between device-connect events and derivation calls, and would require duplicating error-recovery logic.

The preload script (`src/preload/index.ts`) is the only sanctioned bridge. It exposes a narrow, typed IPC surface to the renderer via `contextBridge`. No other file may cross this boundary.

```
┌─────────────────────────────────────────────────────────┐
│  Renderer Process  (untrusted UI)                       │
│  contextIsolation: true  nodeIntegration: false         │
│                                                         │
│  App.tsx → views → hooks                                │
│                     │                                   │
│                     │  window.wallet.*  (contextBridge) │
└─────────────────────┼───────────────────────────────────┘
                      │
          src/preload/index.ts  ◄── ONLY bridge
                      │
                      │  ipcRenderer.invoke / ipcRenderer.on
┌─────────────────────┼───────────────────────────────────┐
│  Main Process  (trusted platform code)                  │
│                     │                                   │
│  ipcMain.handle ────┘                                   │
│      │                                                  │
│  DerivationService, EnrollmentService, SessionService   │
│      │                                                  │
│  IHardwareIdentityProvider                              │
│      │                                                  │
│  Libfido2HardwareIdentityProvider (production)          │
│  MockHardwareIdentityProvider     (tests)               │
└─────────────────────────────────────────────────────────┘
```

---

## Rule 1: All CTAP2 Operations Execute in the Main Process Only

All calls to `libfido2`, `@vaultys/webauthn-node`, or any FIDO2/CTAP2 library **must** originate in the Electron main process.

**Correct:**
```ts
// src/main/index.ts
ipcMain.handle('wallet:derive', async (_event, req) => {
  return derivationService.derive(req.credentialId);
});
```

**Incorrect:**
```ts
// src/renderer/App.tsx  ← FORBIDDEN
import { Fido2Lib } from 'fido2-lib';
import WebAuthnNode from '@vaultys/webauthn-node';
```

### Files that must never import CTAP2/libfido2 modules

- Anything under `src/renderer/`
- `src/preload/index.ts`
- `src/shared/`

---

## Rule 2: All Hardware Interactions Go Through `IHardwareIdentityProvider`

No service class may call `libfido2` directly. Every hardware operation must be routed through the `IHardwareIdentityProvider` interface defined in `src/main/hardware/IHardwareIdentityProvider.ts`.

**Correct:**
```ts
// src/main/derivation/DerivationService.ts
constructor(private readonly provider: IHardwareIdentityProvider) {}

async derive(credentialId: Buffer): Promise<string> {
  const result = await this.provider.getAssertion({ credentialId, ... });
  // ...
}
```

**Incorrect:**
```ts
// src/main/derivation/DerivationService.ts  ← FORBIDDEN
import { fido2 } from '@vaultys/webauthn-node';

async derive(credentialId: Buffer): Promise<string> {
  const assertion = await fido2.getAssertion(...);  // direct libfido2 call
}
```

### Known implementations

| Class | Location | Purpose |
|---|---|---|
| `Libfido2HardwareIdentityProvider` | `src/main/hardware/` | Production — talks to real hardware via libfido2 |
| `MockHardwareIdentityProvider` | `test/mocks/MockHardwareIdentityProvider.ts` | Tests — deterministic software mock, no real hardware |

This abstraction makes it possible to run the full service-layer and all property-based tests without a physical security key.

---

## Rule 3: The Solana Layer Must Not Import CTAP2 or libfido2 Modules

Files in `src/main/solana/` and `src/main/transaction/` are the Solana domain layer. Their only permitted external dependency is `@solana/web3.js` and project-internal types from `src/shared/`.

**Correct dependency flow:**
```
SolanaService     → @solana/web3.js
TransactionService → @solana/web3.js, SolanaService
```

**Forbidden imports in `src/main/solana/` and `src/main/transaction/`:**
- `@vaultys/webauthn-node`
- `fido2-lib`
- `libfido2`
- Any module with `ctap`, `fido`, or `webauthn` in its package name

**Correct:**
```ts
// src/main/solana/SolanaService.ts
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
```

**Incorrect:**
```ts
// src/main/solana/SolanaService.ts  ← FORBIDDEN
import WebAuthnNode from '@vaultys/webauthn-node';
```

---

## Module Dependency Diagram

Allowed (→) and forbidden (✗→) import directions:

```
src/renderer/          ✗→  src/main/hardware/
src/renderer/          ✗→  @vaultys/webauthn-node
src/preload/           ✗→  @vaultys/webauthn-node

src/main/derivation/    →  IHardwareIdentityProvider  ✓
src/main/enrollment/    →  IHardwareIdentityProvider  ✓
src/main/derivation/   ✗→  @vaultys/webauthn-node (direct)

src/main/solana/        →  @solana/web3.js            ✓
src/main/transaction/   →  @solana/web3.js            ✓
src/main/solana/       ✗→  @vaultys/webauthn-node
src/main/transaction/  ✗→  @vaultys/webauthn-node
src/main/solana/       ✗→  fido2-lib
src/main/transaction/  ✗→  fido2-lib

src/preload/index.ts    →  ipcRenderer (contextBridge) ✓  [ONLY bridge]
```

Any import that crosses a ✗→ boundary is an architecture violation and must be removed.

---

## Active Hardware Provider Set (Windows)

This section documents the current set of active `IHardwareIdentityProvider` implementations on Windows and clarifies which dependencies are present but intentionally unused for certain operations.

### `Fido2CliHardwareIdentityProvider` — Sole Active CTAP2 Provider on Windows

`Fido2CliHardwareIdentityProvider` is the **exclusive provider** for all CTAP2 operations on Windows. It routes every `createCredential`, `getAssertion`, and related call through the `windows://hello` synthetic device path by spawning the bundled `fido2-cred.exe`, `fido2-assert.exe`, and `fido2-token.exe` subprocess tools that ship with libfido2 1.15.0.

```
IHardwareIdentityProvider
        │
        └─► Fido2CliHardwareIdentityProvider
                │  spawns child process
                ▼
           fido2-assert.exe / fido2-cred.exe / fido2-token.exe
                │  device path argument
                ▼
           windows://hello  (routes through webauthn.dll)
                │
                ▼
           Physical FIDO2 authenticator (e.g. YubiKey 5C NFC)
```

This design is required because Windows 10 1903+ places an exclusive OS HID claim on FIDO2 devices, making direct `node-hid` access impossible. The libfido2 CLI tools bypass this restriction by routing through `webauthn.dll` via the `windows://hello` synthetic path.

The previous table entry `Libfido2HardwareIdentityProvider` is **not in active use**; it is superseded by `Fido2CliHardwareIdentityProvider`.

### `NodeHidHardwareIdentityProvider` — Device Detection Delegate

`NodeHidHardwareIdentityProvider` performs device enumeration on Windows by scanning the full HID device list for known FIDO2 vendor IDs. When a known vendor is detected and no FIDO HID interface is directly accessible (due to the OS claim), it **delegates all subsequent CTAP2 calls** (`createCredential`, `getAssertion`, `discoverCredentials`) to `Fido2CliHardwareIdentityProvider`. It does not perform CTAP2 operations itself on Windows.

### `@vaultys/webauthn-node` — Dependency Present, NOT Used for hmac-secret

`@vaultys/webauthn-node` is listed as a package dependency but **must not be instantiated for any operation that requires the hmac-secret extension**.

Reason: the `@vaultys/webauthn-node` C++ binding does not implement the hmac-secret extension in its `GetAssertion` path. Calling it for a PRF derivation operation silently omits the `hmac-secret` extension, returning no `PRF_Output` and yielding a silent derivation failure.

The forbidden usage pattern is:

```ts
// FORBIDDEN — @vaultys/webauthn-node does not support hmac-secret
import WebAuthnNode from '@vaultys/webauthn-node';
const result = await WebAuthnNode.getAssertion({ extensions: { hmacSecret: salt } });
// ^ extension is silently ignored; PRF_Output will not be returned
```

The correct path for any hmac-secret operation is always `Fido2CliHardwareIdentityProvider`.

### Updated Known Implementations Table

| Class | Location | Purpose | Active on Windows |
|---|---|---|---|
| `Fido2CliHardwareIdentityProvider` | `src/main/hardware/` | Production — CTAP2 via libfido2 CLI subprocess through `windows://hello` | ✅ Yes — sole active provider |
| `NodeHidHardwareIdentityProvider` | `src/main/hardware/` | Device detection — delegates CTAP2 to `Fido2CliHardwareIdentityProvider` on Windows | ✅ Yes — for enumeration |
| `Libfido2HardwareIdentityProvider` | `src/main/hardware/` | Superseded — direct libfido2 binding (blocked by OS HID claim on Windows 10 1903+) | ❌ Not active |
| `MockHardwareIdentityProvider` | `test/mocks/MockHardwareIdentityProvider.ts` | Tests — deterministic software mock, no real hardware | ✅ Tests only |
