// test/property/derivation.property.test.ts
//
// Property-based tests for DerivationService using fast-check.
// Validates: Requirements 18.1, 18.2, 18.3, 18.7

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { DerivationService } from "../../src/main/derivation/DerivationService";
import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a non-aborted AbortSignal. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

const DEVICE_PATH = "mock://device/1";

/** Arbitrary for a fixed 32-byte Uint8Array (PRF_Output). */
const prfOutputArb = fc.uint8Array({ minLength: 32, maxLength: 32 });

/**
 * Helper: run deriveWallet with a mock seeded to return `prfOutput` for the
 * generated `credentialId`.  Returns `{ mock, service, credentialId, result }`.
 */
async function deriveFromPrfOutput(prfOutput: Uint8Array) {
  const mock = new MockHardwareIdentityProvider();
  // Use a fixed credentialId (all-zero) so the mock can be seeded.
  const credentialId = new Uint8Array(32).fill(0x00);
  mock.setHmacOutput(credentialId, new Uint8Array(prfOutput));

  const service = new DerivationService(mock);
  const result = await service.deriveWallet(DEVICE_PATH, credentialId, liveSignal());
  return { mock, service, credentialId, result };
}

// ---------------------------------------------------------------------------
// Property 1: Derivation Determinism
// Feature: key-wallet, Property 1: Derivation Determinism
// Validates: Requirements 18.1
// Also validates: hardware-integration-audit Requirements 8.1, 15.1
// ---------------------------------------------------------------------------
describe("Property 1: Derivation Determinism", () => {
  it("for any fixed 32-byte PRF_Output, deriveWallet called twice returns the same walletAddress", async () => {
    await fc.assert(
      fc.asyncProperty(prfOutputArb, async (prfOutput) => {
        // First call
        const { result: result1 } = await deriveFromPrfOutput(prfOutput);
        // Second call with the same prfOutput
        const { result: result2 } = await deriveFromPrfOutput(prfOutput);

        expect("walletAddress" in result1).toBe(true);
        expect("walletAddress" in result2).toBe(true);

        const addr1 = (result1 as { walletAddress: string }).walletAddress;
        const addr2 = (result2 as { walletAddress: string }).walletAddress;

        expect(addr1).toBe(addr2);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Derivation Injectivity
// Feature: key-wallet, Property 2: Derivation Injectivity
// Validates: Requirements 18.2
// Also validates: hardware-integration-audit Requirements 8.4, 15.2
// ---------------------------------------------------------------------------
describe("Property 2: Derivation Injectivity", () => {
  it("for any two distinct 32-byte PRF_Output arrays a ≠ b, derived walletAddress values must differ", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(prfOutputArb, prfOutputArb)
          .filter(([a, b]) => !Buffer.from(a).equals(Buffer.from(b))),
        async ([a, b]) => {
          const { result: resultA } = await deriveFromPrfOutput(a);
          const { result: resultB } = await deriveFromPrfOutput(b);

          expect("walletAddress" in resultA).toBe(true);
          expect("walletAddress" in resultB).toBe(true);

          const addrA = (resultA as { walletAddress: string }).walletAddress;
          const addrB = (resultB as { walletAddress: string }).walletAddress;

          expect(addrA).not.toBe(addrB);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: HKDF Output is a Valid Ed25519 Seed
// Feature: key-wallet, Property 3: HKDF Output is a Valid Ed25519 Seed
// Validates: Requirements 18.3
// ---------------------------------------------------------------------------
describe("Property 3: HKDF Output is a Valid Ed25519 Seed", () => {
  it("for any 32-byte PRF_Output, the derivation chain produces a keypair via Keypair.fromSeed() without throwing", async () => {
    await fc.assert(
      fc.asyncProperty(prfOutputArb, async (prfOutput) => {
        const { result } = await deriveFromPrfOutput(prfOutput);

        // If the result has a walletAddress, Keypair.fromSeed() did not throw.
        expect("walletAddress" in result).toBe(true);

        const walletAddress = (result as { walletAddress: string }).walletAddress;
        // walletAddress is a Base58 string — 32–44 chars for a 32-byte Ed25519 pubkey.
        expect(typeof walletAddress).toBe("string");
        expect(walletAddress.length).toBeGreaterThanOrEqual(32);
        expect(walletAddress.length).toBeLessThanOrEqual(44);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: No Secret Material in Derivation Output Logs
// Feature: key-wallet, Property 7: No Secret Material in Derivation Output Logs
// Validates: Requirements 18.7
// ---------------------------------------------------------------------------
describe("Property 7: No Secret Material in Derivation Output Logs", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("after a complete derivation call, no console method is called with the hex-encoded PRF_Output", async () => {
    await fc.assert(
      fc.asyncProperty(prfOutputArb, async (prfOutput) => {
        // Reset call history before each run so previous iterations don't bleed.
        vi.mocked(console.log).mockClear();
        vi.mocked(console.info).mockClear();
        vi.mocked(console.error).mockClear();
        vi.mocked(console.debug).mockClear();
        vi.mocked(console.warn).mockClear();

        await deriveFromPrfOutput(prfOutput);

        const hexPrfOutput = Buffer.from(prfOutput).toString("hex");

        // Collect all arguments from every intercepted console call.
        const allLoggedStrings: string[] = [
          ...vi.mocked(console.log).mock.calls,
          ...vi.mocked(console.info).mock.calls,
          ...vi.mocked(console.error).mock.calls,
          ...vi.mocked(console.debug).mock.calls,
          ...vi.mocked(console.warn).mock.calls,
        ]
          .flat()
          .map((arg) => {
            if (typeof arg === "string") return arg;
            if (arg instanceof Uint8Array || Buffer.isBuffer(arg)) {
              return Buffer.from(arg).toString("hex");
            }
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          });

        // Assert the hex-encoded PRF_Output does not appear in any log entry.
        for (const logged of allLoggedStrings) {
          expect(logged).not.toContain(hexPrfOutput);
        }
      }),
      { numRuns: 100 }
    );
  });
});
