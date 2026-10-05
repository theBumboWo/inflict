// test/integration/failure-injection.integration.test.ts
//
// Failure-injection integration tests: configure MockHardwareIdentityProvider
// to surface specific CTAP2 error codes and verify that EnrollmentService and
// DerivationService respond with correctly typed errors.
//
// No real hardware is involved — all assertions are made against the
// deterministic mock.
//
// Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";
import { CtapError } from "../../src/main/hardware/types";
import {
  EnrollmentService,
  EnrollmentError,
} from "../../src/main/enrollment/EnrollmentService";
import {
  DerivationService,
} from "../../src/main/derivation/DerivationService";
import { CredentialStore } from "../../src/main/storage/CredentialStore";
import type { DerivationError } from "../../src/main/derivation/DerivationService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEVICE_PATH = "mock://device/1";

/** Returns a non-aborted AbortSignal. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Failure injection integration tests (Req 17)", () => {
  let tempDir: string;
  let credentialStorePath: string;
  let provider: MockHardwareIdentityProvider;
  let credentialStore: CredentialStore;
  let enrollmentService: EnrollmentService;
  let derivationService: DerivationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keywallet-failure-test-"));
    credentialStorePath = join(tempDir, "credentials.json");

    provider = new MockHardwareIdentityProvider();
    credentialStore = new CredentialStore(credentialStorePath);
    enrollmentService = new EnrollmentService(provider, credentialStore);
    derivationService = new DerivationService(provider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1 — CTAP2_ERR_PIN_BLOCKED from createCredential → EnrollmentError "pin-locked"
  // Validates: Requirement 17.1
  // -------------------------------------------------------------------------
  it("CTAP2_ERR_PIN_BLOCKED from createCredential() → EnrollmentError with category 'pin-locked'", async () => {
    vi.spyOn(provider, "createCredential").mockRejectedValue(
      new CtapError(
        "CTAP2_ERR_PIN_BLOCKED",
        "Device PIN is locked.",
      ),
    );

    await expect(
      enrollmentService.enroll(DEVICE_PATH, "Test Key", liveSignal()),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EnrollmentError);
      expect((err as EnrollmentError).category).toBe("pin-locked");
      return true;
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — CTAP2_ERR_KEY_STORE_FULL from createCredential → EnrollmentError "storage-full"
  // Validates: Requirement 17.2
  // -------------------------------------------------------------------------
  it("CTAP2_ERR_KEY_STORE_FULL from createCredential() → EnrollmentError with category 'storage-full'", async () => {
    vi.spyOn(provider, "createCredential").mockRejectedValue(
      new CtapError(
        "CTAP2_ERR_KEY_STORE_FULL",
        "Credential storage is full.",
      ),
    );

    await expect(
      enrollmentService.enroll(DEVICE_PATH, "Test Key", liveSignal()),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EnrollmentError);
      expect((err as EnrollmentError).category).toBe("storage-full");
      return true;
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — authenticatorAttachment: "platform" from createCredential → EnrollmentError "enrollment-failed"
  // Validates: Requirement 17.3
  // -------------------------------------------------------------------------
  it("authenticatorAttachment 'platform' from createCredential() → EnrollmentError with category 'enrollment-failed'", async () => {
    vi.spyOn(provider, "createCredential").mockResolvedValue({
      credentialId: new Uint8Array(32),
      authenticatorAttachment: "platform",
      publicKeyBytes: new Uint8Array(32),
    });

    await expect(
      enrollmentService.enroll(DEVICE_PATH, "Test Key", liveSignal()),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EnrollmentError);
      expect((err as EnrollmentError).category).toBe("enrollment-failed");
      return true;
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — CTAP2_ERR_OPERATION_DENIED from getAssertion → deriveWallet returns { kind: "authenticator-error" }
  // Validates: Requirement 17.4
  // -------------------------------------------------------------------------
  it("CTAP2_ERR_OPERATION_DENIED from getAssertion() → deriveWallet() returns { kind: 'authenticator-error' }", async () => {
    vi.spyOn(provider, "getAssertion").mockRejectedValue(
      new CtapError(
        "CTAP2_ERR_OPERATION_DENIED",
        "Operation was denied by the authenticator.",
      ),
    );

    const credentialId = new Uint8Array(32).fill(0xaa);
    const result = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal(),
    );

    expect(result).toEqual(
      expect.objectContaining({ kind: "authenticator-error" }),
    );
    expect((result as DerivationError & { kind: "authenticator-error" }).ctapCode).toBe(
      "CTAP2_ERR_OPERATION_DENIED",
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 — AbortSignal aborted mid-call → deriveWallet() returns { kind: "user-cancelled" }
  // Validates: Requirement 17.5
  // -------------------------------------------------------------------------
  it("AbortSignal aborted during getAssertion() → deriveWallet() returns { kind: 'user-cancelled' }", async () => {
    const controller = new AbortController();

    // Make getAssertion() abort the signal and then reject with an AbortError
    // to simulate the signal being triggered mid-call.
    vi.spyOn(provider, "getAssertion").mockImplementation(async () => {
      controller.abort();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    });

    const credentialId = new Uint8Array(32).fill(0xbb);
    const result = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      controller.signal,
    );

    expect(result).toEqual({ kind: "user-cancelled" });
  });
});
