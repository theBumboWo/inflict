#!/usr/bin/env tsx
/**
 * hardware-test.ts — Full enrollment-to-derivation test in a sandboxed namespace.
 *
 * Usage:  npx tsx scripts/hardware-test.ts
 * Exit:   0 = all steps passed, non-zero = one or more steps failed
 *
 * Requirements: 12.2, 18.5
 *
 * Steps executed in sequence:
 *   1. List FIDO2 devices
 *   2. authenticatorGetInfo check (hmac-secret + resident-key support)
 *   3. createCredential with hmac-secret + resident key (rpId = key-wallet-test.local)
 *   4. getAssertion with PRF salt
 *   5. hkdfSync to derive wallet seed
 *   6. Keypair.fromSeed to construct keypair
 *   7. Print wallet address (public key, Base58)
 *
 * Security constraints (Req 18.5):
 *   - PRF_Output, Wallet_Seed, and secretKey bytes are NEVER printed.
 *   - All secret buffers are zeroed in finally blocks.
 */

import * as Module from "module";
import * as path from "path";
import { hkdfSync } from "node:crypto";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Electron app shim — must be registered BEFORE any import of Fido2CliHardwareIdentityProvider
// ---------------------------------------------------------------------------

/**
 * Register a minimal `electron` shim in the Node.js module cache so that
 * Fido2CliHardwareIdentityProvider (which does `import { app } from 'electron'`
 * at the top of the file) can be loaded outside the Electron runtime.
 *
 * The shim exposes only the `app` object with the two fields that getCliDir()
 * uses:
 *   - `isPackaged` → false  (use project root, not process.resourcesPath)
 *   - `getAppPath()` → process.cwd()  (project root when run from workspace)
 */
const electronShim = {
  app: {
    isPackaged: false,
    getAppPath: (): string => process.cwd(),
  },
};

// Resolve the electron module id to a canonical path key used by the cache.
// Because electron is a devDependency, its `main` field points to a real file
// (e.g. node_modules/electron/index.js).  We pre-populate the cache entry for
// that resolved path so any downstream `require('electron')` returns our shim.
const createRequire = Module.createRequire ?? (Module as unknown as { createRequire: typeof Module.createRequire }).createRequire;
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
  // electron is not resolvable in this environment — set up a synthetic entry
  // using the bare specifier as the cache key (covers tsx/ts-node module caches)
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
const { Fido2CliHardwareIdentityProvider } =
  require("../src/main/hardware/Fido2CliHardwareIdentityProvider") as {
    Fido2CliHardwareIdentityProvider: new () => import("../src/main/hardware/IHardwareIdentityProvider").IHardwareIdentityProvider;
  };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PRF_SALT_CONSTANT } =
  require("../src/main/derivation/hkdf") as typeof import("../src/main/derivation/hkdf");

import { Keypair } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sandboxed RP ID — must NOT be "key-wallet.local" (Req 18.2) */
const TEST_RP_ID = "key-wallet-test.local";

const HKDF_INFO = Buffer.from("key-wallet:solana:ed25519:v1", "utf8");

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function pass(step: string): void {
  console.log(`[PASS] ${step}`);
}

