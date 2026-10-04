// test/integration/session-lifecycle.integration.test.ts
//
// Integration tests exercising the full session lifecycle using only
// mock/in-memory components — no real hardware, no network calls.
//
// Flow: credential discovery → wallet derivation → session creation → termination
//
// Validates: Req 3 (Credential Discovery), Req 4 (Wallet Derivation),
//            Req 5 (Session Lifecycle), Req 9 (Security Key Removal),
//            Req 2.8, Req 2.9 (No Secret Storage)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";
import { DerivationService } from "../../src/main/derivation/DerivationService";
import { SessionService } from "../../src/main/session/SessionService";
import { CredentialStore } from "../../src/main/storage/CredentialStore";
import { EnrollmentService } from "../../src/main/enrollment/EnrollmentService";
import type { DerivationResult } from "../../src/main/derivation/DerivationService";

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

// Base58 character set
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

// UUID v4 format
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Session lifecycle integration", () => {
  let tempDir: string;
  let credentialStorePath: string;
  let provider: MockHardwareIdentityProvider;
  let credentialStore: CredentialStore;
  let enrollmentService: EnrollmentService;
  let derivationService: DerivationService;
  let sessionService: SessionService;

  beforeEach(() => {
    // Create a fresh temp directory for each test so they are fully isolated.
    tempDir = mkdtempSync(join(tmpdir(), "keywallet-test-"));
    credentialStorePath = join(tempDir, "credentials.json");

    provider = new MockHardwareIdentityProvider();
    credentialStore = new CredentialStore(credentialStorePath);
    enrollmentService = new EnrollmentService(provider, credentialStore);
    derivationService = new DerivationService(provider);
    sessionService = new SessionService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up the temp directory after each test.
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Credential discovery (Req 3)
  // -------------------------------------------------------------------------
  describe("Scenario 1 — credential discovery (Req 3)", () => {
    it("discoverCredentials() returns a pre-configured credential from the mock provider", async () => {
      // Configure the mock to return one discoverable credential
      const existingCredentialId = new Uint8Array(32).fill(0xab);
      provider.setDiscoveryResult({
        credentials: [
          {
            credentialId: existingCredentialId,
            userDisplayName: "My YubiKey",
            userId: new Uint8Array(16).fill(0x01),
          },
        ],
      });

      const result = await provider.discoverCredentials(
        DEVICE_PATH,
        "key-wallet.local"
      );

      expect(result.credentials).toHaveLength(1);
      expect(
        Buffer.from(result.credentials[0].credentialId).toString("hex")
      ).toBe(Buffer.from(existingCredentialId).toString("hex"));
      expect(result.credentials[0].userDisplayName).toBe("My YubiKey");
    });

    it("discoverCredentials() returns an empty list when no credentials are present", async () => {
      // Default mock state returns no credentials
      const result = await provider.discoverCredentials(
        DEVICE_PATH,
        "key-wallet.local"
      );

      expect(result.credentials).toHaveLength(0);
    });

    it("can proceed to wallet derivation after discovering a credential", async () => {
      const existingCredentialId = new Uint8Array(32).fill(0xcd);
      provider.setDiscoveryResult({
        credentials: [
          {
            credentialId: existingCredentialId,
            userDisplayName: "Returning User Key",
            userId: new Uint8Array(16).fill(0x02),
          },
        ],
      });

      const { credentials } = await provider.discoverCredentials(
        DEVICE_PATH,
        "key-wallet.local"
      );
      expect(credentials).toHaveLength(1);

      const discoveredCredentialId = credentials[0].credentialId;

      const derivationResult = await derivationService.deriveWallet(
        DEVICE_PATH,
        discoveredCredentialId,
        liveSignal()
      );

      expect(isDerivationResult(derivationResult)).toBe(true);
      if (!isDerivationResult(derivationResult)) {
        throw new Error("Expected DerivationResult");
      }

      // Valid wallet address must be Base58, 32–44 chars (Req 6.1)
      expect(derivationResult.walletAddress).toMatch(BASE58_REGEX);
      expect(derivationResult.walletAddress.length).toBeGreaterThanOrEqual(32);
      expect(derivationResult.walletAddress.length).toBeLessThanOrEqual(44);

      const session = sessionService.createSession(
        DEVICE_PATH,
        discoveredCredentialId,
        "Returning User Key",
        derivationResult.keypair
      );

      expect(session.walletAddress).toBe(derivationResult.walletAddress);
      expect(sessionService.isSessionActive()).toBe(true);

      // Cleanup
      sessionService.terminateSession(session.sessionId);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Wallet derivation (Req 4)
  // -------------------------------------------------------------------------
  describe("Scenario 2 — wallet derivation (Req 4)", () => {
    it("deriveWallet() returns a valid Base58 wallet address (32–44 chars)", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "My YubiKey",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      expect(typeof result.walletAddress).toBe("string");
      expect(result.walletAddress).toMatch(BASE58_REGEX);
      expect(result.walletAddress.length).toBeGreaterThanOrEqual(32);
      expect(result.walletAddress.length).toBeLessThanOrEqual(44);

      // Cleanup
      sessionService.terminateSession(
        sessionService.createSession(DEVICE_PATH, credentialId, "My YubiKey", result.keypair).sessionId
      );
    });

    it("walletAddress matches keypair.publicKey.toBase58()", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "My YubiKey",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      // walletAddress must match the keypair's actual public key
      expect(result.walletAddress).toBe(result.keypair.publicKey.toBase58());

      // Cleanup
      sessionService.terminateSession(
        sessionService.createSession(DEVICE_PATH, credentialId, "My YubiKey", result.keypair).sessionId
      );
    });

    it("produces distinct wallet addresses for two distinct credential IDs (Req 4.8)", async () => {
      const enrollA = await enrollmentService.enroll(DEVICE_PATH, "Key A", liveSignal());
      const enrollB = await enrollmentService.enroll(DEVICE_PATH, "Key B", liveSignal());

      // Ensure the two credential IDs are actually different
      expect(
        Buffer.from(enrollA.credentialId).toString("hex")
      ).not.toBe(
        Buffer.from(enrollB.credentialId).toString("hex")
      );

      const resultA = await derivationService.deriveWallet(DEVICE_PATH, enrollA.credentialId, liveSignal());
      const resultB = await derivationService.deriveWallet(DEVICE_PATH, enrollB.credentialId, liveSignal());

      expect(isDerivationResult(resultA)).toBe(true);
      expect(isDerivationResult(resultB)).toBe(true);

      if (!isDerivationResult(resultA) || !isDerivationResult(resultB)) {
        throw new Error("Expected DerivationResults");
      }

      // Different credentials must produce different wallet addresses
      expect(resultA.walletAddress).not.toBe(resultB.walletAddress);

      // Cleanup
      sessionService.terminateSession(
        sessionService.createSession(DEVICE_PATH, enrollA.credentialId, "Key A", resultA.keypair).sessionId
      );
    });

    it("is deterministic: same credential ID always produces the same wallet address (Req 4.9)", async () => {
      const { credentialId } = await enrollmentService.enroll(DEVICE_PATH, "My Key", liveSignal());

      const result1 = await derivationService.deriveWallet(DEVICE_PATH, credentialId, liveSignal());
      const result2 = await derivationService.deriveWallet(DEVICE_PATH, credentialId, liveSignal());

      expect(isDerivationResult(result1)).toBe(true);
      expect(isDerivationResult(result2)).toBe(true);

      if (!isDerivationResult(result1) || !isDerivationResult(result2)) {
        throw new Error("Expected DerivationResults");
      }

      expect(result1.walletAddress).toBe(result2.walletAddress);

      // Cleanup
      sessionService.terminateSession(
        sessionService.createSession(DEVICE_PATH, credentialId, "My Key", result1.keypair).sessionId
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Session creation (Req 5.1, 5.2)
  // -------------------------------------------------------------------------
  describe("Scenario 3 — session creation (Req 5.1)", () => {
    it("creates a session with all required fields", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "My YubiKey",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      const beforeCreate = new Date();
      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "My YubiKey",
        result.keypair
      );
      const afterCreate = new Date();

      // sessionId: UUID v4
      expect(session.sessionId).toMatch(UUID_V4_REGEX);

      // walletAddress: Base58, 32–44 chars
      expect(session.walletAddress).toBe(result.walletAddress);
      expect(session.walletAddress).toMatch(BASE58_REGEX);
      expect(session.walletAddress.length).toBeGreaterThanOrEqual(32);
      expect(session.walletAddress.length).toBeLessThanOrEqual(44);

      // displayName
      expect(session.displayName).toBe("My YubiKey");

      // devicePath
      expect(session.devicePath).toBe(DEVICE_PATH);

      // credentialId: must match the one we passed in
      expect(
        Buffer.from(session.credentialId).toString("hex")
      ).toBe(
        Buffer.from(credentialId).toString("hex")
      );

      // createdAt: must be a Date within the create window
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(session.createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());

      // keypair: must be the one we passed in
      expect(session.keypair).toBe(result.keypair);

      // Cleanup
      sessionService.terminateSession(session.sessionId);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Session active check (Req 5.1, 5.2)
  // -------------------------------------------------------------------------
  describe("Scenario 4 — session active check (Req 5.1, Req 5.2)", () => {
    it("isSessionActive() returns true and getActiveSession() returns the session while active", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "My YubiKey",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      // Before session creation, no active session
      expect(sessionService.isSessionActive()).toBe(false);
      expect(sessionService.getActiveSession()).toBeNull();

      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "My YubiKey",
        result.keypair
      );

      // After creation, session is active
      expect(sessionService.isSessionActive()).toBe(true);

      const activeSession = sessionService.getActiveSession();
      expect(activeSession).not.toBeNull();
      expect(activeSession!.sessionId).toBe(session.sessionId);
      expect(activeSession!.walletAddress).toBe(session.walletAddress);

      // Cleanup
      sessionService.terminateSession(session.sessionId);

      // After termination, no active session
      expect(sessionService.isSessionActive()).toBe(false);
      expect(sessionService.getActiveSession()).toBeNull();
    });

    it("isSessionActive() returns false before any session is created", () => {
      expect(sessionService.isSessionActive()).toBe(false);
    });

    it("getActiveSession() returns null before any session is created", () => {
      expect(sessionService.getActiveSession()).toBeNull();
    });

    it("terminateSession() with an unknown sessionId is a no-op", () => {
      expect(() =>
        sessionService.terminateSession("00000000-0000-4000-a000-000000000000")
      ).not.toThrow();

      expect(sessionService.isSessionActive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Session termination (Req 5.3, 5.4)
  // -------------------------------------------------------------------------
  describe("Scenario 5 — session termination (Req 5.3, Req 5.4)", () => {
    it("terminateSession() zeroes the keypair.secretKey and clears session state", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "Test Key",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      const { keypair } = result;

      // secretKey (64 bytes: seed || public key) should NOT be all zeros before termination
      const isAllZerosBefore = keypair.secretKey.every((b) => b === 0);
      expect(isAllZerosBefore).toBe(false);

      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "Test Key",
        keypair
      );

      sessionService.terminateSession(session.sessionId);

      // After termination, keypair.secretKey must be all zeros (Req 5.4)
      const isAllZerosAfter = keypair.secretKey.every((b) => b === 0);
      expect(isAllZerosAfter).toBe(true);

      // Session state must be cleared
      expect(sessionService.getActiveSession()).toBeNull();
      expect(sessionService.isSessionActive()).toBe(false);
    });

    it("getActiveSession() returns null after termination", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "Test Key",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "Test Key",
        result.keypair
      );

      expect(sessionService.isSessionActive()).toBe(true);

      sessionService.terminateSession(session.sessionId);

      expect(sessionService.getActiveSession()).toBeNull();
      expect(sessionService.isSessionActive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Memory cleanup — secretKey is zeroed via fill(0) (Req 5.4, Req 9.3)
  // -------------------------------------------------------------------------
  describe("Scenario 6 — memory cleanup: internal secret key buffer is zeroed on termination (Req 5.4, Req 9.3)", () => {
    it("keypair.secretKey returns all zeros after session termination", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "Cleanup Key",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      const { keypair } = result;

      // Access the internal buffer that SessionService will zero-overwrite.
      // keypair.secretKey is a getter returning a copy each time — we need
      // to spy on the underlying buffer to verify fill(0) is called.
      const internalBuf = (keypair as unknown as { _keypair: { secretKey: Uint8Array } })._keypair.secretKey;
      expect(internalBuf).toBeInstanceOf(Uint8Array);
      expect(internalBuf.byteLength).toBe(64);

      // Spy on fill to confirm zero-overwrite is called on the internal buffer
      const fillSpy = vi.spyOn(internalBuf, "fill");

      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "Cleanup Key",
        keypair
      );

      sessionService.terminateSession(session.sessionId);

      // Verify that fill was called with 0 (zero-overwrite) on the internal buffer
      expect(fillSpy).toHaveBeenCalledWith(0);

      // Verify keypair.secretKey now returns all zeros
      expect(Array.from(keypair.secretKey).every((b) => b === 0)).toBe(true);
    });

    it("subsequent calls to keypair.secretKey return zeroed bytes after termination", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "Cleanup Key",
        liveSignal()
      );

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      const { keypair } = result;

      // Capture the key value before termination — should NOT be all zeros
      const snapshotBefore = keypair.secretKey;
      expect(snapshotBefore.some((b) => b !== 0)).toBe(true);

      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "Cleanup Key",
        keypair
      );

      sessionService.terminateSession(session.sessionId);

      // After termination, all subsequent secretKey reads must return zeroed bytes
      // (the underlying buffer is zeroed, so every copy will also be zeroed)
      const snapshotAfter = keypair.secretKey;
      expect(snapshotAfter.every((b) => b === 0)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 7: No secret on disk (Req 2.8, Req 2.9, Req 5.7)
  // -------------------------------------------------------------------------
  describe("Scenario 7 — no secret material stored on disk (Req 2.8, Req 2.9, Req 5.7)", () => {
    it("CredentialStore only persists credentialId (hex), rpId, displayName, and createdAt", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "My Secure Key",
        liveSignal()
      );

      const stored = await credentialStore.findAll();
      expect(stored).toHaveLength(1);

      const record = stored[0];

      // Must contain exactly the four safe fields
      expect(record.credentialId).toBe(Buffer.from(credentialId).toString("hex"));
      expect(record.rpId).toBe("key-wallet.local");
      expect(record.displayName).toBe("My Secure Key");
      expect(typeof record.createdAt).toBe("string");

      // Verify createdAt is a valid ISO 8601 date string
      expect(() => new Date(record.createdAt)).not.toThrow();
      expect(new Date(record.createdAt).getTime()).not.toBeNaN();

      // Must NOT contain keypair, secretKey, seed, prf, hmac, or privateKey fields
      const keys = Object.keys(record);
      expect(keys).not.toContain("keypair");
      expect(keys).not.toContain("secretKey");
      expect(keys).not.toContain("seed");
      expect(keys).not.toContain("prf");
      expect(keys).not.toContain("hmac");
      expect(keys).not.toContain("privateKey");
      expect(keys).not.toContain("walletSeed");
      expect(keys).not.toContain("prfOutput");

      // Must have exactly 4 fields
      expect(keys.sort()).toEqual(
        ["credentialId", "createdAt", "displayName", "rpId"].sort()
      );
    });

    it("raw JSON on disk contains no private key or seed material", async () => {
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "My Secure Key",
        liveSignal()
      );

      // Derive wallet (this should NOT write anything secret to disk)
      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        credentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      // Create and terminate session (this should NOT write anything to disk)
      const session = sessionService.createSession(
        DEVICE_PATH,
        credentialId,
        "My Secure Key",
        result.keypair
      );

      sessionService.terminateSession(session.sessionId);

      // Verify the credentials.json file exists and contains only safe metadata
      expect(existsSync(credentialStorePath)).toBe(true);

      const rawJson = readFileSync(credentialStorePath, "utf-8");
      const parsed = JSON.parse(rawJson);

      // Structural check: version 1 with credentials array
      expect(parsed.version).toBe(1);
      expect(Array.isArray(parsed.credentials)).toBe(true);
      expect(parsed.credentials).toHaveLength(1);

      const storedRaw = parsed.credentials[0];
      expect(typeof storedRaw.credentialId).toBe("string");
      expect(storedRaw.rpId).toBe("key-wallet.local");
      expect(storedRaw.displayName).toBe("My Secure Key");

      // The entire JSON string must not contain secret-looking fields
      expect(rawJson).not.toContain("secretKey");
      expect(rawJson).not.toContain("keypair");
      expect(rawJson).not.toContain("walletSeed");
      expect(rawJson).not.toContain("prfOutput");
      expect(rawJson).not.toContain("hmacOutput");
      expect(rawJson).not.toContain("privateKey");
    });

    it("the credential store file is not created by derivation or session operations", async () => {
      // Do NOT enroll — only derive using a raw credentialId
      const rawCredentialId = new Uint8Array(32).fill(0xef);
      provider.setDiscoveryResult({
        credentials: [
          {
            credentialId: rawCredentialId,
            userDisplayName: "Test",
            userId: new Uint8Array(16),
          },
        ],
      });

      const result = await derivationService.deriveWallet(
        DEVICE_PATH,
        rawCredentialId,
        liveSignal()
      );

      expect(isDerivationResult(result)).toBe(true);
      if (!isDerivationResult(result)) throw new Error("Expected DerivationResult");

      const session = sessionService.createSession(
        DEVICE_PATH,
        rawCredentialId,
        "Test",
        result.keypair
      );

      sessionService.terminateSession(session.sessionId);

      // No enrollment was performed — the credential file should NOT exist
      // (DerivationService and SessionService must never write to disk)
      expect(existsSync(credentialStorePath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Full end-to-end: enrollment → discovery → derivation → session → termination
  // -------------------------------------------------------------------------
  describe("Full end-to-end lifecycle", () => {
    it("completes the full lifecycle without errors", async () => {
      // Step 1: Enroll (creates credential, stores metadata)
      const { credentialId } = await enrollmentService.enroll(
        DEVICE_PATH,
        "E2E Key",
        liveSignal()
      );

      expect(credentialId).toBeInstanceOf(Uint8Array);
      expect(credentialId.byteLength).toBe(32);

      // Step 2: Credential discovery (simulate returning user)
      provider.setDiscoveryResult({
        credentials: [
          {
            credentialId,
            userDisplayName: "E2E Key",
            userId: new Uint8Array(16).fill(0x99),
          },
        ],
      });

      const discovery = await provider.discoverCredentials(DEVICE_PATH, "key-wallet.local");
      expect(discovery.credentials).toHaveLength(1);

      const discoveredId = discovery.credentials[0].credentialId;

      // Step 3: Derive wallet
      const derivationResult = await derivationService.deriveWallet(
        DEVICE_PATH,
        discoveredId,
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
        discoveredId,
        "E2E Key",
        derivationResult.keypair
      );

      expect(session.sessionId).toMatch(UUID_V4_REGEX);
      expect(session.walletAddress).toBe(derivationResult.walletAddress);
      expect(session.displayName).toBe("E2E Key");
      expect(session.devicePath).toBe(DEVICE_PATH);
      expect(session.createdAt).toBeInstanceOf(Date);

      // Step 5: Verify session is active
      expect(sessionService.isSessionActive()).toBe(true);
      expect(sessionService.getActiveSession()!.sessionId).toBe(session.sessionId);

      // Step 6: Terminate session
      // NOTE: keypair.secretKey is a getter returning a copy — to verify the
      // underlying buffer was zeroed, capture the internal buffer reference.
      const internalSecretBuf = (
        session.keypair as unknown as { _keypair: { secretKey: Uint8Array } }
      )._keypair.secretKey;
      sessionService.terminateSession(session.sessionId);

      // Step 7: Verify memory cleanup — the internal buffer must be all zeros
      expect(internalSecretBuf.every((b) => b === 0)).toBe(true);
      // Subsequent reads from the keypair also return zeros
      expect(session.keypair.secretKey.every((b) => b === 0)).toBe(true);

      // Step 8: Verify session cleared
      expect(sessionService.isSessionActive()).toBe(false);
      expect(sessionService.getActiveSession()).toBeNull();

      // Step 9: Verify only safe metadata on disk
      const stored = await credentialStore.findAll();
      expect(stored).toHaveLength(1);
      expect(Object.keys(stored[0]).sort()).toEqual(
        ["credentialId", "createdAt", "displayName", "rpId"].sort()
      );
    });
  });
});
