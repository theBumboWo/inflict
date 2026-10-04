import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

/**
 * Only non-secret metadata is stored.
 * NEVER stores PRF_Output, Wallet_Seed, private key bytes, or any intermediate derivation value.
 */
export interface StoredCredentialMetadata {
  credentialId: string; // hex-encoded bytes
  rpId: string; // "key-wallet.local"
  displayName: string;
  createdAt: string; // ISO 8601
}

export interface ICredentialStore {
  save(meta: StoredCredentialMetadata): Promise<void>;
  findAll(): Promise<StoredCredentialMetadata[]>;
  delete(credentialId: string): Promise<void>;
}

interface StorageFile {
  version: 1;
  credentials: StoredCredentialMetadata[];
}

const EMPTY_STORAGE: StorageFile = { version: 1, credentials: [] };

export class CredentialStore implements ICredentialStore {
  constructor(private readonly filePath: string) {}

  /**
   * Reads the current file, or returns an empty structure if the file is missing.
   */
  private async read(): Promise<StorageFile> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as StorageFile;
      // Basic shape guard — if file is malformed, treat as empty
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.credentials)
      ) {
        return { ...EMPTY_STORAGE, credentials: [] };
      }
      return parsed;
    } catch (err: unknown) {
      // File does not exist (ENOENT) or is unreadable — return empty structure
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { ...EMPTY_STORAGE, credentials: [] };
      }
      throw err;
    }
  }

  /**
   * Writes the given storage structure to disk, creating the directory if needed.
   */
  private async write(storage: StorageFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(storage, null, 2), "utf-8");
  }

  /**
   * Appends a new credential metadata entry to the store.
   * The `credentialId` must already be a hex string.
   */
  async save(meta: StoredCredentialMetadata): Promise<void> {
    const storage = await this.read();
    storage.credentials.push(meta);
    await this.write(storage);
  }

  /**
   * Returns all stored credential metadata entries.
   * Returns an empty array if the file does not exist.
   */
  async findAll(): Promise<StoredCredentialMetadata[]> {
    const storage = await this.read();
    return storage.credentials;
  }

  /**
   * Removes the entry with the matching `credentialId` and rewrites the file.
   * Does nothing if the file does not exist or the id is not found.
   * Auto-delete on mismatch is explicitly NOT performed — callers must invoke this method.
   */
  async delete(credentialId: string): Promise<void> {
    const storage = await this.read();
    const before = storage.credentials.length;
    storage.credentials = storage.credentials.filter(
      (c) => c.credentialId !== credentialId,
    );
    // Only rewrite if something changed (avoids unnecessary disk writes)
    if (storage.credentials.length !== before) {
      await this.write(storage);
    }
  }
}

/** Minimal structural type covering the Electron.App surface used here. */
interface ElectronAppLike {
  getPath(name: "userData" | string): string;
}

/**
 * Factory for use in the main process.
 * Wires the store to `{app.getPath("userData")}/credentials.json`.
 */
export function createCredentialStore(app: ElectronAppLike): CredentialStore {
  const filePath = path.join(app.getPath("userData"), "credentials.json");
  return new CredentialStore(filePath);
}
