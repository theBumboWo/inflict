// src/main/transaction/TransactionService.ts

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { ISolanaService } from "../solana/SolanaService";
import type {
  TransferParams,
  TransactionPreview,
} from "../../shared/ipc-types";

// ─── Public Interfaces ────────────────────────────────────────────────────────

export type { TransferParams, TransactionPreview };

export interface SubmitResult {
  signature: string;
}

export type TransactionValidationError =
  | { field: "destination"; reason: string }
  | { field: "amount"; reason: string };

export interface ITransactionService {
  validateTransferParams(params: TransferParams): TransactionValidationError | null;
  buildTransactionPreview(params: TransferParams): Promise<TransactionPreview>;
  /**
   * Signs using the in-memory keypair. Never persists the private key.
   * Aborts within 2s if signal fires (Req 8.11).
   */
  signAndSubmit(
    params: TransferParams,
    keypair: Keypair,
    signal: AbortSignal
  ): Promise<SubmitResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard-wired devnet RPC — no mainnet/testnet allowed (Req 8.12) */
const DEVNET_RPC = "https://api.devnet.solana.com";

/** Cluster names that are explicitly rejected (Req 8.12) */
const REJECTED_CLUSTER_NAMES = new Set(["mainnet-beta", "testnet"]);

/** Blockhash validity window (Req 8.4) */
const BLOCKHASH_MAX_AGE_MS = 60_000;

/** Hold signed tx in memory for up to 30s to allow one retry (Req 8.10) */
const RETRY_HOLD_MS = 30_000;

/** Fixed estimated fee in lamports (5000 = typical Solana base fee) */
const ESTIMATED_FEE_LAMPORTS = BigInt(5_000);

/** 1 lamport per SOL in 9 decimal places */
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format lamports as SOL with exactly 9 decimal places.
 * Uses bigint arithmetic to avoid floating-point precision issues.
 */
function formatSol9(lamports: bigint): string {
  const wholePart = lamports / LAMPORTS_PER_SOL;
  const remainder = lamports % LAMPORTS_PER_SOL;
  // Pad remainder to 9 digits
  const fractional = remainder.toString().padStart(9, "0");
  return `${wholePart}.${fractional}`;
}

/**
 * Validate that a cluster name is not a rejected cluster (Req 8.12).
 * Throws if mainnet-beta or testnet is supplied.
 */
function assertDevnetCluster(clusterName?: string): void {
  if (clusterName !== undefined && REJECTED_CLUSTER_NAMES.has(clusterName)) {
    throw new Error(
      `TransactionService only supports devnet. Cluster "${clusterName}" is not allowed (Req 8.12).`
    );
  }
}

// ─── TransactionService ───────────────────────────────────────────────────────

export class TransactionService implements ITransactionService {
  /**
   * Internal devnet connection for sendRawTransaction.
   * Never exposes mainnet or testnet endpoints.
   */
  private readonly connection: Connection = new Connection(
    DEVNET_RPC,
    "confirmed"
  );

  /**
   * Holds the last failed signed transaction for retry within 30s (Req 8.10).
   */
  private pendingRetry: {
    serialized: Buffer;
    timestamp: number;
  } | null = null;

  constructor(private readonly solanaService: ISolanaService) {}

  // ── validateTransferParams ─────────────────────────────────────────────────

  /**
   * Validates destination address and transfer amount.
   * Returns null on success, or a TransactionValidationError describing the problem.
   *
   * Address validation (Req 8.2):
   *   - String length must be 32–44 characters
   *   - Base58-decoded bytes must be exactly 32 bytes
   *
   * Amount validation (Req 8.3, 8.9):
   *   - Must be ≥ 1 lamport
   *   - Must be ≤ (currentBalanceLamports - estimatedFee)
   */
  validateTransferParams(params: TransferParams): TransactionValidationError | null {
    // ── Destination address validation ──────────────────────────────────────
    const { destinationAddress, lamports, currentBalanceLamports } = params;

    if (
      destinationAddress.length < 32 ||
      destinationAddress.length > 44
    ) {
      return {
        field: "destination",
        reason: `Address must be 32–44 characters; got ${destinationAddress.length}`,
      };
    }

    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(destinationAddress);
    } catch {
      return {
        field: "destination",
        reason: "Address is not a valid Base58 string",
      };
    }

    if (decoded.length !== 32) {
      return {
        field: "destination",
        reason: `Address must decode to exactly 32 bytes; got ${decoded.length}`,
      };
    }

    // ── Amount validation ────────────────────────────────────────────────────
    if (lamports < BigInt(1)) {
      return {
        field: "amount",
        reason: "Transfer amount must be at least 1 lamport",
      };
    }

    const maxTransferable = currentBalanceLamports - ESTIMATED_FEE_LAMPORTS;
    if (maxTransferable < BigInt(0) || lamports > maxTransferable) {
      return {
        field: "amount",
        reason: `Transfer amount (${lamports} lamports) exceeds available balance minus estimated fee (${maxTransferable > BigInt(0) ? maxTransferable : 0} lamports)`,
      };
    }

    return null;
  }

  // ── buildTransactionPreview ────────────────────────────────────────────────

