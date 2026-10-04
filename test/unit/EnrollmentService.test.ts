// test/unit/EnrollmentService.test.ts
//
// Unit tests for EnrollmentService
// Validates: Requirements 2, 13

import { describe, it, expect, beforeEach } from "vitest";

import {
  EnrollmentService,
  EnrollmentError,
} from "../../src/main/enrollment/EnrollmentService";
import { MockHardwareIdentityProvider } from "../../test/mocks/MockHardwareIdentityProvider";
import type { ICredentialStore, StoredCredentialMetadata } from "../../src/main/storage/CredentialStore";
import type { DeviceInfo, EnrollmentOptions, EnrollmentResult } from "../../src/main/hardware/types";
import { CtapError } from "../../src/main/hardware/types";

// ---------------------------------------------------------------------------
// In-memory ICredentialStore mock
// ---------------------------------------------------------------------------

class InMemoryCredentialStore implements ICredentialStore {
  readonly saved: StoredCredentialMetadata[] = [];

  async save(meta: StoredCredentialMetadata): Promise<void> {
    this.saved.push(meta);
  }

  async findAll(): Promise<StoredCredentialMetadata[]> {
    return [...this.saved];
  }

  async delete(credentialId: string): Promise<void> {
    const idx = this.saved.findIndex((m) => m.credentialId === credentialId);
    if (idx !== -1) {
      this.saved.splice(idx, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Configurable MockHardwareIdentityProvider extensions
// ---------------------------------------------------------------------------

const DEVICE_PATH = "mock://device/1";

/** Extends mock to support overriding the returned authenticatorAttachment. */
class ConfigurableMockProvider extends MockHardwareIdentityProvider {
  private _attachmentOverride: string | null = null;
  private _createCredentialError: Error | null = null;
  private _clientPinOverride: boolean | undefined = undefined;
  private _useClientPinOverride = false;

  /**
   * When set, createCredential will return this value for authenticatorAttachment
   * (e.g., "platform" to simulate a platform authenticator response).
   */
  setAuthenticatorAttachmentOverride(attachment: string): void {
    this._attachmentOverride = attachment;
  }

  /**
   * When set, createCredential will throw this error instead of returning a result.
   */
  setCreateCredentialError(err: Error): void {
    this._createCredentialError = err;
  }

  /**
   * When set, listDevices will return a device with this clientPin value.
   * Pass `false` to simulate a device with no PIN set.
   */
  setClientPin(clientPin: boolean): void {
    this._clientPinOverride = clientPin;
    this._useClientPinOverride = true;
  }

  override async listDevices(): Promise<DeviceInfo[]> {
    const devices = await super.listDevices();
    if (!this._useClientPinOverride) {
      return devices;
    }
    // Override clientPin on the matching device
    return devices.map((d) =>
      d.devicePath === DEVICE_PATH
        ? { ...d, clientPin: this._clientPinOverride }
        : d,
    );
  }

  override async createCredential(
    devicePath: string,
    options: EnrollmentOptions,
  ): Promise<EnrollmentResult> {
    if (this._createCredentialError) {
      throw this._createCredentialError;
    }
    const result = await super.createCredential(devicePath, options);
    if (this._attachmentOverride !== null) {
      return { ...result, authenticatorAttachment: this._attachmentOverride };
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a non-aborted AbortSignal. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Returns an already-aborted AbortSignal. */
function abortedSignal(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EnrollmentService", () => {
  let provider: ConfigurableMockProvider;
  let store: InMemoryCredentialStore;
  let service: EnrollmentService;

  beforeEach(() => {
    provider = new ConfigurableMockProvider();
    store = new InMemoryCredentialStore();
    service = new EnrollmentService(provider, store);
  });

  // -------------------------------------------------------------------------
  // 1. Platform attachment rejection (Req 13.2, 13.3)
  // -------------------------------------------------------------------------
  describe("platform attachment rejection", () => {
    it('throws EnrollmentError with category "enrollment-failed" when authenticatorAttachment is "platform"', async () => {
      provider.setAuthenticatorAttachmentOverride("platform");
      // Ensure clientPin check passes (undefined → not false → proceeds)
      const ac = new AbortController();

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", ac.signal),
      ).rejects.toThrow(EnrollmentError);

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", liveSignal()),
      ).rejects.toMatchObject({
        category: "enrollment-failed",
      });
    });

    it("does NOT persist metadata when a platform attachment is detected", async () => {
      provider.setAuthenticatorAttachmentOverride("platform");

      try {
        await service.enroll(DEVICE_PATH, "Test Key", liveSignal());
      } catch {
        // expected
      }

      expect(store.saved).toHaveLength(0);
    });

    it("succeeds and does NOT throw when authenticatorAttachment is cross-platform", async () => {
      // Default mock returns "cross-platform" — no override needed.
      const result = await service.enroll(DEVICE_PATH, "My Key", liveSignal());
      expect(result.credentialId).toBeInstanceOf(Uint8Array);
      expect(result.credentialId).toHaveLength(32);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Abort on timeout clears partial state (Req 2.11)
  // -------------------------------------------------------------------------
  describe("abort / timeout handling", () => {
    it('throws EnrollmentError with category "enrollment-failed" when AbortSignal is already aborted', async () => {
      const signal = abortedSignal();

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", signal),
      ).rejects.toMatchObject({
        name: "EnrollmentError",
        category: "enrollment-failed",
      });
    });

    it("does NOT persist metadata when enrollment is aborted before it starts", async () => {
      const signal = abortedSignal();

      try {
        await service.enroll(DEVICE_PATH, "Test Key", signal);
      } catch {
        // expected
      }

      expect(store.saved).toHaveLength(0);
    });

    it("aborts enrollment when AbortController.abort() is called on the signal", async () => {
      const ac = new AbortController();
      ac.abort();

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", ac.signal),
      ).rejects.toBeInstanceOf(EnrollmentError);

      expect(store.saved).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. CTAP2_ERR_KEY_STORE_FULL surfaces correct error category (Req 2.7)
  // -------------------------------------------------------------------------
  describe("CTAP2_ERR_KEY_STORE_FULL", () => {
    it('maps CTAP2_ERR_KEY_STORE_FULL to EnrollmentError with category "storage-full"', async () => {
      provider.setCreateCredentialError(
        new CtapError(
          "CTAP2_ERR_KEY_STORE_FULL",
          "Device credential storage is full.",
        ),
      );

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", liveSignal()),
      ).rejects.toMatchObject({
        name: "EnrollmentError",
        category: "storage-full",
      });
    });

    it("does NOT persist metadata when CTAP2_ERR_KEY_STORE_FULL is thrown", async () => {
      provider.setCreateCredentialError(
        new CtapError(
          "CTAP2_ERR_KEY_STORE_FULL",
          "Device credential storage is full.",
        ),
      );

      try {
        await service.enroll(DEVICE_PATH, "Test Key", liveSignal());
      } catch {
        // expected
      }

      expect(store.saved).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. PIN-not-set surfaces "pin-required" error (Req 2.10)
  // -------------------------------------------------------------------------
  describe("PIN check", () => {
    it('throws EnrollmentError with category "pin-required" when clientPin is false', async () => {
      provider.setClientPin(false);

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", liveSignal()),
      ).rejects.toMatchObject({
        name: "EnrollmentError",
        category: "pin-required",
      });
    });

    it("proceeds with enrollment when clientPin is true", async () => {
      provider.setClientPin(true);

      const result = await service.enroll(DEVICE_PATH, "My Key", liveSignal());
      expect(result.credentialId).toBeInstanceOf(Uint8Array);
    });

    it("proceeds with enrollment when clientPin is undefined (device does not report it)", async () => {
      // Default mock has no clientPin — enrollment should proceed.
      const result = await service.enroll(DEVICE_PATH, "My Key", liveSignal());
      expect(result.credentialId).toBeInstanceOf(Uint8Array);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Successful enrollment stores metadata via ICredentialStore (Req 2.8)
  // -------------------------------------------------------------------------
  describe("successful enrollment", () => {
    it("stores exactly one metadata entry in the credential store", async () => {
      await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());

      expect(store.saved).toHaveLength(1);
    });

    it("stores the correct rpId and displayName", async () => {
      await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());

      const entry = store.saved[0];
      expect(entry.rpId).toBe("key-wallet.local");
      expect(entry.displayName).toBe("My YubiKey");
    });

    it("stores credentialId as a hex string", async () => {
      await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());

      const entry = store.saved[0];
      // A hex string for a 32-byte value is 64 characters, all lowercase hex digits.
      expect(entry.credentialId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("stores a valid ISO 8601 createdAt timestamp", async () => {
      const before = new Date().toISOString();
      await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());
      const after = new Date().toISOString();

      const entry = store.saved[0];
      expect(entry.createdAt >= before).toBe(true);
      expect(entry.createdAt <= after).toBe(true);
    });

    it("returns a 32-byte credentialId Uint8Array", async () => {
      const result = await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());

      expect(result.credentialId).toBeInstanceOf(Uint8Array);
      expect(result.credentialId).toHaveLength(32);
    });

    it("stored credentialId hex matches the returned credentialId bytes", async () => {
      const result = await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());

      const entry = store.saved[0];
      const expectedHex = Buffer.from(result.credentialId).toString("hex");
      expect(entry.credentialId).toBe(expectedHex);
    });

    it("does NOT store any secret material (no prf_output, wallet_seed)", async () => {
      await service.enroll(DEVICE_PATH, "My YubiKey", liveSignal());

      const entry = store.saved[0];
      const keys = Object.keys(entry);
      // Only these four keys should be present
      expect(keys.sort()).toEqual(
        ["credentialId", "createdAt", "displayName", "rpId"].sort(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Other CTAP2 error mappings
  // -------------------------------------------------------------------------
  describe("CTAP2 error mapping", () => {
    it('maps CTAP2_ERR_PIN_INVALID to "pin-required"', async () => {
      provider.setCreateCredentialError(
        new CtapError("CTAP2_ERR_PIN_INVALID", "PIN is incorrect."),
      );

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", liveSignal()),
      ).rejects.toMatchObject({
        category: "pin-required",
      });
    });

    it('maps CTAP2_ERR_PIN_BLOCKED to "pin-locked"', async () => {
      provider.setCreateCredentialError(
        new CtapError("CTAP2_ERR_PIN_BLOCKED", "PIN is blocked."),
      );

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", liveSignal()),
      ).rejects.toMatchObject({
        category: "pin-locked",
      });
    });

    it('maps CTAP2_ERR_OPERATION_DENIED to "enrollment-failed"', async () => {
      provider.setCreateCredentialError(
        new CtapError("CTAP2_ERR_OPERATION_DENIED", "Operation denied."),
      );

      await expect(
        service.enroll(DEVICE_PATH, "Test Key", liveSignal()),
      ).rejects.toMatchObject({
        category: "enrollment-failed",
      });
    });
  });
});
