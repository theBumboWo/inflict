// src/main/derivation/DerivationService.ts

import { Keypair } from "@solana/web3.js";
import type { CtapErrorCode } from "../hardware/types";
import { CtapError } from "../hardware/types";
import type { IHardwareIdentityProvider } from "../hardware/IHardwareIdentityProvider";
import { hkdf, PRF_SALT_CONSTANT } from "./hkdf";

export interface DerivationResult {
  keypair: Keypair;
  walletAddress: string; // Base58-encoded public key
}

export type DerivationError =
  | { kind: "user-cancelled" }
  | { kind: "authenticator-error"; ctapCode: CtapErrorCode }
  | { kind: "key-derivation-error"; detail: string };

export interface IDerivationService {
  /**
   * Invokes hmac-secret on the device, runs two-step HKDF,
   * constructs the Ed25519 keypair.
   * Zero-overwrites PRF_Output and Wallet_Seed before returning.
   */
  deriveWallet(
    devicePath: string,
    credentialId: Uint8Array,
    signal: AbortSignal
  ): Promise<DerivationResult | DerivationError>;
}

export class DerivationService implements IDerivationService {
  private readonly provider: IHardwareIdentityProvider;

  constructor(provider: IHardwareIdentityProvider) {
    this.provider = provider;
  }

  async deriveWallet(
    devicePath: string,
    credentialId: Uint8Array,
    signal: AbortSignal
  ): Promise<DerivationResult | DerivationError> {
    // Check if already aborted before doing any work
    if (signal.aborted) {
      return { kind: "user-cancelled" };
    }

    // Sensitive buffers declared outside try so they can be zeroed in finally
    let hmacOutput: Uint8Array | null = null;
    let walletSeed: Buffer | null = null;

    try {
      // Step 1: Call provider.getAssertion() with PRF_SALT_CONSTANT and userVerification: "required"
      let assertionResult: Awaited<
        ReturnType<IHardwareIdentityProvider["getAssertion"]>
      >;

      try {
        assertionResult = await this.provider.getAssertion(devicePath, {
          rpId: "key-wallet.local",
          credentialId,
          hmacSalt: PRF_SALT_CONSTANT as Uint8Array,
          userVerification: "required",
        });
      } catch (err) {
        // Check for user cancellation via AbortSignal or AbortError
        if (
          signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return { kind: "user-cancelled" };
        }

        // Map CTAP2 errors to authenticator-error
        if (err instanceof CtapError) {
          return { kind: "authenticator-error", ctapCode: err.code };
        }

        // Any other error from the authenticator
        return { kind: "authenticator-error", ctapCode: "UNKNOWN" };
      }

      // Check signal again after the async assertion
      if (signal.aborted) {
        return { kind: "user-cancelled" };
      }

      // PRF_Output — must be zero-overwritten in finally
      hmacOutput = assertionResult.hmacOutput;

      // Step 2: Derive Wallet_Seed via HKDF-SHA256
      //   Wallet_Seed = hkdf(PRF_Output, empty, "key-wallet:solana:ed25519:v1", 32)
      walletSeed = hkdf(
        hmacOutput,
        Buffer.alloc(0),
        Buffer.from("key-wallet:solana:ed25519:v1", "utf8"),
        32
      );

      // Step 3: Construct the Ed25519 keypair from the 32-byte seed
      const keypair = Keypair.fromSeed(walletSeed);

      // Step 5: Return { keypair, walletAddress }
      const walletAddress = keypair.publicKey.toBase58();
      return { keypair, walletAddress };
    } finally {
      // Step 4: Zero-overwrite sensitive buffers regardless of success or failure
      if (hmacOutput !== null) {
        hmacOutput.fill(0);
      }
      if (walletSeed !== null) {
        walletSeed.fill(0);
      }
    }
  }
}
