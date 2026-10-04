// test/unit/DerivationService.test.ts
//
// Unit tests for DerivationService — Validates: Requirements 4

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hkdfSync } from "node:crypto";

// vi.mock must be declared before the imports that reference the mocked module.
// We wrap the real `hkdf` implementation with a spy so we can assert on call
// arguments while still getting valid derivation output.
vi.mock("../../src/main/derivation/hkdf", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/main/derivation/hkdf")>();
  return {
    ...original,
    hkdf: vi.fn(original.hkdf),
  };
});

import { DerivationService } from "../../src/main/derivation/DerivationService";
import { MockHardwareIdentityProvider } from "../../test/mocks/MockHardwareIdentityProvider";
import { hkdf, PRF_SALT_CONSTANT } from "../../src/main/derivation/hkdf";
import { CtapError } from "../../src/main/hardware/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a non-aborted AbortSignal (backed by a never-aborted controller). */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Returns an already-aborted AbortSignal. */
function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const DEVICE_PATH = "mock://device/1";

/** Convenience: run deriveWallet with a live signal and a given credentialId. */
async function deriveWith(
  service: DerivationService,
  credentialId: Uint8Array
) {
  return service.deriveWallet(DEVICE_PATH, credentialId, liveSignal());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DerivationService", () => {
  // Reset vi.fn call history before each test so spies don't bleed.
  beforeEach(() => {
    vi.mocked(hkdf).mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. Determinism — same credentialId produces same walletAddress (Req 4.9)
  // -------------------------------------------------------------------------
  it("produces the same walletAddress for the same credentialId across two fresh instances", async () => {
    const credentialId = new Uint8Array(32).fill(0xab);

    const mock1 = new MockHardwareIdentityProvider();
    const service1 = new DerivationService(mock1);

    const mock2 = new MockHardwareIdentityProvider();
    const service2 = new DerivationService(mock2);

    const result1 = await deriveWith(service1, credentialId);
    const result2 = await deriveWith(service2, credentialId);

    // Both results must be successful (DerivationResult)
    expect("walletAddress" in result1).toBe(true);
    expect("walletAddress" in result2).toBe(true);

    const addr1 = (result1 as { walletAddress: string }).walletAddress;
    const addr2 = (result2 as { walletAddress: string }).walletAddress;

    expect(addr1).toBe(addr2);
  });

  // -------------------------------------------------------------------------
  // 2. HKDF info string — Step 2 uses "key-wallet:solana:ed25519:v1" (Req 4.3)
  // -------------------------------------------------------------------------
  it('calls hkdf with info = Buffer.from("key-wallet:solana:ed25519:v1") in Step 2', async () => {
    const credentialId = new Uint8Array(32).fill(0x01);
    const mock = new MockHardwareIdentityProvider();
    const service = new DerivationService(mock);

    const result = await deriveWith(service, credentialId);

    // Derivation must succeed so we can be sure hkdf was called
    expect("walletAddress" in result).toBe(true);

    // hkdf should have been called exactly once (Step 2)
    const hkdfMock = vi.mocked(hkdf);
    expect(hkdfMock).toHaveBeenCalledOnce();

    // Extract the actual `info` argument (3rd positional arg, 0-indexed = index 2)
    const [_ikm, _salt, infoArg] = hkdfMock.mock.calls[0];

    const expectedInfo = Buffer.from("key-wallet:solana:ed25519:v1", "utf8");
    expect(Buffer.from(infoArg)).toEqual(expectedInfo);
  });

  // -------------------------------------------------------------------------
  // 3. Zero-overwrite — PRF_Output is zeroed after successful derivation (Req 4.5)
  // -------------------------------------------------------------------------
  it("zero-overwrites the hmacOutput buffer after successful derivation", async () => {
    const credentialId = new Uint8Array(32).fill(0x02);

    // Create a known hmacOutput buffer whose reference we keep.
    const knownHmacOutput = new Uint8Array(32).fill(0xff);

    const mock = new MockHardwareIdentityProvider();
    // Pin the buffer so getAssertion derives from this exact value.
    mock.setHmacOutput(credentialId, knownHmacOutput);

    // Intercept what the mock returns so we can check it gets zeroed.
    // The mock now returns a copy of the cached buffer — capture that copy.
    let capturedHmacOutput: Uint8Array | undefined;
    const origGetAssertion = mock.getAssertion.bind(mock);
    vi.spyOn(mock, "getAssertion").mockImplementationOnce(async (...args) => {
      const result = await origGetAssertion(...args);
      capturedHmacOutput = result.hmacOutput;
      return result;
    });

    const service = new DerivationService(mock);
    const result = await deriveWith(service, credentialId);

    expect("walletAddress" in result).toBe(true);

    // The DerivationService must have called fill(0) on the returned buffer.
    expect(capturedHmacOutput).toBeDefined();
    expect(capturedHmacOutput!.every((b) => b === 0)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Zero-overwrite on error — PRF_Output is zeroed even when an error is thrown
  //    after hmacOutput is set (Req 4.5, 4.6)
  // -------------------------------------------------------------------------
  it("zero-overwrites the hmacOutput buffer even when an error is thrown after the PRF step", async () => {
    const credentialId = new Uint8Array(32).fill(0x03);
    const knownHmacOutput = new Uint8Array(32).fill(0xdd);

    // A mock that returns the pinned buffer from getAssertion but then causes
    // hkdf to throw — simulating an unexpected key-derivation failure.
    const mock = new MockHardwareIdentityProvider();
    mock.setHmacOutput(credentialId, knownHmacOutput);

    // Intercept what the mock returns so we can check it gets zeroed.
    let capturedHmacOutput: Uint8Array | undefined;
    const origGetAssertion = mock.getAssertion.bind(mock);
    vi.spyOn(mock, "getAssertion").mockImplementationOnce(async (...args) => {
      const result = await origGetAssertion(...args);
      capturedHmacOutput = result.hmacOutput;
      return result;
    });

    // Override hkdf to throw after the assertion step completes.
    // This simulates a hardware/crypto error after PRF_Output has been received.
    vi.mocked(hkdf).mockImplementationOnce(() => {
      throw new Error("Simulated HKDF failure");
    });

    const service = new DerivationService(mock);

    // The service propagates the unexpected HKDF error (the outer try block has
    // no catch for this case), but the finally block still runs and zeroes the
    // sensitive buffers before the rejection propagates.
    await expect(deriveWith(service, credentialId)).rejects.toThrow(
      "Simulated HKDF failure"
    );

    // The PRF_Output buffer must have been zeroed by the finally block.
    expect(capturedHmacOutput).toBeDefined();
    expect(capturedHmacOutput!.every((b) => b === 0)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. User-cancel — already-aborted signal returns { kind: "user-cancelled" }
  //    (Req 4.6)
  // -------------------------------------------------------------------------
  it('returns { kind: "user-cancelled" } when the AbortSignal is already aborted', async () => {
    const credentialId = new Uint8Array(32).fill(0x04);
    const mock = new MockHardwareIdentityProvider();
    const service = new DerivationService(mock);

    const result = await service.deriveWallet(
      DEVICE_PATH,
      credentialId,
      abortedSignal()
    );

    expect(result).toEqual({ kind: "user-cancelled" });
  });

  // -------------------------------------------------------------------------
  // 6. Different credentialIds produce different walletAddresses (Req 4.8)
  // -------------------------------------------------------------------------
  it("produces different walletAddresses for two different credentialIds", async () => {
    const credentialId1 = new Uint8Array(32).fill(0x10);
    const credentialId2 = new Uint8Array(32).fill(0x20);

    const mock = new MockHardwareIdentityProvider();
    const service = new DerivationService(mock);

    const result1 = await deriveWith(service, credentialId1);
    const result2 = await deriveWith(service, credentialId2);

    expect("walletAddress" in result1).toBe(true);
    expect("walletAddress" in result2).toBe(true);

    const addr1 = (result1 as { walletAddress: string }).walletAddress;
    const addr2 = (result2 as { walletAddress: string }).walletAddress;

    expect(addr1).not.toBe(addr2);
  });
});
