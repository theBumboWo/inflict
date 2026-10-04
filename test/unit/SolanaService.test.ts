// test/unit/SolanaService.test.ts
//
// Unit tests for SolanaService — Validates: Requirements 7

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Mock @solana/web3.js ─────────────────────────────────────────────────────
// Must be declared before any import that pulls in @solana/web3.js.
// Connection must be a proper class so `new Connection(...)` works.

const mockGetBalance = vi.fn();
const mockGetSignaturesForAddress = vi.fn();
const mockGetLatestBlockhash = vi.fn();

vi.mock("@solana/web3.js", () => {
  // Connection must be a class (constructor function) so `new Connection()`
  // works inside SolanaService.
  class Connection {
    getBalance = mockGetBalance;
    getSignaturesForAddress = mockGetSignaturesForAddress;
    getLatestBlockhash = mockGetLatestBlockhash;
  }

  // PublicKey just needs to be constructable.
  class PublicKey {
    private addr: string;
    constructor(address: string) {
      this.addr = address;
    }
    toBase58() {
      return this.addr;
    }
  }

  return { Connection, PublicKey };
});

import { SolanaService } from "../../src/main/solana/SolanaService";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A valid-looking (but fake) Base58 wallet address for tests */
const FAKE_ADDRESS = "11111111111111111111111111111112";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SolanaService", () => {
  let service: SolanaService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SolanaService();
  });

  afterEach(() => {
    service.stopPeriodicRefresh();
    vi.useRealTimers();
  });

  // ── Balance Formatting ────────────────────────────────────────────────────

  describe("balance formatting", () => {
    it('formats 1 lamport as "0.0000" SOL', async () => {
      mockGetBalance.mockResolvedValueOnce(1);

      const result = await service.getBalance(FAKE_ADDRESS);

      expect(result.sol).toBe("0.0000");
      expect(result.lamports).toBe(1n);
    });

    it('formats 1_000_000_000 lamports as "1.0000" SOL', async () => {
      mockGetBalance.mockResolvedValueOnce(1_000_000_000);

      const result = await service.getBalance(FAKE_ADDRESS);

      expect(result.sol).toBe("1.0000");
      expect(result.lamports).toBe(1_000_000_000n);
    });

    it("formats 500_000_000 lamports (0.5 SOL) with 4 decimal places", async () => {
      mockGetBalance.mockResolvedValueOnce(500_000_000);

      const result = await service.getBalance(FAKE_ADDRESS);

      expect(result.sol).toBe("0.5000");
    });

    it("formats 0 lamports as \"0.0000\" SOL", async () => {
      mockGetBalance.mockResolvedValueOnce(0);

      const result = await service.getBalance(FAKE_ADDRESS);

      expect(result.sol).toBe("0.0000");
      expect(result.lamports).toBe(0n);
    });
  });

  // ── stopPeriodicRefresh ───────────────────────────────────────────────────

  describe("stopPeriodicRefresh", () => {
    it("calls clearInterval when a periodic refresh is running", async () => {
      vi.useFakeTimers();

      // Make getBalance resolve immediately so the initial fetch completes
      mockGetBalance.mockResolvedValue(1_000_000_000);

      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      service.startPeriodicRefresh(FAKE_ADDRESS, 5_000);

      // Flush the initial async getBalance call (Promise microtasks)
      await Promise.resolve();
      await Promise.resolve();

      service.stopPeriodicRefresh();

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it("does not call clearInterval when no refresh is running", () => {
      vi.useFakeTimers();

      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      // No startPeriodicRefresh — interval is null
      service.stopPeriodicRefresh();

      expect(clearIntervalSpy).not.toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it("stops emitting balance events after stopPeriodicRefresh is called", async () => {
      vi.useFakeTimers();

      mockGetBalance.mockResolvedValue(1_000_000_000);

      const balanceEvents: unknown[] = [];
      service.on("balance", (result) => balanceEvents.push(result));

      service.startPeriodicRefresh(FAKE_ADDRESS, 1_000);

      // Let the initial immediate fetch complete
      await vi.advanceTimersByTimeAsync(100);

      // Now stop — clear the interval
      service.stopPeriodicRefresh();

      // Record the count at the point we stopped
      const countAfterStop = balanceEvents.length;

      // Advance by several more intervals — no new events should fire
      await vi.advanceTimersByTimeAsync(5_000);

      expect(balanceEvents.length).toBe(countAfterStop);
    });
  });

  // ── Devnet-only RPC ───────────────────────────────────────────────────────

  describe("devnet-only RPC enforcement", () => {
    it("source file references devnet URL", () => {
      const sourcePath = path.resolve(
        __dirname,
        "../../src/main/solana/SolanaService.ts"
      );
      const source = fs.readFileSync(sourcePath, "utf8");

      expect(source).toContain("devnet.solana.com");
    });

    it("source file does not contain a mainnet RPC URL", () => {
      const sourcePath = path.resolve(
        __dirname,
        "../../src/main/solana/SolanaService.ts"
      );
      const source = fs.readFileSync(sourcePath, "utf8");

      expect(source).not.toContain("mainnet-beta.solana.com");
      expect(source).not.toContain("mainnet.solana.com");
      // Catch any plain "mainnet" URL pattern (but allow the word "mainnet" in comments)
      expect(source).not.toMatch(/https?:\/\/[^\s"']*mainnet/);
    });

    it("source file does not contain a testnet RPC URL", () => {
      const sourcePath = path.resolve(
        __dirname,
        "../../src/main/solana/SolanaService.ts"
      );
      const source = fs.readFileSync(sourcePath, "utf8");

      expect(source).not.toContain("testnet.solana.com");
      expect(source).not.toMatch(/https?:\/\/[^\s"']*testnet/);
    });
  });

  // ── getBalance integration ────────────────────────────────────────────────

  describe("getBalance", () => {
    it("returns fetchedAt as a Date", async () => {
      mockGetBalance.mockResolvedValueOnce(42_000_000);

      const result = await service.getBalance(FAKE_ADDRESS);

      expect(result.fetchedAt).toBeInstanceOf(Date);
    });
  });
});
