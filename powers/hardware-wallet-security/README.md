# Hardware Wallet Security Power

Security enforcement power for KeyWallet. Bundles the security steering document, MCP tools for transaction inspection and devnet queries, and the Crypto Security Reviewer agent.

## Capabilities

- Enforces security policy for FIDO2/CTAP2 hardware key operations across all KeyWallet code changes, backed by the rules in `.kiro/steering/security.md`
- Provides MCP tools for inspecting Solana transactions and querying devnet without exposing private key material
- Includes the Crypto Security Reviewer agent for automated review of cryptographic code in `src/main/derivation/`, `src/main/hardware/`, and `src/main/session/`

## Exposed Tools

These tools are served by the `key-wallet-mcp` MCP server (`src/mcp/server.ts`).

### `inspect_transaction`

Decodes a base64-encoded unsigned Solana transaction and returns human-readable fields.

**Input:**

```json
{ "transaction_base64": "string" }
```

**Output:**

```json
{
  "program": "string",
  "accounts": [
    { "pubkey": "string", "isSigner": "boolean", "isWritable": "boolean" }
  ],
  "instruction_data": "string (base64)",
  "fee_payer": "string | null"
}
```

**Security constraints:**

- Rejects any input object containing the fields `private_key`, `wallet_seed`, or `prf_output`
- Never returns secret material
- Rejects decoded payloads larger than 10 KB

---

### `query_devnet`

Fetches the SOL balance and 10 most recent transaction signatures for a Solana devnet address.

**Input:**

```json
{ "address": "string (Base58, must decode to exactly 32 bytes)" }
```

**Output:**

```json
{
  "balance_sol": "string (4 decimal places)",
  "balance_lamports": "number",
  "recent_signatures": ["string"]
}
```

**Security constraints:**

- Accepts only a valid Base58 public key that decodes to exactly 32 bytes
- Fetches data from `https://api.devnet.solana.com` only
- Never accepts or returns private keys, wallet seeds, or PRF outputs

## Enforced Security Rules

The following four rules are non-negotiable for every file in `src/`. They are defined in `.kiro/steering/security.md` and enforced by this power on every code change.

1. **No PRF_Output or private key bytes to disk** — `PRF_Output`, `Wallet_Seed`, and private key bytes must never be written to any file, database, or persistent store. Only non-secret credential metadata (credential ID, display name, RP ID) may be persisted.

2. **No logging of secret material** — `PRF_Output`, `Wallet_Seed`, and `keypair.secretKey` must never appear in any log call (`console.log`, `console.error`, `logger.info`, or any equivalent), regardless of log level or error path.

3. **Zero-overwrite secret buffers immediately after use** — any `Buffer` or `Uint8Array` holding secret material must be zeroed with `.fill(0)` inside a `finally` block so memory is cleared even when an exception is thrown.

4. **Use platform CSPRNG only** — all random byte generation must use `crypto.getRandomValues()` (renderer/preload) or `node:crypto.randomBytes()` (main process). `Math.random()`, seeded generators, and any other non-CSPRNG source are forbidden for all security-relevant values.
