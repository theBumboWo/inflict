// src/main/solana/SolanaService.ts

import { EventEmitter } from "events";
import { Connection, PublicKey } from "@solana/web3.js";
import type { ErrorCategory } from "../../shared/ipc-types";

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface BalanceResult {
  lamports: bigint;
  sol: string; // Formatted to 4 decimal places
  fetchedAt: Date;
}

export interface ISolanaService {
  getBalance(walletAddress: string): Promise<BalanceResult>;
  getRecentTransactions(walletAddress: string): Promise<string[]>;
  getRecentBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  startPeriodicRefresh(walletAddress: string, intervalMs: number): void;
  stopPeriodicRefresh(): void;
}

// ─── Typed RPC Error ──────────────────────────────────────────────────────────

export class SolanaRpcError extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = "SolanaRpcError";
    this.category = category;
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Returns a promise that rejects after `ms` milliseconds with a
 * `SolanaRpcError` carrying the given category.
 */
function createTimeoutPromise(
  ms: number,
  category: ErrorCategory,
  label: string
): Promise<never> {
  return new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      reject(
        new SolanaRpcError(category, `${label} timed out after ${ms}ms`)
      );
    }, ms);
    // Allow Node to exit even if this timeout is still pending
    if (typeof id === "object" && (id as NodeJS.Timeout).unref) {
      (id as NodeJS.Timeout).unref();
    }
  });
}

/**
 * Format lamports as SOL with exactly 4 decimal places.
 * Uses bigint arithmetic to avoid floating-point precision issues.
 */
function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(4);
}

/**
 * Compute exponential backoff: min(2^retryCount * 2000, 60000).
 * Starts at 2s (n=0), doubles each retry, caps at 60s.
 */
function backoffMs(retryCount: number): number {
  return Math.min(Math.pow(2, retryCount) * 2000, 60_000);
}

// ─── SolanaService ────────────────────────────────────────────────────────────

const DEVNET_RPC = "https://api.devnet.solana.com";

const BALANCE_TIMEOUT_MS = 15_000;
const BLOCKHASH_TIMEOUT_MS = 10_000;

export class SolanaService extends EventEmitter implements ISolanaService {
  // Hard-coded to devnet — no configurable RPC endpoint (Req 7.5)
  private readonly connection: Connection = new Connection(
    DEVNET_RPC,
    "confirmed"
  );

  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private periodicAddress: string | null = null;
  private periodicInterval: number = 0;
  private periodicRetryCount: number = 0;
  private periodicBackoffTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Fetch the lamport balance for a wallet address.
   * Throws `SolanaRpcError` with category "rpc-timeout" on timeout (>15s),
   * or "rpc-unreachable" / "rpc-invalid-response" on network failure.
   */
  async getBalance(walletAddress: string): Promise<BalanceResult> {
    const pubkey = new PublicKey(walletAddress);

    const fetchPromise = this.connection
      .getBalance(pubkey)
      .catch((err: unknown) => {
        throw this._wrapNetworkError(err);
      });

    const lamportsNumber = await Promise.race([
      fetchPromise,
      createTimeoutPromise(BALANCE_TIMEOUT_MS, "rpc-timeout", "getBalance"),
    ]);

    const lamports = BigInt(lamportsNumber);
    return {
      lamports,
      sol: formatSol(lamports),
      fetchedAt: new Date(),
    };
  }

  /**
   * Fetch the 10 most recent transaction signatures for a wallet address.
   * Throws `SolanaRpcError` on network failure.
   */
  async getRecentTransactions(walletAddress: string): Promise<string[]> {
    const pubkey = new PublicKey(walletAddress);

    try {
      const signatures = await this.connection.getSignaturesForAddress(pubkey, {
        limit: 10,
      });
      return signatures.map((s) => s.signature);
    } catch (err) {
      throw this._wrapNetworkError(err);
    }
  }

