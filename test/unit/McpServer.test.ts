// test/unit/McpServer.test.ts
//
// Unit tests for MCP server tools — Validates: Requirements 19

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

// ─── Mock @solana/web3.js ─────────────────────────────────────────────────────
// Must be declared before any import that pulls in @solana/web3.js.
// We preserve the real Transaction / SystemProgram / PublicKey (needed to build
// a real test transaction) and only mock the Connection class.
//
// Connection must be declared as a class so `new Connection(...)` works inside
// server.ts. The instance methods are individually mockable via vi.fn().

const mockGetBalance = vi.fn();
const mockGetSignaturesForAddress = vi.fn();
const connectionConstructorArgs: Array<unknown[]> = [];

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();

  class Connection {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      connectionConstructorArgs.push(args);
    }
    getBalance = mockGetBalance;
    getSignaturesForAddress = mockGetSignaturesForAddress;
  }

  return {
    ...actual,
    Connection,
  };
});

// ─── Import server AFTER mock is set up ──────────────────────────────────────
import { server } from '../../src/mcp/server';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Retrieves a registered tool handler by name via the private record on McpServer.
 * `_registeredTools` is a plain object keyed by tool name.
 * The handler signature is: (args, extra) => result | Promise<result>
 */
function getToolHandler(name: string): (args: unknown) => unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (args: unknown, extra: unknown) => unknown }>;
  const registered = tools[name];
  if (!registered) {
    throw new Error(`Tool "${name}" is not registered on the MCP server.`);
  }
  // Invoke handler with (args, fakeExtra) — the extra param is not used by these handlers
  return (args: unknown) => registered.handler(args, {} as never);
}

/**
 * Builds a valid base64-encoded unsigned Solana transaction for testing.
 */
function buildValidTransactionBase64(): string {
  const from = new PublicKey(new Uint8Array(32).fill(1));
  const to = new PublicKey(new Uint8Array(32).fill(2));
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = '11111111111111111111111111111111';
  tx.add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1000n }),
  );
  const serialized = tx.serialize({ requireAllSignatures: false });
  return serialized.toString('base64');
}

/**
 * Parses the first text content item from a tool result as JSON.
 */
function parseResult(result: unknown): unknown {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

// ─── Tests: inspect_transaction ──────────────────────────────────────────────

describe('MCP tool: inspect_transaction', () => {
  let inspect: (args: unknown) => unknown;

  beforeEach(() => {
    inspect = getToolHandler('inspect_transaction');
  });

  it('returns correct decoded fields for a valid unsigned transaction', async () => {
    const transaction_base64 = buildValidTransactionBase64();

    const result = await inspect({ transaction_base64 });
    const parsed = parseResult(result) as {
      program: string;
      accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      instruction_data: string;
      fee_payer: string | null;
    };

    // The System Program transfer instruction targets the System Program
    expect(parsed.program).toBe('11111111111111111111111111111111');

    // There should be at least two accounts (from and to)
    expect(Array.isArray(parsed.accounts)).toBe(true);
    expect(parsed.accounts.length).toBeGreaterThanOrEqual(2);

    // instruction_data should be a non-empty base64 string
    expect(typeof parsed.instruction_data).toBe('string');
    expect(parsed.instruction_data.length).toBeGreaterThan(0);

    // fee_payer should be the from address (all 0x01 bytes → known Base58)
    expect(typeof parsed.fee_payer).toBe('string');
    expect(parsed.fee_payer).not.toBeNull();
  });

  it('rejects invalid base64 with a structured error containing failure_reason', async () => {
    const result = await inspect({ transaction_base64: '!!!not-base64!!!' });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason.length).toBeGreaterThan(0);
  });

  it('rejects a base64 string that is not a valid Solana transaction', async () => {
    // Valid base64, but garbage bytes — not a parsable transaction
    const garbled = Buffer.from('this is definitely not a solana transaction').toString('base64');
    const result = await inspect({ transaction_base64: garbled });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
  });

  it('rejects input containing a private_key field', async () => {
    const transaction_base64 = buildValidTransactionBase64();

    const result = await inspect({
      transaction_base64,
      private_key: 'some-secret-material',
    });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason).toMatch(/private_key/i);
  });

  it('rejects input containing a wallet_seed field', async () => {
    const transaction_base64 = buildValidTransactionBase64();

    const result = await inspect({
      transaction_base64,
      wallet_seed: 'some-seed',
    });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason).toMatch(/wallet_seed/i);
  });

  it('rejects input containing a prf_output field', async () => {
    const transaction_base64 = buildValidTransactionBase64();

    const result = await inspect({
      transaction_base64,
      prf_output: 'some-prf-bytes',
    });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason).toMatch(/prf_output/i);
  });

  it('rejects an empty string as invalid base64', async () => {
    const result = await inspect({ transaction_base64: '' });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
  });
});

