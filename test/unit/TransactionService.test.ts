// test/unit/TransactionService.test.ts
//
// Unit tests for TransactionService — Validates: Requirements 8

import { describe, it, expect, vi, beforeEach } from "vitest";
import bs58 from "bs58";
import { TransactionService } from "../../src/main/transaction/TransactionService";
import type { ISolanaService } from "../../src/main/solana/SolanaService";
import { SolanaRpcError } from "../../src/main/solana/SolanaService";
import type { TransferParams } from "../../src/shared/ipc-types";

// ─── Mock ISolanaService ──────────────────────────────────────────────────────

function makeMockSolanaService(): ISolanaService {
  return {
    getBalance: vi.fn(),
    getRecentTransactions: vi.fn(),
    getRecentBlockhash: vi.fn(),
    startPeriodicRefresh: vi.fn(),
    stopPeriodicRefresh: vi.fn(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A valid 32-byte Base58-encoded address (all 0x01 bytes). */
const VALID_ADDRESS_32 = bs58.encode(new Uint8Array(32).fill(0x01));

/** Fixed fee used by TransactionService. */
const ESTIMATED_FEE = 5_000n;

/**
 * Build a TransferParams object with sensible defaults that pass validation,
 * overriding any fields you supply.
 */
function makeParams(overrides: Partial<TransferParams> = {}): TransferParams {
  return {
    destinationAddress: VALID_ADDRESS_32,
    lamports: 1n,
    currentBalanceLamports: 10_000n,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TransactionService.validateTransferParams", () => {
  let solana: ISolanaService;
  let service: TransactionService;

  beforeEach(() => {
    solana = makeMockSolanaService();
    service = new TransactionService(solana);
  });

  // ── Address validation ─────────────────────────────────────────────────────

  it("rejects a 31-byte decoded address", () => {
    // Encode 31 bytes as Base58; the string length will be within 32–44 chars
    // but the decoded byte count will be 31 — must be rejected (Req 8.2).
    const addr31 = bs58.encode(new Uint8Array(31).fill(0xaa));
    const result = service.validateTransferParams(
      makeParams({ destinationAddress: addr31 })
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("destination");
    expect(result!.reason).toMatch(/32/); // error mentions 32 bytes
  });

  it("rejects a 33-byte decoded address", () => {
    // Encode 33 bytes as Base58; same logic — decoded length ≠ 32.
    const addr33 = bs58.encode(new Uint8Array(33).fill(0xbb));
    const result = service.validateTransferParams(
      makeParams({ destinationAddress: addr33 })
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("destination");
    expect(result!.reason).toMatch(/32/);
  });

  it("accepts a valid 32-byte decoded address", () => {
    const result = service.validateTransferParams(
      makeParams({ destinationAddress: VALID_ADDRESS_32 })
    );
    // Address part must not produce an error
    expect(result).toBeNull();
  });

  // ── Amount validation ──────────────────────────────────────────────────────

  it("rejects amount = 0 lamports", () => {
    // Req 8.3: must be ≥ 1 lamport.
    const result = service.validateTransferParams(
      makeParams({ lamports: 0n, currentBalanceLamports: 10_000n })
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("amount");
  });

  it("rejects amount > balance - fee (lamports = 5001, balance = 10000)", () => {
    // maxTransferable = 10000 - 5000 = 5000; sending 5001 must be rejected.
    const result = service.validateTransferParams(
      makeParams({ lamports: 5_001n, currentBalanceLamports: 10_000n })
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("amount");
  });

  it("accepts the exact boundary: amount = balance - fee (lamports = 5000, balance = 10000)", () => {
    // maxTransferable = 10000 - 5000 = 5000; sending exactly 5000 must succeed.
    const result = service.validateTransferParams(
      makeParams({ lamports: 5_000n, currentBalanceLamports: 10_000n })
    );

    expect(result).toBeNull();
  });

  it("rejects amount = 1 lamport when balance is exactly the fee (no transferable amount)", () => {
    // balance = 5000, fee = 5000 → maxTransferable = 0; anything ≥ 1 rejected.
    const result = service.validateTransferParams(
      makeParams({ lamports: 1n, currentBalanceLamports: 5_000n })
    );

    expect(result).not.toBeNull();
    expect(result!.field).toBe("amount");
  });
});

// ─── buildTransactionPreview ──────────────────────────────────────────────────

describe("TransactionService.buildTransactionPreview", () => {
  let solana: ISolanaService;
  let service: TransactionService;

  beforeEach(() => {
    solana = makeMockSolanaService();
    service = new TransactionService(solana);
  });

  it("returns a TransactionPreview with the blockhash from SolanaService", async () => {
    const mockBlockhash = "FakeBlockhash1111111111111111111111111111111";
    vi.mocked(solana.getRecentBlockhash).mockResolvedValueOnce({
      blockhash: mockBlockhash,
      lastValidBlockHeight: 999,
    });

    const preview = await service.buildTransactionPreview(makeParams());

    expect(preview.blockhash).toBe(mockBlockhash);
    expect(preview.destinationAddress).toBe(VALID_ADDRESS_32);
    // Fee is always 5000 lamports = "0.000005000" SOL
    expect(preview.estimatedFeeSol).toBe("0.000005000");
  });

  it("rejects when getRecentBlockhash throws a blockhash timeout error", async () => {
    // Simulate a 10-second blockhash timeout — SolanaService throws SolanaRpcError.
    const timeoutError = new SolanaRpcError(
      "rpc-timeout",
      "getRecentBlockhash timed out after 10000ms"
    );
    vi.mocked(solana.getRecentBlockhash).mockRejectedValue(timeoutError);

    const rejection = service.buildTransactionPreview(makeParams());

    // Must reject with SolanaRpcError carrying the "rpc-timeout" category
    await expect(rejection).rejects.toThrow(SolanaRpcError);
    await expect(rejection).rejects.toMatchObject({ category: "rpc-timeout" });
  });

  it("rejects when getRecentBlockhash throws an rpc-unreachable error", async () => {
    const networkError = new SolanaRpcError(
      "rpc-unreachable",
      "Failed to fetch blockhash"
    );
    vi.mocked(solana.getRecentBlockhash).mockRejectedValueOnce(networkError);

    await expect(
      service.buildTransactionPreview(makeParams())
    ).rejects.toMatchObject({ category: "rpc-unreachable" });
  });
});
