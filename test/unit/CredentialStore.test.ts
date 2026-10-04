import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { CredentialStore, StoredCredentialMetadata } from "../../src/main/storage/CredentialStore";

// Helper to build a unique temp directory path for each test
let tempDir: string;
let store: CredentialStore;

const makeCredential = (overrides: Partial<StoredCredentialMetadata> = {}): StoredCredentialMetadata => ({
  credentialId: "deadbeef01",
  rpId: "key-wallet.local",
  displayName: "Test Wallet",
  createdAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

describe("CredentialStore", () => {
  beforeEach(() => {
    // Each test gets a unique subdirectory name so tests are fully isolated
    tempDir = join(tmpdir(), `credential-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = new CredentialStore(join(tempDir, "credentials.json"));
  });

  afterEach(async () => {
    // Clean up the temp directory created for each test
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("findAll", () => {
    it("returns an empty array when the storage file does not exist", async () => {
      // tempDir was never created, so the file cannot exist
      const result = await store.findAll();
      expect(result).toEqual([]);
    });
  });

  describe("save + findAll round-trip", () => {
    it("persists a single credential and returns it via findAll", async () => {
      const cred = makeCredential();

      await store.save(cred);
      const result = await store.findAll();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(cred);
    });

    it("accumulates multiple saves and returns all entries", async () => {
      const cred1 = makeCredential({ credentialId: "aabbcc01", displayName: "Wallet A" });
      const cred2 = makeCredential({ credentialId: "ddeeff02", displayName: "Wallet B" });

      await store.save(cred1);
      await store.save(cred2);
      const result = await store.findAll();

      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining([cred1, cred2]));
    });
  });

  describe("delete", () => {
    it("removes exactly the entry with the matching credentialId", async () => {
      const cred1 = makeCredential({ credentialId: "aabbcc01", displayName: "Wallet A" });
      const cred2 = makeCredential({ credentialId: "ddeeff02", displayName: "Wallet B" });

      await store.save(cred1);
      await store.save(cred2);

      await store.delete("aabbcc01");
      const result = await store.findAll();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(cred2);
    });

    it("is a no-op when the credentialId does not exist", async () => {
      const cred = makeCredential();
      await store.save(cred);

      await store.delete("nonexistent");
      const result = await store.findAll();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(cred);
    });
  });

  describe("disk persistence", () => {
    it("writes a JSON file with version 1 and a credentials array", async () => {
      const cred = makeCredential();
      await store.save(cred);

      const raw = await readFile(join(tempDir, "credentials.json"), "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed).toMatchObject({
        version: 1,
        credentials: [cred],
      });
    });
  });
});
