// test/integration/hardware-hid.integration.test.ts
//
// SKIPPED — requires a physical FIDO2 hardware security key (e.g. YubiKey 5).
// Never runs in CI.  Run manually to validate real hardware behaviour.
//
// Validates: Req 22.7 (hardware key is the only source of the wallet secret),
//            Req 4.9  (same key + same credential → same wallet address on any machine).
//
// ─────────────────────────────────────────────────────────────────────────────
// MANUAL TEST PROCEDURE
// ─────────────────────────────────────────────────────────────────────────────
//
//  Prerequisites
//  ─────────────
//  1. A YubiKey 5 (any form factor) or equivalent FIDO2 key with hmac-secret
//     support, firmware ≥ 5.2.  The key must have a PIN set.
//  2. The key must NOT already be at credential capacity (check with
//     `ykman fido credentials list`).
//  3. Node.js and all project dependencies installed
//     (`npm ci` from the repo root).
//  4. No other process is holding the HID device open (e.g. a browser tab
//     performing WebAuthn, or a running KeyWallet instance).
//
//  Steps
//  ─────
//  1. Insert the YubiKey into a USB port.
//  2. Run only this test file with:
//
//       npx vitest run test/integration/hardware-hid.integration.test.ts
//
//     The test runner will prompt for your YubiKey PIN via a process-level
//     listener when user verification is required (touch the key when the
//     LED flashes).
//  3. For the "same wallet address" determinism test you will be prompted to
//     touch the key twice.  Both touches must produce identical output.
//
//  Expected outcome
//  ────────────────
//  All six test cases should PASS (green) and print the derived wallet
//  address to stdout.  Verify that the address shown in the terminal matches
//  the address displayed in the KeyWallet UI when the same key is inserted
//  during a normal app session.
//
//  Failure modes & troubleshooting
//  ────────────────────────────────
//  • "No FIDO2 devices found"        → Key is not inserted or driver issue.
//  • "hmac-secret not supported"     → Firmware too old; update firmware.
//  • "PIN required / PIN invalid"    → Incorrect PIN supplied or PIN not set.
//  • "Credential management not …"   → Key does not support CTAP2.1 CM; use a
//                                      different key or skip credential tests.
//  • "No credentials found"          → The key has no resident credential for
//                                      the "key-wallet.local" RP.  Run the
//                                      enrollment test case first.
//  • Wallet address mismatch vs UI   → Check that the UI is using the same key
//                                      and that no browser passkey shadowed the
//                                      hardware credential during enrollment.
//
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { NodeHidHardwareIdentityProvider } from "../../src/main/hardware/NodeHidHardwareIdentityProvider";
import { DerivationService } from "../../src/main/derivation/DerivationService";
import { PRF_SALT_CONSTANT } from "../../src/main/derivation/hkdf";
import type { DeviceInfo, EnrollmentOptions } from "../../src/main/hardware/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The RP ID used by KeyWallet for all CTAP2 operations. */
const RP_ID = "key-wallet.local";

/**
 * A stable, deterministic user ID used only in this integration test.
 * Using a fixed value ensures that re-running the tests finds the same
 * resident credential instead of creating a new one each time.
 */
