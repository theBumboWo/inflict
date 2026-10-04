// test/unit/SessionService.test.ts
//
// Unit tests for SessionService — Validates: Requirements 5

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionService } from "../../src/main/session/SessionService";
import type { Keypair } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID v4 pattern */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const KNOWN_ADDRESS = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV1";
const DEVICE_PATH = "mock://device/1";
const DISPLAY_NAME = "Test Credential";

/**
 * Builds a minimal mock Keypair that mimics the internal structure of a real
 * `@solana/web3.js` Keypair.  The real Keypair stores its private key in
 * `this._keypair.secretKey` (a 64-byte Uint8Array); `keypair.secretKey` is
 * a getter that returns a *copy* of that buffer on every access.
 *
 * SessionService.terminateSession() calls `zeroKeypairSecret()`, which zeroes
 * `keypair._keypair.secretKey` directly.  The mock must expose this shape so
 * the spy and the zero-check both work.
 */
function makeMockKeypair(): { keypair: Keypair; internalSecretKey: Uint8Array } {
  const internalSecretKey = new Uint8Array(64).fill(0xaa);

  const keypair = {
    _keypair: { secretKey: internalSecretKey },
    // Mimic the real getter — returns a copy each time (just like @solana/web3.js)
    get secretKey() { return new Uint8Array(internalSecretKey); },
    publicKey: {
      toBase58: () => KNOWN_ADDRESS,
    },
  } as unknown as Keypair;

  return { keypair, internalSecretKey };
}

function makeCredentialId(): Uint8Array {
  return new Uint8Array(32).fill(0x01);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionService", () => {
  let service: SessionService;

  beforeEach(() => {
    service = new SessionService();
  });

  // -------------------------------------------------------------------------
  // 1. createSession returns a valid session with all required fields (Req 5.1)
  // -------------------------------------------------------------------------
  it("createSession returns a valid session with all required fields", () => {
    const { keypair } = makeMockKeypair();
    const credentialId = makeCredentialId();

    const session = service.createSession(
      DEVICE_PATH,
      credentialId,
      DISPLAY_NAME,
      keypair,
    );

    // sessionId must be a UUID v4
    expect(session.sessionId).toMatch(UUID_V4_REGEX);

    // walletAddress must match keypair.publicKey.toBase58()
    expect(session.walletAddress).toBe(KNOWN_ADDRESS);

    // createdAt must be a Date instance
    expect(session.createdAt).toBeInstanceOf(Date);

    // Remaining required fields
    expect(session.devicePath).toBe(DEVICE_PATH);
    expect(session.credentialId).toBe(credentialId);
    expect(session.displayName).toBe(DISPLAY_NAME);
    expect(session.keypair).toBe(keypair);
  });

  // -------------------------------------------------------------------------
  // 2. terminateSession zeroes the secretKey buffer (Req 5.4)
  // -------------------------------------------------------------------------
  it("terminateSession calls secretKey.fill(0) to zero-overwrite private key bytes", () => {
    const { keypair, internalSecretKey } = makeMockKeypair();

    const session = service.createSession(
      DEVICE_PATH,
      makeCredentialId(),
      DISPLAY_NAME,
      keypair,
    );

    // Spy on the internal buffer's fill method — this is what SessionService
    // actually zeroes (via zeroKeypairSecret which accesses _keypair.secretKey).
    const fillSpy = vi.spyOn(internalSecretKey, "fill");

    service.terminateSession(session.sessionId);

    expect(fillSpy).toHaveBeenCalledWith(0);
  });

  // -------------------------------------------------------------------------
  // 3. getActiveSession returns null after termination (Req 5.3)
  // -------------------------------------------------------------------------
  it("getActiveSession returns null after terminateSession is called", () => {
    const { keypair } = makeMockKeypair();

    const session = service.createSession(
      DEVICE_PATH,
      makeCredentialId(),
      DISPLAY_NAME,
      keypair,
    );

    // Session should be active before termination
    expect(service.getActiveSession()).not.toBeNull();

    service.terminateSession(session.sessionId);

    // Session must be gone after termination
    expect(service.getActiveSession()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. terminateSession is a no-op for a non-existent session ID (Req 5.3)
  // -------------------------------------------------------------------------
  it("terminateSession with an unknown session ID does not throw", () => {
    // No session has been created — terminating a random UUID must be silent
    expect(() => {
      service.terminateSession("00000000-0000-4000-8000-000000000000");
    }).not.toThrow();
  });

  it("terminateSession with a mismatched session ID leaves the active session untouched", () => {
    const { keypair } = makeMockKeypair();

    const session = service.createSession(
      DEVICE_PATH,
      makeCredentialId(),
      DISPLAY_NAME,
      keypair,
    );

    // Attempt to terminate using a different UUID — must be a no-op
    expect(() => {
      service.terminateSession("ffffffff-ffff-4fff-bfff-ffffffffffff");
    }).not.toThrow();

    // Active session must still be there
    expect(service.getActiveSession()).not.toBeNull();
    expect(service.getActiveSession()!.sessionId).toBe(session.sessionId);
  });
});