function fail(step: string, reason: unknown): void {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[FAIL] ${step}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Main test sequence
// ---------------------------------------------------------------------------

async function runHardwareTest(): Promise<number> {
  const provider = new Fido2CliHardwareIdentityProvider();
  let exitCode = 0;

  // ── Step 1: List devices ──────────────────────────────────────────────────
  let devices: import("../src/main/hardware/types").DeviceInfo[] = [];
  try {
    devices = await provider.listDevices();
    if (devices.length === 0) {
      fail("listDevices", "No FIDO2 device detected — plug in your security key and try again.");
      return 1;
    }
    pass(`listDevices (${devices.length} device(s) found)`);
  } catch (err) {
    fail("listDevices", err);
    return 1;
  }

  const device = devices[0];
  const devicePath = device.devicePath;

  // ── Step 2: authenticatorGetInfo check ───────────────────────────────────
  try {
    if (!device.supportsHmacSecret) {
      fail(
        "authenticatorGetInfo",
        `Device at ${devicePath} does not support hmac-secret extension.`,
      );
      exitCode = 1;
    } else if (!device.supportsResidentKey) {
      fail(
        "authenticatorGetInfo",
        `Device at ${devicePath} does not support resident keys.`,
      );
      exitCode = 1;
    } else {
      pass(
        `authenticatorGetInfo (hmac-secret=true, resident-key=true, path=${devicePath})`,
      );
    }
  } catch (err) {
    fail("authenticatorGetInfo", err);
    exitCode = 1;
  }

  if (exitCode !== 0) {
    return exitCode;
  }

  // ── Step 3: createCredential ──────────────────────────────────────────────
  let credentialId: Uint8Array | null = null;
  try {
    const userId = crypto.randomBytes(16);
    const result = await provider.createCredential(devicePath, {
      rpId: TEST_RP_ID,
      rpName: "KeyWallet Hardware Test",
      userId,
      userName: "hardware-test-user",
      userDisplayName: "Hardware Test User",
      requireResidentKey: true,
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    });

    if (result.authenticatorAttachment !== "cross-platform") {
      fail(
        "createCredential",
        `Expected authenticatorAttachment "cross-platform", got "${result.authenticatorAttachment}".`,
      );
      return 1;
    }

    credentialId = result.credentialId;
    pass("createCredential (resident key + hmac-secret enrolled)");
  } catch (err) {
    fail("createCredential", err);
    return 1;
  }

  // ── Step 4: getAssertion (PRF assertion) ──────────────────────────────────
  // hmacOutput is secret — must be zeroed in finally
  let hmacOutput: Uint8Array | null = null;
  try {
    const assertionResult = await provider.getAssertion(devicePath, {
      rpId: TEST_RP_ID,
      credentialId: credentialId!,
      hmacSalt: PRF_SALT_CONSTANT as Uint8Array,
      userVerification: "required",
    });

    if (assertionResult.hmacOutput.byteLength !== 32) {
      fail(
        "getAssertion",
        `Expected 32-byte hmacOutput, got ${assertionResult.hmacOutput.byteLength} bytes.`,
      );
      return 1;
    }

    hmacOutput = assertionResult.hmacOutput;
    pass("getAssertion (32-byte PRF_Output received)");
  } catch (err) {
    fail("getAssertion", err);
    return 1;
  }

  // ── Steps 5 & 6: hkdfSync + Keypair.fromSeed ─────────────────────────────
  // walletSeed is secret — must be zeroed in finally
  let walletSeed: Buffer | null = null;
  let walletAddress: string | null = null;

  try {
    // Step 5: HKDF-SHA256 — IKM=PRF_Output, salt=empty, info=constant, len=32
    walletSeed = Buffer.from(
      hkdfSync("sha256", hmacOutput!, Buffer.alloc(0), HKDF_INFO, 32),
    );
    pass("hkdfSync (32-byte wallet seed derived)");

    // Step 6: Ed25519 keypair from seed
    const keypair = Keypair.fromSeed(walletSeed);
    walletAddress = keypair.publicKey.toBase58();

    // Zero secretKey immediately — never printed (Req 18.5)
    keypair.secretKey.fill(0);
    pass("Keypair.fromSeed (Ed25519 keypair constructed)");
  } catch (err) {
    fail("hkdfSync / Keypair.fromSeed", err);
    exitCode = 1;
  } finally {
    // Zero all secret buffers regardless of success or failure (Req 9.1, 9.2)
    if (hmacOutput !== null) {
      hmacOutput.fill(0);
      hmacOutput = null;
    }
    if (walletSeed !== null) {
      walletSeed.fill(0);
      walletSeed = null;
    }
  }

  if (exitCode !== 0) {
    return exitCode;
  }

  // ── Step 7: Print wallet address ─────────────────────────────────────────
  // Only the public key (Base58) is printed — no secret bytes (Req 18.5)
  console.log(`\nWallet address: ${walletAddress!}`);
  pass("wallet address derived and displayed");

  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runHardwareTest()
  .then((code) => {
    if (code === 0) {
      console.log("\n✓ All steps passed.");
    } else {
      console.error("\n✗ One or more steps failed.");
    }
    process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FATAL] Unexpected error: ${msg}`);
    process.exit(2);
  });