// ─── Tests: query_devnet ─────────────────────────────────────────────────────

describe('MCP tool: query_devnet', () => {
  let query: (args: unknown) => Promise<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    connectionConstructorArgs.length = 0;
    query = getToolHandler('query_devnet') as (args: unknown) => Promise<unknown>;
  });

  it('returns balance and signatures for a valid 32-byte address', async () => {
    mockGetBalance.mockResolvedValue(1_500_000_000);
    mockGetSignaturesForAddress.mockResolvedValue([
      { signature: 'sig1' },
      { signature: 'sig2' },
    ]);

    // A valid 32-byte Base58 address (all 0x01 bytes)
    const address = new PublicKey(new Uint8Array(32).fill(1)).toBase58();

    const result = await query({ address });
    const parsed = parseResult(result) as {
      balance_sol: string;
      balance_lamports: number;
      recent_signatures: string[];
    };

    expect(parsed.balance_sol).toBe('1.5000');
    expect(parsed.balance_lamports).toBe(1_500_000_000);
    expect(parsed.recent_signatures).toEqual(['sig1', 'sig2']);
  });

  it('rejects an address that decodes to fewer than 32 bytes', async () => {
    // bs58-encode 31 bytes → decodes back to 31 bytes, not 32
    const { default: bs58 } = await import('bs58');
    const short = bs58.encode(new Uint8Array(31).fill(0xaa));

    const result = await query({ address: short });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason).toMatch(/31/);
    expect(parsed.failure_reason).toMatch(/32/);
  });

  it('rejects an address that decodes to more than 32 bytes', async () => {
    const { default: bs58 } = await import('bs58');
    const long = bs58.encode(new Uint8Array(33).fill(0xbb));

    const result = await query({ address: long });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason).toMatch(/33/);
    expect(parsed.failure_reason).toMatch(/32/);
  });

  it('rejects a non-Base58 string', async () => {
    const result = await query({ address: '!!!invalid!!!' });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason.length).toBeGreaterThan(0);
  });

  it('returns a failure_reason when the devnet RPC call fails', async () => {
    mockGetBalance.mockRejectedValue(new Error('network timeout'));
    mockGetSignaturesForAddress.mockRejectedValue(new Error('network timeout'));

    const address = new PublicKey(new Uint8Array(32).fill(1)).toBase58();

    const result = await query({ address });
    const parsed = parseResult(result) as { failure_reason: string };

    expect(typeof parsed.failure_reason).toBe('string');
    expect(parsed.failure_reason).toMatch(/network timeout/i);
  });

  it('uses the devnet RPC URL when constructing the Connection', async () => {
    mockGetBalance.mockResolvedValue(0);
    mockGetSignaturesForAddress.mockResolvedValue([]);

    const beforeCount = connectionConstructorArgs.length;
    const address = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
    await query({ address });

    // A new Connection should have been constructed during this call
    const newCalls = connectionConstructorArgs.slice(beforeCount);
    expect(newCalls.length).toBeGreaterThan(0);

    // The first argument to the constructor must be the devnet RPC URL
    expect(newCalls[0][0]).toBe('https://api.devnet.solana.com');
    expect(newCalls[0][1]).toBe('confirmed');
  });
});
