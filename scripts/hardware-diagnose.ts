/**
 * hardware-diagnose.ts
 *
 * Diagnostic script for FIDO2 hardware detection.
 *
 * Reports the connected FIDO2 devices (path, extensions, hmac-secret flag,
 * resident-key flag, clientPin flag) and verifies that the bundled libfido2
 * CLI tools can be found at their resolved path.  Does NOT perform any PRF
 * derivation or modify any stored credentials.
 *
 * Usage:
 *   npx tsx scripts/hardware-diagnose.ts
 *   # or, once task 3.5 adds the npm script:
 *   npm run hardware:diagnose
 *
 * Exit codes:
 *   0 — at least one FIDO2 device detected and fido2-assert.exe found
 *   1 — no device detected, or fido2-assert.exe missing
 *
 * Requirements: 12.1, 12.4, 12.5
 */

import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Electron app shim
//
// NodeHidHardwareIdentityProvider and Fido2CliHardwareIdentityProvider both
// import `app` from "electron".  In a plain Node.js script context there is no
// Electron runtime, so we register a minimal shim in the module cache before
// importing the hardware providers.
// ---------------------------------------------------------------------------

const APP_SHIM = {
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
};

// Register the shim under the "electron" key before any downstream require().
// The CJS module cache is keyed by resolved file paths, not bare specifiers.
// We need to find what path require.resolve("electron") returns, then inject
// our shim at that key.  We also inject under the bare "electron" key as a
// fallback for ESM-compiled paths.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const CjsModule = require("module") as typeof import("module") & {
  new (id: string, parent?: NodeModule | null): NodeModule & { exports: unknown; loaded: boolean; filename: string };
  _cache: Record<string, NodeModule & { exports: unknown; loaded: boolean; filename: string }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleCache = (CjsModule as any)._cache as Record<string, any>;

// Resolve the electron package's actual entry-point path so we can replace it
// in the CJS cache with our shim.
let electronResolvedPath = "electron";
try {
  electronResolvedPath = require.resolve("electron");
} catch {
  // electron may not be on the path in certain environments; fall back to bare key
}

// Build a synthetic Module entry that mimics what require("electron") returns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronShimModule: any = new (CjsModule as any)(electronResolvedPath, module);
electronShimModule.exports = APP_SHIM;
electronShimModule.loaded = true;
electronShimModule.filename = electronResolvedPath;
// Register under both the resolved path and the bare "electron" name.
moduleCache[electronResolvedPath] = electronShimModule;
moduleCache["electron"] = electronShimModule;

// ---------------------------------------------------------------------------
// Import hardware provider (after shim is installed)
// ---------------------------------------------------------------------------

// We use require() so the shim above is already in the cache when the module
// system resolves "electron" inside NodeHidHardwareIdentityProvider.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { NodeHidHardwareIdentityProvider } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/main/hardware/NodeHidHardwareIdentityProvider") as typeof import("../src/main/hardware/NodeHidHardwareIdentityProvider");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the resolved path to fido2-assert.exe using the same logic as
 * Fido2CliHardwareIdentityProvider (dev mode: app.getAppPath() = process.cwd()).
 */
function resolveAssertExePath(): string {
  const cliDir = path.join(
    process.cwd(),
    "libfido2-win",
    "libfido2-1.15.0-win",
    "Win64",
    "Release",
    "v143",
    "dynamic",
  );
  return path.join(cliDir, "fido2-assert.exe");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── 1. Check fido2-assert.exe exists ──────────────────────────────────────
  const assertExePath = resolveAssertExePath();
  if (!fs.existsSync(assertExePath)) {
    console.error(`fido2-assert.exe not found at: ${assertExePath}`);
    process.exit(1);
  }
  console.log(`fido2-assert.exe found at: ${assertExePath}`);

  // ── 2. List FIDO2 devices ─────────────────────────────────────────────────
  const provider = new NodeHidHardwareIdentityProvider();

  let devices;
  try {
    devices = await provider.listDevices();
  } catch (err) {
    console.error("Failed to list FIDO2 devices:", err);
    process.exit(1);
  }

  // ── 3. Report results ─────────────────────────────────────────────────────
  if (devices.length === 0) {
    console.log("No FIDO2 device detected");
    process.exit(1);
  }

  console.log(`\nFound ${devices.length} FIDO2 device(s):\n`);
  for (const device of devices) {
    console.log(`  Device path   : ${device.devicePath}`);
    console.log(
      `  Extensions    : ${device.extensions.length > 0 ? device.extensions.join(", ") : "(none)"}`,
    );
    console.log(
      `  hmac-secret   : ${device.supportsHmacSecret ? "supported" : "not supported"}`,
    );
    console.log(
      `  Resident key  : ${device.supportsResidentKey ? "supported" : "not supported"}`,
    );
    console.log(
      `  clientPin     : ${device.clientPin === undefined ? "not reported" : device.clientPin ? "set" : "not set"}`,
    );
    console.log();
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
