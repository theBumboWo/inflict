#!/usr/bin/env tsx
/**
 * hardware-acceptance-test.ts — Full real-hardware acceptance test.
 *
 * Usage:  npx tsx scripts/hardware-acceptance-test.ts
 * Exit:   0 = all steps passed, non-zero = one or more steps failed
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5
 *
 * Steps executed in sequence:
 *   1. Device detection (listDevices)
 *   2. authenticatorGetInfo check (hmac-secret + resident-key support)
 *   3. createCredential with hmac-secret + resident key flags
 *   4. PRF assertion (getAssertion with PRF salt)
 *   5. HKDF derivation (hkdfSync)
 *   6. Solana address output (Keypair.fromSeed + publicKey.toBase58)
 *
 * Security constraints (Req 18.5):
 *   - PRF_Output, Wallet_Seed, and secretKey bytes are NEVER printed.
 *   - All secret buffers are zeroed in finally blocks.
 *
 * Error output format (Req 18.4):
 *   [FAIL] <step> | category=<errorCategory> | error=<rawErrorMessage>
 */

import * as Module from "module";
import * as path from "path";
import { hkdfSync } from "node:crypto";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Electron app shim — must be registered BEFORE any import of
// Fido2CliHardwareIdentityProvider, which does `import { app } from 'electron'`
// ---------------------------------------------------------------------------

const electronShim = {
  app: {
    isPackaged: false,
    getAppPath: (): string => process.cwd(),
  },
};

const createRequire =
  Module.createRequire ??
  (Module as unknown as { createRequire: typeof Module.createRequire })
    .createRequire;
const req = createRequire(import.meta.url ?? __filename);

try {
  const electronPath = req.resolve("electron");
  if (!require.cache[electronPath]) {
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: electronShim,
      paths: [],
      children: [],
      parent: null as unknown as NodeModule,
      require: req,
      path: path.dirname(electronPath),
      isPreloading: false,
    } as unknown as NodeJS.Module;
  }
} catch {
  // electron is not resolvable — set up a synthetic entry with bare specifier
  const fakeKey = "electron";
  if (!require.cache[fakeKey]) {
    require.cache[fakeKey] = {
      id: fakeKey,
      filename: fakeKey,
      loaded: true,
      exports: electronShim,
      paths: [],
      children: [],
      parent: null as unknown as NodeModule,
      require: req,
      path: "",
      isPreloading: false,
    } as unknown as NodeJS.Module;
  }
}

// ---------------------------------------------------------------------------
// Import providers after shim is in place
// ---------------------------------------------------------------------------

// Dynamic require so the electron shim is already cached before module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Fido2CliHardwareIdentityProvider } = require(
  "../src/main/hardware/Fido2CliHardwareIdentityProvider",
) as {
  Fido2CliHardwareIdentityProvider: new () => import("../src/main/hardware/IHardwareIdentityProvider").IHardwareIdentityProvider;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PRF_SALT_CONSTANT } = require("../src/main/derivation/hkdf") as typeof import("../src/main/derivation/hkdf");

import { Keypair } from "@solana/web3.js";
import type { CtapError } from "../src/main/hardware/types";
import type { DeviceInfo } from "../src/main/hardware/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sandboxed RP ID — must NOT be "key-wallet.local" (Req 18.2) */
const TEST_RP_ID = "key-wallet-test.local";

const HKDF_INFO = Buffer.from("key-wallet:solana:ed25519:v1", "utf8");

// ---------------------------------------------------------------------------
// Result reporting helpers (Req 18.3, 18.4)
// ---------------------------------------------------------------------------

function pass(step: string, detail?: string): void {
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[PASS] ${step}${suffix}`);
}

/**
 * Classify an error into a human-readable category for structured output.
 * Uses CtapError.code when available; falls back to a generic label.
 */
function errorCategory(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as CtapError).code);
  }
  if (err instanceof TypeError) return "TYPE_ERROR";
  if (err instanceof RangeError) return "RANGE_ERROR";
  return "UNKNOWN";
}

/**
 * Print a structured failure line and return 1 (Req 18.4).
 * Format: [FAIL] <step> | category=<errorCategory> | error=<rawErrorMessage>
 */
function fail(step: string, err: unknown): 1 {
  const cat = errorCategory(err);
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[FAIL] ${step} | category=${cat} | error=${msg}`);
  return 1;
}

// ---------------------------------------------------------------------------
// Main acceptance test sequence (Req 18.1)
// ---------------------------------------------------------------------------

