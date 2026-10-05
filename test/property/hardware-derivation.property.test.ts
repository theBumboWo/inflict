// test/property/hardware-derivation.property.test.ts
//
// Property-based tests for the hardware integration layer using fast-check.
// All properties run with numRuns: 100 minimum.
//
// Properties 3, 5 validate Fido2CliHardwareIdentityProvider stdin line order
// by capturing the temp-file content written before the CLI process is spawned.
// Properties 10, 11 validate MockHardwareIdentityProvider-based derivation.

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { EventEmitter } from "events";

// vi.mock declarations must be at the top level (hoisted by Vitest)
vi.mock("fs");
vi.mock("child_process");
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "C:/fake-app-path",
  },
}));

import * as fs from "fs";
import * as childProcess from "child_process";

import { Fido2CliHardwareIdentityProvider } from "../../src/main/hardware/Fido2CliHardwareIdentityProvider";
import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";
import { DerivationService } from "../../src/main/derivation/DerivationService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

const DEVICE_PATH = "mock://device/1";

/** fc arbitrary for a fixed 32-byte Uint8Array (PRF_Output). */
const prfOutputArb = fc.uint8Array({ minLength: 32, maxLength: 32 });

/**
 * Build a fake ChildProcess that immediately emits 'close' with exit code 0
 * and feeds `stdoutContent` as a 'data' event.
 */
