---
name: "hardware-wallet-security"
displayName: "Hardware Wallet Security"
description: "Security enforcement for FIDO2/CTAP2 hardware key wallets on Windows. Enforces secret-handling rules for PRF derivation, provides MCP tools for Solana transaction inspection and devnet queries."
keywords: ["fido2", "ctap2", "yubikey", "hmac-secret", "webauthn", "prf", "solana", "wallet", "hardware key", "derivation", "security audit", "secret zeroing", "enrollment"]
author: "BumboWo"
---

# Hardware Wallet Security Power

Security enforcement for FIDO2/CTAP2 hardware key wallets. Activates automatically when working on FIDO2 hardware providers, PRF derivation, or Solana wallet security.

## What this power does

- Enforces the four KeyWallet secret-handling rules on every code change
- Provides `inspect_transaction` and `query_devnet` MCP tools for safe Solana devnet work
- Auto-injects security policy for `src/main/derivation/`, `src/main/hardware/`, and `src/main/session/`

## The four security rules

1. **No PRF_Output or private key bytes to disk** — only credential metadata (ID, display name, RP ID) may be persisted
2. **No logging of secret material** — `PRF_Output`, `Wallet_Seed`, and `keypair.secretKey` must never appear in any log call
3. **Zero-overwrite secret buffers immediately after use** — `.fill(0)` inside a `finally` block, always
4. **Platform CSPRNG only** — `node:crypto.randomBytes()` in main process, `crypto.getRandomValues()` in renderer

## Available MCP Tools

### key-wallet-mcp

**Package:** local stdio via `npx tsx src/mcp/server.ts`

**Tools:**

- `inspect_transaction` — decodes a base64 unsigned Solana transaction into human-readable fields; rejects any input containing `private_key`, `wallet_seed`, or `prf_output`
- `query_devnet` — fetches SOL balance and 10 most recent signatures for a Base58 devnet address; validates address decodes to exactly 32 bytes

## Steering files

Load `steering/security.md` for any work involving:
- FIDO2/CTAP2 operations or hardware provider changes
- PRF/hmac-secret derivation path
- Session lifecycle or keypair handling
- Credential store writes

Load `steering/architecture.md` for provider selection, Windows Hello fallback logic, or subprocess spawning.

---

## Power metadata

- **License:** MIT
- **Source:** https://github.com/BumboWo/inflict