  /**
   * Fetch a recent blockhash with a 10-second timeout.
   * Throws `SolanaRpcError` with category "rpc-timeout" on timeout.
   */
  async getRecentBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const fetchPromise = this.connection
      .getLatestBlockhash("confirmed")
      .catch((err: unknown) => {
        throw this._wrapNetworkError(err);
      });

    return Promise.race([
      fetchPromise,
      createTimeoutPromise(
        BLOCKHASH_TIMEOUT_MS,
        "rpc-timeout",
        "getRecentBlockhash"
      ),
    ]);
  }

  /**
   * Start a periodic balance refresh loop.
   * Emits 'balance' event with `BalanceResult` on success.
   * Emits 'balanceUnavailable' on RPC failure, then applies exponential
   * backoff before scheduling the next retry (Req 7.4).
   * Calling `startPeriodicRefresh` while already running resets the timer.
   */
  startPeriodicRefresh(walletAddress: string, intervalMs: number): void {
    // Reset any existing refresh to support manual refresh triggering a reset
    this.stopPeriodicRefresh();

    this.periodicAddress = walletAddress;
    this.periodicInterval = intervalMs;
    this.periodicRetryCount = 0;

    this._scheduleNextRefresh(intervalMs);
  }

  /**
   * Stop the periodic refresh interval immediately (Req 7.6).
   */
  stopPeriodicRefresh(): void {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    if (this.periodicBackoffTimer !== null) {
      clearTimeout(this.periodicBackoffTimer);
      this.periodicBackoffTimer = null;
    }
    this.periodicAddress = null;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Schedule the next refresh tick using `setInterval`, then kick off the
   * first fetch immediately.
   */
  private _scheduleNextRefresh(delayMs: number): void {
    this.periodicTimer = setInterval(() => {
      void this._doPeriodicFetch();
    }, delayMs);

    // Kick off an immediate fetch without waiting for the first interval
    void this._doPeriodicFetch();
  }

  /**
   * Single periodic fetch attempt. On failure applies exponential backoff
   * by clearing the current interval and re-scheduling after backoff delay.
   */
  private async _doPeriodicFetch(): Promise<void> {
    const address = this.periodicAddress;
    if (address === null) return;

    try {
      const result = await this.getBalance(address);
      // Success — reset retry counter
      this.periodicRetryCount = 0;
      this.emit("balance", result);
    } catch {
      // RPC failure — emit unavailable, then apply exponential backoff (Req 7.4)
      this.emit("balanceUnavailable");

      const delay = backoffMs(this.periodicRetryCount);
      this.periodicRetryCount++;

      // Stop current interval and wait for backoff before restarting
      if (this.periodicTimer !== null) {
        clearInterval(this.periodicTimer);
        this.periodicTimer = null;
      }

      const address2 = this.periodicAddress;
      if (address2 !== null) {
        this.periodicBackoffTimer = setTimeout(() => {
          this.periodicBackoffTimer = null;
          // Only restart if still active (stopPeriodicRefresh not called)
          if (this.periodicAddress !== null) {
            this._scheduleNextRefresh(this.periodicInterval);
          }
        }, delay);
      }
    }
  }

  /**
   * Convert a raw network error from the Solana RPC client into a typed
   * `SolanaRpcError` with the appropriate `ErrorCategory`.
   */
  private _wrapNetworkError(err: unknown): SolanaRpcError {
    if (err instanceof SolanaRpcError) return err;

    const message =
      err instanceof Error ? err.message : "Unknown RPC error";

    // Heuristic classification based on error message
    if (
      message.includes("fetch") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND") ||
      message.includes("network") ||
      message.includes("Failed to fetch")
    ) {
      return new SolanaRpcError("rpc-unreachable", message);
    }

    if (
      message.includes("Invalid") ||
      message.includes("parse") ||
      message.includes("JSON")
    ) {
      return new SolanaRpcError("rpc-invalid-response", message);
    }

    return new SolanaRpcError("rpc-unreachable", message);
  }
}