async function runAcceptanceTest(): Promise<number> {
  const provider = new Fido2CliHardwareIdentityProvider();

  // ── Step 1: Device detection ─────────────────────────────────────────────
  const STEP_DETECT = "device-detection";
  let devices: DeviceInfo[] = [];
  try {
    devices = await provider.listDevices();
    if (devices.length === 0) {
      return fail(
        STEP_DETECT,
        new Error("No FIDO2 device detected — plug in your security key and try again."),
      );
    }
    pass(STEP_DETECT, `${devices.length} device(s) found`);
  } catch (err) {
    return fail(STEP_DETECT, err);
  }

  const device = devices[0];
  const devicePath = device.devicePath;

  // ── Step 2: authenticatorGetInfo check ───────────────────────────────────
  const STEP_GET_INFO = "authenticatorGetInfo";
  try {
    if (!device.supportsHmacSecret) {
      return fail(
        STEP_GET_INFO,
        new Error(`Device at ${devicePath} does not support hmac-secret extension.`),
      );
    }
    if (!device.supportsResidentKey) {
      return fail(
        STEP_GET_INFO,
        new Error(`Device at ${devicePath} does not support resident keys.`),
      );
    }
    pass(
      STEP_GET_INFO,
      `hmac-secret=true, resident-key=true, path=${devicePath}`,
    );
  } catch (err) {
    return fail(STEP_GET_INFO, err);
  }

  // ── Step 3: Credential creation with hmac-secret + resident key ──────────
  const STEP_CREATE = "createCredential";
  let credentialId: Uint8Array | null = null;
  try {
    const userId = crypto.randomBytes(16);
    const result = await provider.createCredential(devicePath, {
      rpId: TEST_RP_ID,
      rpName: "KeyWallet Acceptance Test",
      userId,
      userName: "acceptance-test-user",
      userDisplayName: "Acceptance Test User",
      requireResidentKey: true,
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    });

    if (result.authenticatorAttachment !== "cross-platform") {
      return fail(
        STEP_CREATE,
        new Error(
          `Expected authenticatorAttachment "cross-platform", got "${result.authenticatorAttachment}".`,
        ),
      );
    }

    credentialId = result.credentialId;
    pass(STEP_CREATE, "resident key + hmac-secret enrolled");
  } catch (err) {
    return fail(STEP_CREATE, err);
  }

  // ── Step 4: PRF assertion (getAssertion) ─────────────────────────────────
  // hmacOutput is secret — must be zeroed in finally (Req 18.5)
  const STEP_ASSERT = "PRF-assertion";
  let hmacOutput: Uint8Array | null = null;
  try {
    const assertionResult = await provider.getAssertion(devicePath, {
      rpId: TEST_RP_ID,
      credentialId: credentialId!,
      hmacSalt: PRF_SALT_CONSTANT as Uint8Array,
      userVerification: "required",
    });

    if (assertionResult.hmacOutput.byteLength !== 32) {
      return fail(
        STEP_ASSERT,
        new Error(
          `Expected 32-byte PRF_Output, got ${assertionResult.hmacOutput.byteLength} bytes.`,
        ),
      );
    }

    hmacOutput = assertionResult.hmacOutput;
    pass(STEP_ASSERT, "32-byte PRF_Output received");
  } catch (err) {
    return fail(STEP_ASSERT, err);
  }

  // ── Step 5: HKDF derivation ───────────────────────────────────────────────
  // walletSeed is secret — must be zeroed in finally (Req 18.5)
  const STEP_HKDF = "HKDF-derivation";
  const STEP_ADDRESS = "Solana-address-output";
  let walletSeed: Buffer | null = null;
  let walletAddress: string | null = null;
  let base58PublicKey: string | null = null;
  let stepExitCode = 0;

  try {
    // HKDF-SHA256: IKM=PRF_Output, salt=empty, info=constant, len=32 (Req 7.1)
    walletSeed = Buffer.from(
      hkdfSync("sha256", hmacOutput!, Buffer.alloc(0), HKDF_INFO, 32),
    );
    pass(STEP_HKDF, "32-byte wallet seed derived");

    // ── Step 6: Solana address output ─────────────────────────────────────
    // Only publicKey (Base58) is used — secretKey zeroed immediately (Req 18.5)
    const keypair = Keypair.fromSeed(walletSeed);
    walletAddress = keypair.publicKey.toBase58();
    base58PublicKey = walletAddress; // public key == wallet address for Ed25519

    // Zero secretKey immediately — never printed (Req 18.5, 9.3)
    keypair.secretKey.fill(0);

    pass(STEP_ADDRESS, "Ed25519 keypair constructed");
  } catch (err) {
    const failedStep = walletSeed === null ? STEP_HKDF : STEP_ADDRESS;
    fail(failedStep, err);
    stepExitCode = 1;
  } finally {
    // Zero all secret buffers regardless of outcome (Req 9.1, 9.2, 18.5)
    if (hmacOutput !== null) {
      hmacOutput.fill(0);
      hmacOutput = null;
    }
    if (walletSeed !== null) {
      walletSeed.fill(0);
      walletSeed = null;
    }
  }

  if (stepExitCode !== 0) {
    return stepExitCode;
  }

  // ── Full pass output (Req 18.3) ───────────────────────────────────────────
  // Print wallet address and Base58 public key — no secret bytes (Req 18.5)
  console.log("");
  console.log(`Wallet address:    ${walletAddress!}`);
  console.log(`Base58 public key: ${base58PublicKey!}`);

  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runAcceptanceTest()
  .then((code) => {
    if (code === 0) {
      console.log("\n✓ Acceptance test passed — all steps completed successfully.");
    } else {
      console.error("\n✗ Acceptance test FAILED — see [FAIL] lines above.");
    }
    process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FAIL] unexpected-fatal | category=UNKNOWN | error=${msg}`);
    process.exit(2);
  });
