/**
 * MCP Server for KeyWallet
 *
 * Exposes two tools:
 *   - inspect_transaction: Decodes and inspects a base64-encoded unsigned Solana transaction
 *   - query_devnet:        Fetches balance and recent signatures for a Solana devnet address
 *
 * Req 19
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Transaction, Connection, PublicKey } from '@solana/web3.js';
import bs58Default from 'bs58';

// bs58 ships an ESM default — under CJS esModuleInterop this is the right handle
const bs58 = bs58Default as unknown as { decode: (s: string) => Uint8Array };

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TX_BYTES = 10_240; // 10 KB

/** Fields that must never appear in MCP tool inputs (Req 19.3) */
const FORBIDDEN_INPUT_FIELDS = ['private_key', 'wallet_seed', 'prf_output'] as const;

const DEVNET_RPC = 'https://api.devnet.solana.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true when `value` is a valid base64 string (standard or URL-safe alphabet, with or without padding).
 */
function isValidBase64(value: string): boolean {
  // Accept standard (+/) and URL-safe (-_) base64, optional padding
  return /^[A-Za-z0-9+/\-_]*={0,2}$/.test(value) && value.length > 0;
}

/**
 * Normalise base64url to standard base64 then decode.
 */
function decodeBase64(value: string): Buffer {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(standard, 'base64');
}

/**
 * Structured error response used whenever input validation fails (Req 19.5).
 */
function structuredError(reason: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ failure_reason: reason }),
      },
    ],
  };
}

// ─── MCP Server instance ─────────────────────────────────────────────────────

export const server = new McpServer(
  {
    name: 'key-wallet-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ─── Tool: inspect_transaction ───────────────────────────────────────────────

server.registerTool(
  'inspect_transaction',
  {
    description:
      'Decodes a base64-encoded unsigned Solana transaction and returns human-readable fields ' +
      '(program, accounts, instruction_data, fee_payer). ' +
      'Never accepts or returns private keys, wallet seeds, or PRF outputs.',
    inputSchema: {
      transaction_base64: z.string().describe('Base64-encoded serialised Solana transaction bytes'),
    },
  },
  (args) => {
    // Reject any object that smuggles in forbidden field names (Req 19.3)
    const rawKeys = Object.keys(args as Record<string, unknown>);
    for (const forbidden of FORBIDDEN_INPUT_FIELDS) {
      if (rawKeys.includes(forbidden)) {
        return structuredError(
          `Input must not contain the field "${forbidden}". Private key material is not accepted.`,
        );
      }
    }

    const { transaction_base64 } = args as { transaction_base64: string };

    // 1. Validate base64 format
    if (!isValidBase64(transaction_base64)) {
      return structuredError('transaction_base64 is not valid base64.');
    }

    // 2. Decode
    let buf: Buffer;
    try {
      buf = decodeBase64(transaction_base64);
    } catch {
      return structuredError('Failed to decode transaction_base64 as base64.');
    }

    // 3. Size guard: reject payloads > 10 KB (Req 19.5)
    if (buf.length > MAX_TX_BYTES) {
      return structuredError(
        `Decoded transaction is ${buf.length} bytes, which exceeds the 10 KB limit (${MAX_TX_BYTES} bytes).`,
      );
    }

    // 4. Parse as Solana Transaction
    let tx: Transaction;
    try {
      tx = Transaction.from(buf);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return structuredError(`Failed to parse as a Solana transaction: ${message}`);
    }

    // 5. Extract fields from the first instruction
    const instruction = tx.instructions[0];
    if (instruction === undefined) {
      return structuredError('Transaction contains no instructions.');
    }

    const program = instruction.programId.toBase58();
    const accounts = instruction.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    }));
    const instruction_data = Buffer.from(instruction.data).toString('base64');
    const fee_payer = tx.feePayer ? tx.feePayer.toBase58() : null;

    const result = { program, accounts, instruction_data, fee_payer };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// ─── Tool: query_devnet ──────────────────────────────────────────────────────

server.registerTool(
  'query_devnet',
  {
    description:
      'Fetches the SOL balance and 10 most recent transaction signatures for a Solana devnet address. ' +
      'Never accepts or returns private keys, wallet seeds, or PRF outputs.',
    inputSchema: {
      address: z.string().describe('Base58-encoded Solana public key (32 bytes when decoded)'),
    },
  },
  async (args) => {
    // Reject forbidden fields (Req 19.3)
    const rawKeys = Object.keys(args as Record<string, unknown>);
    for (const forbidden of FORBIDDEN_INPUT_FIELDS) {
      if (rawKeys.includes(forbidden)) {
        return structuredError(
          `Input must not contain the field "${forbidden}". Private key material is not accepted.`,
        );
      }
    }

    const { address } = args as { address: string };

    // 1. Validate: must decode to exactly 32 bytes (Req 19.2)
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(address);
    } catch {
      return structuredError(`"${address}" is not a valid Base58 string.`);
    }

    if (decoded.length !== 32) {
      return structuredError(
        `Address decodes to ${decoded.length} bytes; expected exactly 32 bytes for a Solana public key.`,
      );
    }

    // 2. Create devnet connection and fetch data
    const connection = new Connection(DEVNET_RPC, 'confirmed');
    const pubkey = new PublicKey(address);

    let balanceLamports: number;
    let signatures: string[];

    try {
      [balanceLamports, signatures] = await Promise.all([
        connection.getBalance(pubkey),
        connection
          .getSignaturesForAddress(pubkey, { limit: 10 })
          .then((sigs) => sigs.map((s) => s.signature)),
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return structuredError(`Devnet RPC request failed: ${message}`);
    }

    const LAMPORTS_PER_SOL = 1_000_000_000;
    const balance_sol = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);

    const result = {
      balance_sol,
      balance_lamports: balanceLamports,
      recent_signatures: signatures,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Starts the MCP server over stdio.
 * Run with: `node dist/mcp/server.js`
 */
export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until the transport closes
}

// Run when executed directly (CommonJS: require.main === module)
if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`MCP server startup failed: ${message}\n`);
    process.exit(1);
  });
}