const TEST_USER_ID = new Uint8Array([
  0x6b, 0x65, 0x79, 0x2d, 0x77, 0x61, 0x6c, 0x6c,
  0x65, 0x74, 0x2d, 0x74, 0x65, 0x73, 0x74, 0x00,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Shared state (populated in beforeAll, used by individual tests)
// ─────────────────────────────────────────────────────────────────────────────

let provider: NodeHidHardwareIdentityProvider;
let derivationService: DerivationService;
let deviceInfo: DeviceInfo;    // The first FIDO2 device found
let credentialId: Uint8Array;  // Credential found or created during the suite

// ─────────────────────────────────────────────────────────────────────────────
// Suite — all tests are skipped; remove `.skip` to run manually
// ─────────────────────────────────────────────────────────────────────────────

describe.skip("Hardware HID integration tests (requires physical YubiKey)", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Setup: instantiate provider and ensure a device is reachable
  // ──────────────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    provider = new NodeHidHardwareIdentityProvider();
    derivationService = new DerivationService(provider);

    // Locate the first connected FIDO2 device — fail fast if none found.
    const devices = await provider.listDevices();
    expect(
      devices.length,
      "No FIDO2 devices found — insert a YubiKey and retry.",
    ).toBeGreaterThan(0);

    deviceInfo = devices[0];

    console.info(
      `[hardware-hid] Using device at ${deviceInfo.devicePath}`,
      `  supportsHmacSecret=${deviceInfo.supportsHmacSecret}`,
      `  supportsResidentKey=${deviceInfo.supportsResidentKey}`,
      `  extensions=${deviceInfo.extensions.join(",")}`,
      `  clientPin=${deviceInfo.clientPin}`,
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 1 — Device is detected
  // ──────────────────────────────────────────────────────────────────────────

  it("detects at least one FIDO2 device connected via HID", async () => {
    // Validates: Req 22.7 — hardware key must be reachable by the application.
    const devices = await provider.listDevices();

    expect(devices.length).toBeGreaterThan(0);

    const device = devices[0];
    expect(typeof device.devicePath).toBe("string");
    expect(device.devicePath.length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2 — FIDO2 is supported by the device
  // ──────────────────────────────────────────────────────────────────────────

  it("reports that the device supports FIDO2 (CTAP2)", async () => {
    // authenticatorGetInfo succeeds if and only if the device speaks CTAP2.
    // A CTAP1-only key would have caused listDevices() to skip it entirely.
    // The presence of the DeviceInfo entry proves CTAP2 is supported.

    expect(deviceInfo).toBeDefined();
    // devicePath is only populated for CTAP2-capable devices
    expect(deviceInfo.devicePath.length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3 — hmac-secret extension is supported
  // ──────────────────────────────────────────────────────────────────────────

  it("reports that the device supports the hmac-secret extension", async () => {
    // Validates: Req 22.7 — the hmac-secret extension is the cryptographic
    // primitive that makes hardware-bound wallet derivation possible.  Without
    // it, the wallet cannot be used with this device.

    expect(
      deviceInfo.supportsHmacSecret,
      `Device at ${deviceInfo.devicePath} does not support hmac-secret. ` +
      "Update the key's firmware or use a different device.",
    ).toBe(true);

    expect(deviceInfo.extensions).toContain("hmac-secret");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4 — Credential found or created for "key-wallet.local"
  // ──────────────────────────────────────────────────────────────────────────

  it("finds an existing credential or creates a new one for RP key-wallet.local", async () => {
    // Validates: Req 22.7 — the application must be able to enroll a resident
    // credential on the hardware key for the wallet's RP ID.

    // Attempt to discover an existing resident credential first.
    const discovery = await provider.discoverCredentials(
      deviceInfo.devicePath,
      RP_ID,
    );

    if (discovery.credentials.length > 0) {
      // Use the first matching credential found on the device.
      credentialId = discovery.credentials[0].credentialId;
      console.info(
        `[hardware-hid] Using existing credential ` +
        `(${credentialId.byteLength} bytes) ` +
        `"${discovery.credentials[0].userDisplayName}"`,
      );
    } else {
      // No credential found — create one.  The user will need to touch the
      // key and may be asked for their PIN.
      console.info(
        "[hardware-hid] No existing credential found — creating a new one. " +
        "Touch your YubiKey when the LED flashes.",
      );

      const enrollmentOptions: EnrollmentOptions = {
        rpId: RP_ID,
        rpName: "KeyWallet",
        userId: TEST_USER_ID,
        userName: "integration-test",
        userDisplayName: "Integration Test",
        requireResidentKey: true,
        userVerification: "required",
        authenticatorAttachment: "cross-platform",
      };

      const result = await provider.createCredential(
        deviceInfo.devicePath,
        enrollmentOptions,
      );

      credentialId = result.credentialId;

      console.info(
        `[hardware-hid] Created new credential (${credentialId.byteLength} bytes). ` +
        `authenticatorAttachment="${result.authenticatorAttachment}"`,
      );

      // Enrollment must produce a cross-platform credential (Req 22.7 / Finding 3).
      expect(result.authenticatorAttachment).toBe("cross-platform");
    }

    // In both cases we must now have a valid credential ID.
    expect(credentialId).toBeDefined();
    expect(credentialId.byteLength).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5 — PRF operation returns exactly 32 bytes
  // ──────────────────────────────────────────────────────────────────────────

  it("PRF (hmac-secret) operation returns exactly 32 bytes", async () => {
    // Validates: Req 22.7 — the 32-byte PRF output is the raw key material
    // that feeds into HKDF.  It must be 32 bytes for HKDF-SHA-256 to operate.
    //
    // Touch your YubiKey when the LED flashes.

    expect(
      credentialId,
      "credentialId must be set — run the credential test case first.",
    ).toBeDefined();

    console.info(
      "[hardware-hid] Running getAssertion (hmac-secret) — touch your YubiKey.",
    );

    const assertionResult = await provider.getAssertion(deviceInfo.devicePath, {
      rpId: RP_ID,
      credentialId,
      hmacSalt: PRF_SALT_CONSTANT as Uint8Array,
      userVerification: "required",
    });

    // The hmac-secret output MUST be exactly 32 bytes (256 bits).
    expect(assertionResult.hmacOutput).toBeInstanceOf(Uint8Array);
    expect(assertionResult.hmacOutput.byteLength).toBe(32);

    // The output must NOT be all-zero (a zeroed buffer would indicate a
    // transport or extension encoding bug).
    const allZero = assertionResult.hmacOutput.every((b) => b === 0);
    expect(allZero).toBe(false);

    console.info(
      "[hardware-hid] PRF output (hex): " +
      Buffer.from(assertionResult.hmacOutput).toString("hex"),
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 6 — Same credential produces the same wallet address on two calls
  // ──────────────────────────────────────────────────────────────────────────

  it("same credential produces the same wallet address on two successive calls", async () => {
    // Validates: Req 4.9 — deterministic derivation.  The core property of
    // the wallet is that the same physical key + same credential always maps
    // to the same Solana public key.  This test calls deriveWallet twice and
    // asserts that both results are identical.
    //
    // You will be asked to touch your YubiKey TWICE.

    expect(
      credentialId,
      "credentialId must be set — run the credential test case first.",
    ).toBeDefined();

    const signal = new AbortController().signal;

    // ── First derivation ──────────────────────────────────────────────────
    console.info(
      "[hardware-hid] First derivation — touch your YubiKey (1/2).",
    );

    const result1 = await derivationService.deriveWallet(
      deviceInfo.devicePath,
      credentialId,
      signal,
    );

    expect(
      result1,
      "First derivation must not return an error object.",
    ).not.toHaveProperty("kind");

    // Type narrowing: if it is an error object the assertion above would have
    // thrown, so we can cast safely.
    const derivation1 = result1 as { walletAddress: string };
    expect(typeof derivation1.walletAddress).toBe("string");
    expect(derivation1.walletAddress.length).toBeGreaterThan(0);

    console.info(`[hardware-hid] Wallet address (call 1): ${derivation1.walletAddress}`);

    // ── Second derivation ────────────────────────────────────────────────
    console.info(
      "[hardware-hid] Second derivation — touch your YubiKey (2/2).",
    );

    const result2 = await derivationService.deriveWallet(
      deviceInfo.devicePath,
      credentialId,
      signal,
    );

    expect(
      result2,
      "Second derivation must not return an error object.",
    ).not.toHaveProperty("kind");

    const derivation2 = result2 as { walletAddress: string };

    console.info(`[hardware-hid] Wallet address (call 2): ${derivation2.walletAddress}`);

    // ── Determinism assertion (Req 4.9) ──────────────────────────────────
    expect(derivation2.walletAddress).toBe(derivation1.walletAddress);

    console.info(
      "\n✅ Determinism confirmed — both calls produced the same wallet address:\n" +
      `   ${derivation1.walletAddress}\n\n` +
      "Verify this address matches what the KeyWallet UI shows when this\n" +
      "YubiKey is inserted during a normal app session.",
    );
  });
});
