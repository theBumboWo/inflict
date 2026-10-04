// test/integration/e2e-smoke.test.ts
//
// End-to-end smoke test exercising the full main-process service stack wired
// together using MockHardwareIdentityProvider — no real hardware, no real network.
//
// Services under test (wired exactly as in the real main process):
//   DeviceMonitor → EnrollmentService → CredentialStore
//   DerivationService → SessionService
//   SolanaService (Connection mocked) → TransactionService
//
// Validates: End-to-end integration of all main-process services

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock @solana/web3.js Connection for all network calls ────────────────────
// Both SolanaService and TransactionService instantiate `new Connection()` at
// construction time, so we must mock the module before importing those services.
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();

  const mockGetLatestBlockhash = vi.fn().mockResolvedValue({
    blockhash: "FakeBlockhash1111111111111111111111111111111",
    lastValidBlockHeight: 999999,
  });

  const mockGetBalance = vi.fn().mockResolvedValue(100_000_000); // 0.1 SOL
  const mockGetSignaturesForAddress = vi.fn().mockResolvedValue([]);
  const mockSendRawTransaction = vi
    .fn()
    .mockResolvedValue(
      "5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q5J5Q"
    );

  class MockConnection {
    getLatestBlockhash = mockGetLatestBlockhash;
    getBalance = mockGetBalance;
    getSignaturesForAddress = mockGetSignaturesForAddress;
    sendRawTransaction = mockSendRawTransaction;
  }

  return {
    ...actual,
    Connection: MockConnection,
    // Expose mock handles so tests can inspect / reset them
    __mockGetLatestBlockhash: mockGetLatestBlockhash,
    __mockGetBalance: mockGetBalance,
    __mockSendRawTransaction: mockSendRawTransaction,
  };
});

// ── Service imports (after mock) ─────────────────────────────────────────────
import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";
import { DeviceMonitor } from "../../src/main/device/DeviceMonitor";
import { EnrollmentService } from "../../src/main/enrollment/EnrollmentService";
import { DerivationService } from "../../src/main/derivation/DerivationService";
import { SessionService } from "../../src/main/session/SessionService";
import { SolanaService } from "../../src/main/solana/SolanaService";
import { TransactionService } from "../../src/main/transaction/TransactionService";
import { CredentialStore } from "../../src/main/storage/CredentialStore";
import type { DeviceEvent } from "../../src/main/device/DeviceMonitor";
import type { DerivationResult } from "../../src/main/derivation/DerivationService";
import type { TransferParams } from "../../src/main/transaction/TransactionService";
import type { DeviceInfo } from "../../src/main/hardware/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEVICE_PATH = "mock://device/1";

const MOCK_DEVICE_INFO: DeviceInfo = {
  devicePath: DEVICE_PATH,
  supportsHmacSecret: true,
  supportsResidentKey: true,
  extensions: ["hmac-secret"],
};

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

function isDerivationResult(r: unknown): r is DerivationResult {
  return (
    typeof r === "object" &&
    r !== null &&
    "keypair" in r &&
    "walletAddress" in r
  );
}

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

// ── Suite ────────────────────────────────────────────────────────────────────

