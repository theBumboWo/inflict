// test/integration/enrollment-derivation.integration.test.ts
//
// Integration tests for the enrollment → derivation flow using only
// mock/in-memory components — no real hardware, no file I/O.
//
// Feature: hardware-integration-audit
// Validates: Requirements 16.1, 16.2, 16.3, 16.4

import { describe, it, expect, beforeEach } from "vitest";

import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";
import { EnrollmentService } from "../../src/main/enrollment/EnrollmentService";
import { DerivationService } from "../../src/main/derivation/DerivationService";
import type {
  ICredentialStore,
  StoredCredentialMetadata,
} from "../../src/main/storage/CredentialStore";
import type { DerivationResult } from "../../src/main/derivation/DerivationService";

// ---------------------------------------------------------------------------
// In-memory credential store (no disk I/O required for these tests)
// ---------------------------------------------------------------------------

class InMemoryCredentialStore implements ICredentialStore {
  private readonly _records: StoredCredentialMetadata[] = [];

  async save(meta: StoredCredentialMetadata): Promise<void> {
    this._records.push(meta);
  }

  async findAll(): Promise<StoredCredentialMetadata[]> {
    return [...this._records];
  }

  async delete(credentialId: string): Promise<void> {
    const idx = this._records.findIndex((m) => m.credentialId === credentialId);
    if (idx !== -1) {
      this._records.splice(idx, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEVICE_PATH = "mock://device/1";

/** Returns a non-aborted AbortSignal. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Type guard: narrows DerivationResult vs DerivationError. */
function isDerivationResult(result: unknown): result is DerivationResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "keypair" in result &&
    "walletAddress" in result
  );
}

/** Base58 character set (Solana wallet addresses). */
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Enrollment → Derivation integration (Req 16)", () => {
  let provider: MockHardwareIdentityProvider;
  let store: InMemoryCredentialStore;
  let enrollmentService: EnrollmentService;
  let derivationService: DerivationService;

  beforeEach(() => {
    provider = new MockHardwareIdentityProvider();
    store = new InMemoryCredentialStore();
    enrollmentService = new EnrollmentService(provider, store);
    derivationService = new DerivationService(provider);
  });

  // -------------------------------------------------------------------------
  // Test 1 — Req 16.1
  // -------------------------------------------------------------------------
  it("enroll() then deriveWallet() returns a non-null Base58 wallet address", async () => {
    // Enroll to obtain a credential ID
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "My YubiKey",
      liveSignal()
    );

    expect(credentialId).toBeInstanceOf(Uint8Array);
    expect(credentialId.byteLength).toBe(32);

    // Derive wallet from the enrolled credential
    const result = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );

    // Must be a DerivationResult (not an error)
    expect(isDerivationResult(result)).toBe(true);
    if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

    // walletAddress must be a non-empty Base58 string
    expect(typeof result.walletAddress).toBe("string");
    expect(result.walletAddress.length).toBeGreaterThan(0);
    expect(result.walletAddress).toMatch(BASE58_REGEX);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Req 16.2
  // -------------------------------------------------------------------------
  it("same credentialId on same mock instance → identical wallet address on both calls", async () => {
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "Determinism Key",
      liveSignal()
    );

    const result1 = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );
    const result2 = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );

    expect(isDerivationResult(result1)).toBe(true);
    expect(isDerivationResult(result2)).toBe(true);

    if (!isDerivationResult(result1) || !isDerivationResult(result2)) {
      throw new Error("Expected DerivationResult for both calls");
    }

    // Both calls with the same credentialId must yield the same address
    expect(result1.walletAddress).toBe(result2.walletAddress);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Req 16.3
  // -------------------------------------------------------------------------
  it("two different credentialIds on same mock instance → different wallet addresses", async () => {
    const enrollA = await enrollmentService.enroll(
      DEVICE_PATH,
      "Key A",
      liveSignal()
    );
    const enrollB = await enrollmentService.enroll(
      DEVICE_PATH,
      "Key B",
      liveSignal()
    );

    // The two enrollments must have produced distinct credential IDs
    expect(
      Buffer.from(enrollA.credentialId).toString("hex")
    ).not.toBe(
      Buffer.from(enrollB.credentialId).toString("hex")
    );

    const resultA = await derivationService.deriveWallet(
      DEVICE_PATH,
      enrollA.credentialId,
      liveSignal()
    );
    const resultB = await derivationService.deriveWallet(
      DEVICE_PATH,
      enrollB.credentialId,
      liveSignal()
    );

    expect(isDerivationResult(resultA)).toBe(true);
    expect(isDerivationResult(resultB)).toBe(true);

    if (!isDerivationResult(resultA) || !isDerivationResult(resultB)) {
      throw new Error("Expected DerivationResults for both enrollments");
    }

    // Different credential IDs must produce different wallet addresses
    expect(resultA.walletAddress).not.toBe(resultB.walletAddress);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Req 16.4
  // -------------------------------------------------------------------------
  it("AbortSignal aborted before getAssertion → deriveWallet() returns { kind: 'user-cancelled' }", async () => {
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "Abort Test Key",
      liveSignal()
    );

    // Abort the controller before calling deriveWallet
    const controller = new AbortController();
    controller.abort();

    const result = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      controller.signal
    );

    // Must return the user-cancelled discriminant
    expect(result).toEqual({ kind: "user-cancelled" });
  });
});
