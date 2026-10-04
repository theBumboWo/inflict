// test/property/transaction.property.test.ts
//
// Property-based tests for TransactionService using fast-check.
// Validates: Requirements 18.4, 18.5, 8.2

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import bs58 from "bs58";
import {
  Transaction,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  TransactionService,
  type TransactionValidationError,
} from "../../src/main/transaction/TransactionService";
import type { ISolanaService } from "../../src/main/solana/SolanaService";
import type { TransferParams } from "../../src/shared/ipc-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal ISolanaService stub — only getRecentBlockhash is used in these tests.
 * All other methods throw immediately if accidentally called.
 */
function makeSolanaStub(blockhash = "11111111111111111111111111111111"): ISolanaService {
  return {
    getBalance: () => { throw new Error("unexpected call to getBalance"); },
    getRecentTransactions: () => { throw new Error("unexpected call to getRecentTransactions"); },
    getRecentBlockhash: async () => ({ blockhash, lastValidBlockHeight: 9999 }),
    startPeriodicRefresh: () => { throw new Error("unexpected call to startPeriodicRefresh"); },
    stopPeriodicRefresh: () => { throw new Error("unexpected call to stopPeriodicRefresh"); },
  } as unknown as ISolanaService;
}

/** Arbitrary: generates a valid 32-byte address encoded as Base58. */
const validAddressArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bs) => bs58.encode(Buffer.from(bs)));

/** Arbitrary: generates a valid-looking blockhash (32 bytes, Base58-encoded). */
const blockhashArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bs) => bs58.encode(Buffer.from(bs)));

// ---------------------------------------------------------------------------
// Property 4: Transaction Serialization Round-Trip
// Feature: key-wallet, Property 4: Transaction Serialization Round-Trip
// Validates: Requirements 18.4
// ---------------------------------------------------------------------------

describe("Property 4: Transaction Serialization Round-Trip", () => {
  it(
    "for any valid (destinationAddress, lamports, feePayer, blockhash), " +
      "serializing and deserializing an unsigned transaction produces equal " +
      "programId, account keys, and instruction data",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          validAddressArb,           // destination address
          validAddressArb,           // feePayer public key (as Base58)
          fc.bigInt({ min: 1n, max: 1_000_000_000n }), // lamports
          blockhashArb,              // recent blockhash
          async (destinationAddress, feePayerAddress, lamports, blockhash) => {
            const fromPubkey = new PublicKey(feePayerAddress);
            const toPubkey = new PublicKey(destinationAddress);

            // Build the unsigned transaction
            const tx = new Transaction({
              recentBlockhash: blockhash,
              feePayer: fromPubkey,
            }).add(
              SystemProgram.transfer({
                fromPubkey,
                toPubkey,
                lamports,
              })
            );

            // Serialize without requiring signatures (unsigned)
            const serialized = tx.serialize({ requireAllSignatures: false });

            // Deserialize back
            const deserialized = Transaction.from(serialized);

            // Field-by-field comparison of instructions
            expect(deserialized.instructions.length).toBe(tx.instructions.length);

            const origInstr = tx.instructions[0];
            const destrInstr = deserialized.instructions[0];

            // Program ID equality
            expect(destrInstr.programId.toBase58()).toBe(
              origInstr.programId.toBase58()
            );

            // Account keys equality (order and address)
            expect(destrInstr.keys.length).toBe(origInstr.keys.length);
            for (let i = 0; i < origInstr.keys.length; i++) {
              expect(destrInstr.keys[i].pubkey.toBase58()).toBe(
                origInstr.keys[i].pubkey.toBase58()
              );
            }

            // Instruction data equality (byte-by-byte)
            expect(Buffer.from(destrInstr.data).toString("hex")).toBe(
              Buffer.from(origInstr.data).toString("hex")
            );
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 5: Transaction Amount Invariant
// Feature: key-wallet, Property 5: Transaction Amount Invariant
// Validates: Requirements 18.5
// ---------------------------------------------------------------------------

describe("Property 5: Transaction Amount Invariant", () => {
  it(
    "for any valid lamports in [1, balance - fee], validateTransferParams returns null",
    async () => {
      const service = new TransactionService(makeSolanaStub());

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 10_000_000_000n }), // currentBalanceLamports
          fc.bigInt({ min: 5000n, max: 5000n }),          // estimatedFee (fixed at 5000)
          fc.nat({ max: 1000 }).map(BigInt),              // offset (ensures amount < max)
          validAddressArb,                                 // destination
          async (balance, fee, offset, destinationAddress) => {
            // Compute a valid amount: balance - fee - offset
            const amount = balance - fee - offset;

            // Precondition: amount must be ≥ 1 lamport
            fc.pre(amount >= 1n);

            const params: TransferParams = {
              destinationAddress,
              lamports: amount,
              currentBalanceLamports: balance,
            };

            const result = service.validateTransferParams(params);

            // Must return null (no validation error) for valid amounts
            expect(result).toBeNull();

            // The amount must be positive
            expect(amount).toBeGreaterThan(0n);

            // The amount must not exceed balance - fee
            expect(amount).toBeLessThanOrEqual(balance - fee);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 6: Address Validation Completeness
// Feature: key-wallet, Property 6: Address Validation Completeness
// Validates: Requirements 8.2
// ---------------------------------------------------------------------------

/**
 * Local helper that checks only the destination field of validateTransferParams.
 * Uses a known-valid amount and high-enough balance so amount validation never fires.
 */
function validateDestinationAddress(
  service: TransactionService,
  addr: string
): boolean {
  const result: TransactionValidationError | null = service.validateTransferParams({
    destinationAddress: addr,
    lamports: 1n,
    currentBalanceLamports: 1_000_000_000n,
  });
  // If result is null or the error field is NOT "destination", the address is valid
  return result === null || result.field !== "destination";
}

describe("Property 6: Address Validation Completeness", () => {
  const service = new TransactionService(makeSolanaStub());

  it(
    "any valid 32-byte public key encoded as Base58 passes address validation",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          async (bytes) => {
            const addr = bs58.encode(Buffer.from(bytes));
            expect(validateDestinationAddress(service, addr)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  it(
    "any byte array of length ≠ 32 encoded as Base58 fails address validation",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .uint8Array({ minLength: 1, maxLength: 64 })
            .filter((b) => b.length !== 32),
          async (bytes) => {
            const addr = bs58.encode(Buffer.from(bytes));
            expect(validateDestinationAddress(service, addr)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  it(
    "any non-Base58 string fails address validation",
    async () => {
      // Non-Base58 strings contain characters like 0, O, I, l, or special chars
      await fc.assert(
        fc.asyncProperty(
          // Generate strings with characters outside the Base58 alphabet
          fc.string({ minLength: 32, maxLength: 44 }).filter((s) => {
            // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
            const base58Alphabet = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
            return !base58Alphabet.test(s);
          }),
          async (addr) => {
            expect(validateDestinationAddress(service, addr)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
