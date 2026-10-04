// src/main/session/SessionService.ts

import type { Keypair } from "@solana/web3.js";

/**
 * Zero-overwrites the actual internal secret-key buffer of a Solana Keypair.
 *
 * `keypair.secretKey` is a getter that returns a *copy* of the underlying bytes
 * on every call.  Calling `.fill(0)` on that copy does not affect the
 * internally stored key material.  The real buffer lives at
 * `(keypair as any)._keypair.secretKey` (the nacl-based internal representation
 * used by `@solana/web3.js`).  We zero that buffer directly so that the secret
 * key bytes are genuinely overwritten in memory (Req 5.4).
 */
function zeroKeypairSecret(keypair: Keypair): void {
  // Access the internal nacl keypair — this is the canonical buffer that
  // keypair.secretKey copies from on each get.
  const internal = (keypair as unknown as { _keypair: { secretKey: Uint8Array } })._keypair;
  if (internal?.secretKey instanceof Uint8Array) {
    internal.secretKey.fill(0);
  }
}

export interface Session {
  sessionId: string; // UUID v4
  walletAddress: string; // Base58 public key
  /** Keypair held in memory only — never persisted */
  keypair: Keypair;
  devicePath: string;
  credentialId: Uint8Array;
  displayName: string;
  createdAt: Date;
}

export interface ISessionService {
  createSession(
    devicePath: string,
    credentialId: Uint8Array,
    displayName: string,
    keypair: Keypair,
  ): Session;

  getActiveSession(): Session | null;

  /**
   * Zero-overwrites keypair private key bytes and clears session state.
   * Must complete within 200ms of device-removed event.
   */
  terminateSession(sessionId: string): void;

  isSessionActive(): boolean;
}

/**
 * Manages the in-memory wallet session lifecycle.
 *
 * Security invariants:
 * - The keypair is NEVER serialised to disk, system keychain, or any persistent store.
 * - On termination, `keypair.secretKey` is zero-overwritten before the session
 *   reference is removed from memory.
 * - When no session is active, all transaction-related calls must be rejected
 *   with the "session-locked" error category (Req 5.8).
 */
export class SessionService implements ISessionService {
  private activeSession: Session | null = null;

  /**
   * Creates a new in-memory session from the supplied keypair.
   *
   * @param devicePath   OS HID path of the authenticator
   * @param credentialId Raw credential bytes (stored in memory only)
   * @param displayName  Human-readable credential label
   * @param keypair      Ed25519 keypair derived from the hardware key
   * @returns            The newly created Session
   */
  createSession(
    devicePath: string,
    credentialId: Uint8Array,
    displayName: string,
    keypair: Keypair,
  ): Session {
    // Terminate any pre-existing session first, so only one is ever live.
    if (this.activeSession !== null) {
      this.terminateSession(this.activeSession.sessionId);
    }

    const session: Session = {
      // Use Node.js built-in crypto.randomUUID() — no uuid package needed.
      sessionId: crypto.randomUUID(),
      walletAddress: keypair.publicKey.toBase58(),
      keypair,
      devicePath,
      credentialId,
      displayName,
      createdAt: new Date(),
    };

    this.activeSession = session;
    return session;
  }

  /**
   * Returns the currently active session, or `null` if no session exists.
   */
  getActiveSession(): Session | null {
    return this.activeSession;
  }

  /**
   * Terminates the session identified by `sessionId`.
   *
   * Steps (per Req 5.3, 5.4):
   * 1. Locate the session — if it does not match the active session, this is a no-op.
   * 2. Zero-overwrite the 64-byte `secretKey` buffer in place.
   * 3. Remove the session reference so the keypair object can be GC'd.
   *
   * The entire operation is synchronous and completes well within the 200ms budget.
   */
  terminateSession(sessionId: string): void {
    if (this.activeSession === null) {
      return; // No-op — nothing to terminate
    }

    if (this.activeSession.sessionId !== sessionId) {
      return; // No-op — unknown / already-gone session ID
    }

    // Zero-overwrite private key bytes before releasing the reference (Req 5.4).
    // NOTE: keypair.secretKey returns a *copy* each time it is accessed.
    // We must zero the internal buffer directly so the actual key material
    // in memory is overwritten (see zeroKeypairSecret above).
    zeroKeypairSecret(this.activeSession.keypair);

    // Clear all in-memory session state.
    this.activeSession = null;
  }

  /**
   * Returns `true` while a session is active, `false` otherwise.
   */
  isSessionActive(): boolean {
    return this.activeSession !== null;
  }
}