function makeFakeProcess(stdoutContent: string): childProcess.ChildProcess {
  const proc = new EventEmitter() as childProcess.ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinObj = {
    write: vi.fn((_data: unknown, _enc: unknown, cb?: () => void) => {
      if (cb) cb();
      return true;
    }),
    end: vi.fn(),
  };

  (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
  (proc as unknown as Record<string, unknown>).stdin = stdinObj;
  (proc as unknown as Record<string, unknown>).kill = vi.fn();

  setImmediate(() => {
    stdoutEmitter.emit("data", Buffer.from(stdoutContent));
    stderrEmitter.emit("data", Buffer.from(""));
    proc.emit("close", 0);
  });

  return proc;
}

/**
 * Valid 6-line fido2-cred stdout.
 * credentialId at index 4 (base64 of 32 bytes of 0xab).
 */
function makeFakeFido2CredStdout(): string {
  return [
    Buffer.from("clientDataHash").toString("base64"),
    "key-wallet.local",
    "packed",
    Buffer.alloc(64, 0x00).toString("base64"), // authData
    Buffer.alloc(32, 0xab).toString("base64"), // credentialId at index 4
    Buffer.from("attestationSig").toString("base64"),
  ].join("\n") + "\n";
}

/**
 * Valid 6-line fido2-assert stdout.
 * hmacSecret at index 5 (base64 of 32 bytes of 0xcd).
 */
function makeFakeFido2AssertStdout(): string {
  return [
    Buffer.from("clientDataHash").toString("base64"),
    "key-wallet.local",
    Buffer.alloc(64, 0x00).toString("base64"), // authData
    Buffer.from("assertionSig").toString("base64"),
    Buffer.from("userId").toString("base64"),
    Buffer.alloc(32, 0xcd).toString("base64"), // hmacSecret at index 5
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Property 3: fido2-cred stdin line order
// Feature: hardware-integration-audit, Property 3: fido2-cred stdin line order
// Validates: Requirements 3.1
// ---------------------------------------------------------------------------
describe("Property 3: fido2-cred stdin line order", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "for any valid EnrollmentOptions, createCredential writes stdin in order [clientData, rpId, userName, userIdBase64]",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            rpId: fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !s.includes("\n")),
            userName: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !s.includes("\n")),
            userId: fc.uint8Array({ minLength: 1, maxLength: 64 }),
          }),
          async ({ rpId, userName, userId }) => {
            // Track stdin content written to the temp file
            let capturedStdinContent: string | null = null;

            const writeFileSyncMock = vi.mocked(fs.writeFileSync);
            writeFileSyncMock.mockImplementation(
              (_path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
                capturedStdinContent =
                  typeof data === "string"
                    ? data
                    : Buffer.from(data as Uint8Array).toString("utf8");
              }
            );

            // existsSync is used by getCliDir path resolution — return true
            vi.mocked(fs.existsSync).mockReturnValue(true);

            // unlinkSync — no-op
            vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

            // Stub childProcess.spawn to avoid actually spawning a process
            vi.mocked(childProcess.spawn).mockReturnValue(
              makeFakeProcess(makeFakeFido2CredStdout()) as ReturnType<
                typeof childProcess.spawn
              >
            );

            const provider = new Fido2CliHardwareIdentityProvider();
            await provider.createCredential("windows://hello", {
              rpId,
              userName,
              userDisplayName: userName,
              userId,
              requireResidentKey: true,
              userVerification: "required",
              authenticatorAttachment: "cross-platform",
            });

            expect(capturedStdinContent).not.toBeNull();

            const stdinLines = (capturedStdinContent as string).split("\n");

            // Line 0: clientData — non-empty base64
            expect(stdinLines[0].length).toBeGreaterThan(0);

            // Line 1: rpId
            expect(stdinLines[1]).toBe(rpId);

            // Line 2: userName (name before id — the bug fix being verified)
            expect(stdinLines[2]).toBe(userName);

            // Line 3: userIdBase64
            const expectedUserIdB64 = Buffer.from(userId).toString("base64");
            expect(stdinLines[3]).toBe(expectedUserIdB64);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 5: fido2-assert stdin line order
// Feature: hardware-integration-audit, Property 5: fido2-assert stdin line order
// Validates: Requirements 4.1
// ---------------------------------------------------------------------------
describe("Property 5: fido2-assert stdin line order", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "for any valid AssertionOptions, getAssertion writes stdin in order [clientData, rpId, credentialIdBase64, hmacSaltBase64]",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            credentialId: fc.uint8Array({ minLength: 1, maxLength: 64 }),
            hmacSalt: fc.uint8Array({ minLength: 32, maxLength: 32 }),
          }),
          async ({ credentialId, hmacSalt }) => {
            let capturedStdinContent: string | null = null;

            vi.mocked(fs.writeFileSync).mockImplementation(
              (_path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
                capturedStdinContent =
                  typeof data === "string"
                    ? data
                    : Buffer.from(data as Uint8Array).toString("utf8");
              }
            );

            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

            vi.mocked(childProcess.spawn).mockReturnValue(
              makeFakeProcess(makeFakeFido2AssertStdout()) as ReturnType<
                typeof childProcess.spawn
              >
            );

            const provider = new Fido2CliHardwareIdentityProvider();
            await provider.getAssertion("windows://hello", {
              rpId: "key-wallet.local",
              credentialId,
              hmacSalt,
              userVerification: "required",
            });

            expect(capturedStdinContent).not.toBeNull();

            const stdinLines = (capturedStdinContent as string).split("\n");

            // Line 0: clientData — non-empty base64
            expect(stdinLines[0].length).toBeGreaterThan(0);

            // Line 1: rpId
            expect(stdinLines[1]).toBe("key-wallet.local");

            // Line 2: credentialIdBase64
            const expectedCredIdB64 = Buffer.from(credentialId).toString("base64");
            expect(stdinLines[2]).toBe(expectedCredIdB64);

            // Line 3: hmacSaltBase64
            const expectedHmacSaltB64 = Buffer.from(hmacSalt).toString("base64");
            expect(stdinLines[3]).toBe(expectedHmacSaltB64);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 10: PRF_Output zeroization
// Feature: hardware-integration-audit, Property 10: PRF_Output zeroization
// Validates: Requirements 9.1, 15.3
// ---------------------------------------------------------------------------
describe("Property 10: PRF_Output zeroization", () => {
  it(
    "after deriveWallet() returns, the hmacOutput held by DerivationService is zeroed",
    async () => {
      await fc.assert(
        fc.asyncProperty(prfOutputArb, async (prfOutput) => {
          const mock = new MockHardwareIdentityProvider();
          const credentialId = new Uint8Array(32).fill(0x01);

          // Seed mock with the generated prfOutput
          mock.setHmacOutput(credentialId, new Uint8Array(prfOutput));

          // Intercept getAssertion to capture the exact Uint8Array instance
          // that DerivationService will hold and later zero in its finally block.
          let capturedHmacOutput: Uint8Array | null = null;
          const originalGetAssertion = mock.getAssertion.bind(mock);
          mock.getAssertion = async (devicePath, options) => {
            const result = await originalGetAssertion(devicePath, options);
            capturedHmacOutput = result.hmacOutput;
            return result;
          };

          const service = new DerivationService(mock);
          await service.deriveWallet(DEVICE_PATH, credentialId, liveSignal());

          // After deriveWallet returns, the finally block must have zeroed
          // the hmacOutput buffer that DerivationService held.
          expect(capturedHmacOutput).not.toBeNull();
          const allZero = (capturedHmacOutput as Uint8Array).every((b) => b === 0);
          expect(allZero).toBe(true);
        }),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 11: MockHardwareIdentityProvider round-trip determinism
// Feature: hardware-integration-audit, Property 11: MockHardwareIdentityProvider round-trip determinism
// Validates: Requirements 15.4, 24.5
// ---------------------------------------------------------------------------
describe("Property 11: MockHardwareIdentityProvider round-trip determinism", () => {
  it(
    "same credentialId on same mock instance returns identical hmacOutput bytes and deriveWallet yields the same address twice",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 64 }),
          async (credentialId) => {
            const mock = new MockHardwareIdentityProvider();
            const service = new DerivationService(mock);

            // First getAssertion call
            const result1 = await mock.getAssertion(DEVICE_PATH, {
              rpId: "key-wallet.local",
              credentialId,
              hmacSalt: new Uint8Array(32),
              userVerification: "required",
            });

            // Second getAssertion call — must return the same hmacOutput bytes
            const result2 = await mock.getAssertion(DEVICE_PATH, {
              rpId: "key-wallet.local",
              credentialId,
              hmacSalt: new Uint8Array(32),
              userVerification: "required",
            });

            // Byte-for-byte equality
            expect(result1.hmacOutput.length).toBe(result2.hmacOutput.length);
            for (let i = 0; i < result1.hmacOutput.length; i++) {
              expect(result1.hmacOutput[i]).toBe(result2.hmacOutput[i]);
            }

            // Apply deriveWallet twice with the same credentialId on the same mock.
            // Each call gets a fresh deterministic hmacOutput from the mock cache.
            const derivation1 = await service.deriveWallet(
              DEVICE_PATH,
              credentialId,
              liveSignal()
            );
            const derivation2 = await service.deriveWallet(
              DEVICE_PATH,
              credentialId,
              liveSignal()
            );

            // Both must succeed and produce the same wallet address
            expect("walletAddress" in derivation1).toBe(true);
            expect("walletAddress" in derivation2).toBe(true);

            const addr1 = (derivation1 as { walletAddress: string }).walletAddress;
            const addr2 = (derivation2 as { walletAddress: string }).walletAddress;

            expect(addr1).toBe(addr2);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