describe("E2E smoke — full main-process service stack", () => {
  let tempDir: string;
  let credentialStorePath: string;

  // Services
  let provider: MockHardwareIdentityProvider;
  let credentialStore: CredentialStore;
  let deviceMonitor: DeviceMonitor;
  let enrollmentService: EnrollmentService;
  let derivationService: DerivationService;
  let sessionService: SessionService;
  let solanaService: SolanaService;
  let transactionService: TransactionService;

  beforeEach(() => {
    // Fresh isolated temp directory per test
    tempDir = mkdtempSync(join(tmpdir(), "keywallet-e2e-"));
    credentialStorePath = join(tempDir, "credentials.json");

    // Wire services exactly as main process would
    provider = new MockHardwareIdentityProvider();
    credentialStore = new CredentialStore(credentialStorePath);
    deviceMonitor = new DeviceMonitor(
      provider,
      () => sessionService.isSessionActive()
    );
    enrollmentService = new EnrollmentService(provider, credentialStore);
    derivationService = new DerivationService(provider);
    sessionService = new SessionService();
    solanaService = new SolanaService();
    transactionService = new TransactionService(solanaService);
  });

  afterEach(() => {
    deviceMonitor.stop();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 1: Device detection flow
  // DeviceMonitor polls and emits device-connected when a device appears
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 1: DeviceMonitor emits device-connected when mock device appears", async () => {
    vi.useFakeTimers();

    vi.spyOn(provider, "listDevices").mockResolvedValue([MOCK_DEVICE_INFO]);

    const connectedEvents: DeviceEvent[] = [];
    deviceMonitor.on("device-connected", (e) => connectedEvents.push(e));

    deviceMonitor.start();

    // Advance past 500ms poll interval
    await vi.advanceTimersByTimeAsync(600);

    expect(connectedEvents).toHaveLength(1);
    const evt = connectedEvents[0] as Extract<
      DeviceEvent,
      { type: "device-connected" }
    >;
    expect(evt.type).toBe("device-connected");
    expect(evt.devicePath).toBe(DEVICE_PATH);
    expect(evt.info.supportsHmacSecret).toBe(true);

    vi.useRealTimers();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2: Full enrollment flow
  // Enroll → CredentialStore persists metadata → DerivationService derives
  // wallet → SessionService creates session
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 2: Full enrollment flow — enroll, persist metadata, derive wallet, create session", async () => {
    // Step 1: Enroll — creates credential and stores metadata
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "My YubiKey",
      liveSignal()
    );

    expect(credentialId).toBeInstanceOf(Uint8Array);
    expect(credentialId.byteLength).toBe(32);

    // Step 2: Verify CredentialStore saved metadata
    const allCredentials = await credentialStore.findAll();
    expect(allCredentials).toHaveLength(1);
    expect(allCredentials[0].displayName).toBe("My YubiKey");
    expect(allCredentials[0].rpId).toBe("key-wallet.local");
    expect(typeof allCredentials[0].credentialId).toBe("string");
    expect(allCredentials[0].credentialId).toBe(
      Buffer.from(credentialId).toString("hex")
    );

    // Step 3: Derive wallet using credentialId
    const derivationResult = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );

    expect(isDerivationResult(derivationResult)).toBe(true);
    if (!isDerivationResult(derivationResult)) throw new Error("Expected DerivationResult");

    expect(derivationResult.walletAddress).toMatch(BASE58_REGEX);
    expect(derivationResult.walletAddress.length).toBeGreaterThanOrEqual(32);
    expect(derivationResult.walletAddress.length).toBeLessThanOrEqual(44);

    // Step 4: Create session
    const session = sessionService.createSession(
      DEVICE_PATH,
      credentialId,
      "My YubiKey",
      derivationResult.keypair
    );

    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(session.walletAddress).toBe(derivationResult.walletAddress);
    expect(session.displayName).toBe("My YubiKey");
    expect(session.devicePath).toBe(DEVICE_PATH);
    expect(sessionService.isSessionActive()).toBe(true);

    // Cleanup
    sessionService.terminateSession(session.sessionId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 3: Credential rediscovery flow
  // On second "connection", discover existing credential from CredentialStore,
  // derive wallet, create session — and verify it yields the same wallet address
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 3: Credential rediscovery — existing credential is found and re-derives same wallet", async () => {
    // First enrollment
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "Returning Key",
      liveSignal()
    );

    const firstResult = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );
    expect(isDerivationResult(firstResult)).toBe(true);
    if (!isDerivationResult(firstResult)) throw new Error("Expected DerivationResult");
    const firstWalletAddress = firstResult.walletAddress;

    // Terminate any live session
    const firstSession = sessionService.createSession(
      DEVICE_PATH,
      credentialId,
      "Returning Key",
      firstResult.keypair
    );
    sessionService.terminateSession(firstSession.sessionId);

    // Simulate: on second connection, discover credential from store
    const stored = await credentialStore.findAll();
    expect(stored).toHaveLength(1);

    // Re-derive using the stored credentialId hex → Uint8Array
    const rediscoveredCredentialId = Buffer.from(stored[0].credentialId, "hex");

    const secondResult = await derivationService.deriveWallet(
      DEVICE_PATH,
      rediscoveredCredentialId,
      liveSignal()
    );
    expect(isDerivationResult(secondResult)).toBe(true);
    if (!isDerivationResult(secondResult)) throw new Error("Expected DerivationResult");

    // Must produce the same wallet address (deterministic derivation)
    expect(secondResult.walletAddress).toBe(firstWalletAddress);

    // Create new session with rediscovered credential
    const newSession = sessionService.createSession(
      DEVICE_PATH,
      rediscoveredCredentialId,
      stored[0].displayName,
      secondResult.keypair
    );

    expect(newSession.walletAddress).toBe(firstWalletAddress);
    expect(sessionService.isSessionActive()).toBe(true);

    // Cleanup
    sessionService.terminateSession(newSession.sessionId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 4: Transaction validation flow
  // TransactionService.validateTransferParams rejects invalid inputs and
  // accepts valid ones
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 4: Transaction validation — rejects invalid inputs, accepts valid ones", async () => {
    // Invalid: address too short
    const tooShortAddress: TransferParams = {
      destinationAddress: "short",
      lamports: BigInt(1_000_000),
      currentBalanceLamports: BigInt(10_000_000),
    };
    const shortErr = transactionService.validateTransferParams(tooShortAddress);
    expect(shortErr).not.toBeNull();
    expect(shortErr!.field).toBe("destination");

    // Invalid: zero lamports
    const zeroLamports: TransferParams = {
      destinationAddress: "11111111111111111111111111111111",
      lamports: BigInt(0),
      currentBalanceLamports: BigInt(10_000_000),
    };
    const zeroErr = transactionService.validateTransferParams(zeroLamports);
    expect(zeroErr).not.toBeNull();
    expect(zeroErr!.field).toBe("amount");

    // Invalid: amount exceeds balance minus fee (fee = 5000 lamports)
    const tooMuch: TransferParams = {
      destinationAddress: "11111111111111111111111111111111",
      lamports: BigInt(9_999_999), // balance is 10M, fee is 5000, max is 9,995,000
      currentBalanceLamports: BigInt(10_000_000),
    };
    const tooMuchErr = transactionService.validateTransferParams(tooMuch);
    expect(tooMuchErr).not.toBeNull();
    expect(tooMuchErr!.field).toBe("amount");

    // Valid: real Base58 address, sufficient balance
    // Use the system program address which is a known valid 32-byte Base58 address
    const validParams: TransferParams = {
      destinationAddress: "11111111111111111111111111111111",
      lamports: BigInt(1_000_000),
      currentBalanceLamports: BigInt(10_000_000),
    };
    const validErr = transactionService.validateTransferParams(validParams);
    expect(validErr).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 5: Transaction preview flow
  // TransactionService.buildTransactionPreview builds a preview with mocked
  // blockhash via SolanaService
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 5: Transaction preview — builds preview with mocked blockhash", async () => {
    const params: TransferParams = {
      destinationAddress: "11111111111111111111111111111111",
      lamports: BigInt(1_000_000),
      currentBalanceLamports: BigInt(10_000_000),
    };

    const preview = await transactionService.buildTransactionPreview(params);

    expect(preview.destinationAddress).toBe(params.destinationAddress);
    expect(typeof preview.blockhash).toBe("string");
    expect(preview.blockhash.length).toBeGreaterThan(0);
    // Mocked blockhash from the vi.mock at top of file
    expect(preview.blockhash).toBe(
      "FakeBlockhash1111111111111111111111111111111"
    );
    expect(typeof preview.amountSol).toBe("string");
    expect(typeof preview.estimatedFeeSol).toBe("string");
    // 1_000_000 lamports = 0.001000000 SOL (9 decimal places)
    expect(preview.amountSol).toBe("0.001000000");
    // 5000 lamports fee
    expect(preview.estimatedFeeSol).toBe("0.000005000");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 6: Session teardown flow
  // DeviceMonitor emits device-removed → SessionService terminates session
  // → verify key is zeroed
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 6: Session teardown — device-removed triggers session termination and key zeroing", async () => {
    // Do enroll/derive BEFORE faking timers, so enrollment's listDevices() call
    // uses the real mock provider (returns the default MOCK_DEVICE_INFO).
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "Teardown Key",
      liveSignal()
    );

    const derivationResult = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );
    expect(isDerivationResult(derivationResult)).toBe(true);
    if (!isDerivationResult(derivationResult)) throw new Error("Expected DerivationResult");

    // Create session
    const session = sessionService.createSession(
      DEVICE_PATH,
      credentialId,
      "Teardown Key",
      derivationResult.keypair
    );
    expect(sessionService.isSessionActive()).toBe(true);

    // Capture internal secret buffer BEFORE starting monitor (to check zeroing later)
    const internalBuf = (
      session.keypair as unknown as { _keypair: { secretKey: Uint8Array } }
    )._keypair.secretKey;
    expect(internalBuf.some((b) => b !== 0)).toBe(true); // not zeroed yet

    // Wire DeviceMonitor device-removed event to SessionService.terminateSession
    deviceMonitor.on("device-removed", (e) => {
      const evt = e as Extract<DeviceEvent, { type: "device-removed" }>;
      if (sessionService.isSessionActive()) {
        const active = sessionService.getActiveSession();
        if (active && active.devicePath === evt.devicePath) {
          sessionService.terminateSession(active.sessionId);
        }
      }
    });

    // Now switch to fake timers and configure poll results:
    // poll 1 → device present, poll 2+ → device gone
    vi.useFakeTimers();
    vi.spyOn(provider, "listDevices")
      .mockResolvedValueOnce([MOCK_DEVICE_INFO])
      .mockResolvedValue([]);

    deviceMonitor.start();

    // Poll 1: device connects (DeviceMonitor adds it to knownDevices)
    await vi.advanceTimersByTimeAsync(600);

    // Poll 2: device disappears → device-removed fires → session terminates
    await vi.advanceTimersByTimeAsync(600);

    // Session should be terminated
    expect(sessionService.isSessionActive()).toBe(false);
    expect(sessionService.getActiveSession()).toBeNull();

    // Secret key buffer must be zeroed
    expect(internalBuf.every((b) => b === 0)).toBe(true);

    vi.useRealTimers();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 7: Security — no secrets on disk
  // After full e2e run, CredentialStore file contains only safe metadata
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 7: Security — CredentialStore file contains no secret material after full e2e run", async () => {
    // Full e2e run: enroll → derive → session → terminate
    const { credentialId } = await enrollmentService.enroll(
      DEVICE_PATH,
      "Secure Key",
      liveSignal()
    );

    const derivationResult = await derivationService.deriveWallet(
      DEVICE_PATH,
      credentialId,
      liveSignal()
    );
    expect(isDerivationResult(derivationResult)).toBe(true);
    if (!isDerivationResult(derivationResult)) throw new Error("Expected DerivationResult");

    const session = sessionService.createSession(
      DEVICE_PATH,
      credentialId,
      "Secure Key",
      derivationResult.keypair
    );
    sessionService.terminateSession(session.sessionId);

    // Verify the credentials.json file exists
    expect(existsSync(credentialStorePath)).toBe(true);

    // Read raw JSON and check structure
    const rawJson = readFileSync(credentialStorePath, "utf-8");
    const parsed = JSON.parse(rawJson) as {
      version: number;
      credentials: Record<string, unknown>[];
    };

    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.credentials)).toBe(true);
    expect(parsed.credentials).toHaveLength(1);

    const record = parsed.credentials[0];

    // Must have exactly 4 safe metadata fields
    const keys = Object.keys(record).sort();
    expect(keys).toEqual(
      ["credentialId", "createdAt", "displayName", "rpId"].sort()
    );

    expect(record.rpId).toBe("key-wallet.local");
    expect(record.displayName).toBe("Secure Key");
    expect(typeof record.credentialId).toBe("string");
    expect(typeof record.createdAt).toBe("string");

    // Raw JSON must contain no secret-material field names
    expect(rawJson).not.toContain("secretKey");
    expect(rawJson).not.toContain("keypair");
    expect(rawJson).not.toContain("walletSeed");
    expect(rawJson).not.toContain("prfOutput");
    expect(rawJson).not.toContain("hmacOutput");
    expect(rawJson).not.toContain("privateKey");
    expect(rawJson).not.toContain("seed");

    // The credentialId on disk must be hex of the original Uint8Array
    expect(record.credentialId).toBe(
      Buffer.from(credentialId).toString("hex")
    );
  });
});