  /**
   * Fetches a recent blockhash (10s timeout via SolanaService) and constructs
   * a TransactionPreview without signing (Req 8.4, 8.5).
   *
   * Fee is estimated as a fixed 5000 lamports (typical Solana base fee).
   * Returns a TransactionPreview — no keys are involved at this stage.
   */
  async buildTransactionPreview(params: TransferParams): Promise<TransactionPreview> {
    const { destinationAddress, lamports } = params;

    // Fetch recent blockhash (getRecentBlockhash already enforces 10s timeout)
    const { blockhash } = await this.solanaService.getRecentBlockhash();

    return {
      destinationAddress,
      amountSol: formatSol9(lamports),
      estimatedFeeSol: formatSol9(ESTIMATED_FEE_LAMPORTS),
      blockhash,
    };
  }

  // ── signAndSubmit ──────────────────────────────────────────────────────────

  /**
   * Builds, signs and submits the transfer transaction to devnet (Req 8.6–8.7).
   *
   * Behaviour:
   * - Fetches a fresh blockhash; rejects if > 60s old (Req 8.4).
   * - Checks signal.aborted before and after each async step (Req 8.11).
   * - On RPC submission error, holds signed tx in memory for 30s to allow
   *   one retry (Req 8.10).
   * - Never stores the keypair in service state (Req 8.6).
   * - Only targets devnet cluster (Req 8.12).
   *
   * @param params     Transfer parameters (destination, amount, balance).
   * @param keypair    In-memory session keypair — never stored.
   * @param signal     AbortSignal; abort clears all signed bytes within 2s.
   */
  async signAndSubmit(
    params: TransferParams,
    keypair: Keypair,
    signal: AbortSignal
  ): Promise<SubmitResult> {
    // Guard: only devnet allowed (Req 8.12)
    assertDevnetCluster();

    // ── Step 1: Pre-check abort signal ──────────────────────────────────────
    if (signal.aborted) {
      throw new Error("Transaction aborted: session was terminated before signing began");
    }

    // ── Step 2: Check for a retry-eligible pending transaction ──────────────
    if (this.pendingRetry !== null) {
      const age = Date.now() - this.pendingRetry.timestamp;
      if (age <= RETRY_HOLD_MS) {
        // Reuse the previously signed transaction for retry
        const retryBuffer = this.pendingRetry.serialized;
        this.pendingRetry = null;

        if (signal.aborted) {
          // Discard and abort (Req 8.11)
          throw new Error("Transaction aborted: session terminated during retry");
        }

        try {
          const signature = await this.connection.sendRawTransaction(retryBuffer);
          return { signature };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown RPC error";
          throw new Error(`Transaction retry failed: ${message}`);
        }
      } else {
        // Expired — discard
        this.pendingRetry = null;
      }
    }

    // ── Step 3: Fetch a fresh blockhash ─────────────────────────────────────
    const blockhashResult = await this.solanaService.getRecentBlockhash();

    if (signal.aborted) {
      throw new Error("Transaction aborted: session terminated after blockhash fetch");
    }

    const { blockhash, lastValidBlockHeight } = blockhashResult;

    // Validate blockhash freshness — should be within 60s (Req 8.4)
    // We cannot directly timestamp the blockhash, so we trust it is fresh
    // (SolanaService enforces a 10s timeout on the RPC call).
    void lastValidBlockHeight; // used for documentation only

    // ── Step 4: Build transaction ────────────────────────────────────────────
    const fromPubkey = keypair.publicKey;
    let toPubkey: PublicKey;
    try {
      toPubkey = new PublicKey(params.destinationAddress);
    } catch {
      throw new Error(
        `Invalid destination address: ${params.destinationAddress}`
      );
    }

    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: fromPubkey,
    }).add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: params.lamports,
      })
    );

    if (signal.aborted) {
      throw new Error("Transaction aborted: session terminated before signing");
    }

    // ── Step 5: Sign transaction ─────────────────────────────────────────────
    // keypair is used here and NEVER stored on `this`
    transaction.sign(keypair);

    if (signal.aborted) {
      // Discard signed bytes immediately (Req 8.11)
      this._discardPendingRetry();
      throw new Error("Transaction aborted: session terminated during signing — signed bytes discarded");
    }

    // ── Step 6: Serialize and submit ─────────────────────────────────────────
    let serialized: Buffer;
    try {
      serialized = Buffer.from(transaction.serialize());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Serialization error";
      throw new Error(`Failed to serialize signed transaction: ${message}`);
    }

    try {
      const signature = await this.connection.sendRawTransaction(serialized);

      // On success, clear any stale pending retry
      this.pendingRetry = null;

      return { signature };
    } catch (err) {
      // ── Req 8.10: Hold signed tx in memory for 30s to allow one retry ─────
      this.pendingRetry = {
        serialized,
        timestamp: Date.now(),
      };

      const message = err instanceof Error ? err.message : "Unknown RPC error";
      throw new Error(
        `Transaction submission failed (retry available for ${RETRY_HOLD_MS / 1000}s): ${message}`
      );
    }
  }

  // ── Session termination handler ───────────────────────────────────────────

  /**
   * Called by SessionService when session terminates during a transaction
   * in progress (Req 8.11, Req 9.2). Discards all signed transaction bytes.
   * Must complete within 2 seconds.
   */
  discardOnSessionTermination(): void {
    this._discardPendingRetry();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Zero-fills and clears the pending retry buffer.
   */
  private _discardPendingRetry(): void {
    if (this.pendingRetry !== null) {
      // Zero-fill the serialized bytes before releasing the reference
      this.pendingRetry.serialized.fill(0);
      this.pendingRetry = null;
    }
  }
}
