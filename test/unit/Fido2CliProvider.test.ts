// test/unit/Fido2CliProvider.test.ts
//
// Unit tests for Fido2CliHardwareIdentityProvider — CLI stdin/stdout format,
// path resolution, and subprocess environment.
//
// All tests use a childProcess.spawn stub — the real subprocess is never invoked.
//
// Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";

// ---------------------------------------------------------------------------
// Hoist shared mutable state so vi.mock factories can reference it.
// vi.mock() calls are hoisted to the top of the file by vitest; any variable
// they reference must also be hoisted with vi.hoisted().
// ---------------------------------------------------------------------------
const { spawnMock, mockApp, tempFileCapture } = vi.hoisted(() => {
  const spawnMock = vi.fn();

  const mockApp = {
    isPackaged: false as boolean,
    getAppPath: vi.fn(() => "/project"),
  };

  const tempFileCapture = {
    content: null as string | null,
  };

  return { spawnMock, mockApp, tempFileCapture };
});

// ---------------------------------------------------------------------------
// Mock electron BEFORE importing the module under test.
// ---------------------------------------------------------------------------
vi.mock("electron", () => ({
  app: mockApp,
}));

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// spawnCli calls childProcess.spawn; we intercept it here.
// ---------------------------------------------------------------------------
vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

// ---------------------------------------------------------------------------
// Mock fs to capture temp file content (the CLI provider uses -i <tmpFile>
// rather than piped stdin, so the stdin payload lives in a temp file).
// existsSync is mocked to return true so the CLI existence check never blocks
// the spawn mock from running.
// ---------------------------------------------------------------------------
vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn((filePath: unknown, content: unknown) => {
      tempFileCapture.content = content as string;
      // Write the actual file so -i <path> resolves on disk.
      original.writeFileSync(
        filePath as string,
        content as string | Buffer,
        { encoding: "utf8", mode: 0o600 },
      );
    }),
    unlinkSync: vi.fn(() => {
      // suppress deletion in tests
    }),
  };
});

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are declared.
// ---------------------------------------------------------------------------
import { Fido2CliHardwareIdentityProvider } from "../../src/main/hardware/Fido2CliHardwareIdentityProvider";
import { CtapError } from "../../src/main/hardware/types";
import type { EnrollmentOptions, AssertionOptions } from "../../src/main/hardware/types";

// ---------------------------------------------------------------------------
// Fake ChildProcess factory
// ---------------------------------------------------------------------------

/** Captured args from the most recent spawn() call. */
let capturedSpawnArgs: {
  exePath: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; [key: string]: unknown };
} | null = null;

/** Builds a fake ChildProcess that emits stdout then closes. */
function makeFakeChild(stdoutPayload: string, exitCode = 0) {
  const fakeChild = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };

  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.stdin = { write: vi.fn(), end: vi.fn() };
  fakeChild.kill = vi.fn();

  // Emit asynchronously so promise handlers can attach first.
  Promise.resolve().then(() => {
    if (stdoutPayload) {
      fakeChild.stdout.emit("data", Buffer.from(stdoutPayload, "utf8"));
    }
    fakeChild.emit("close", exitCode);
  });

  return fakeChild;
}

/** Configures spawnMock to capture args and return the given stdout. */
function setupSpawnMock(stdoutPayload: string, exitCode = 0) {
  capturedSpawnArgs = null;
  tempFileCapture.content = null;
  spawnMock.mockImplementation((exePath: string, args: string[], options: unknown) => {
    capturedSpawnArgs = {
      exePath,
      args,
      options: options as { env?: NodeJS.ProcessEnv; [key: string]: unknown },
    };
    return makeFakeChild(stdoutPayload, exitCode);
  });
}

// ---------------------------------------------------------------------------
// Stdout payload helpers
// ---------------------------------------------------------------------------

function makeFido2CredStdout(credIdB64 = "dGVzdGNyZWRpZA==") {
  // [0]=clientDataHash [1]=rpId [2]=format [3]=authData [4]=credId [5]=sig
  return [
    "aGFzaA==",
    "key-wallet.local",
    "packed",
    "YXV0aERhdGE=",
    credIdB64,
    "c2lnbmF0dXJl",
  ].join("\n") + "\n";
}

function makeFido2AssertStdout6Lines(
  hmacB64 = Buffer.from(new Uint8Array(32).fill(0xaa)).toString("base64"),
) {
  // [0]=clientDataHash [1]=rpId [2]=authData [3]=sig [4]=userId [5]=hmacSecret
  return [
    "aGFzaA==",
    "key-wallet.local",
    "YXV0aERhdGE=",
    "c2lnbmF0dXJl",
    "dXNlcklk",
    hmacB64,
  ].join("\n") + "\n";
}

function makeFido2AssertStdout5Lines(
  hmacB64 = Buffer.from(new Uint8Array(32).fill(0xbb)).toString("base64"),
) {
  // [0]=clientDataHash [1]=rpId [2]=authData [3]=sig [4]=hmacSecret
  return [
    "aGFzaA==",
    "key-wallet.local",
    "YXV0aERhdGE=",
    "c2lnbmF0dXJl",
    hmacB64,
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Option factories
// ---------------------------------------------------------------------------

function makeEnrollmentOptions(overrides?: Partial<EnrollmentOptions>): EnrollmentOptions {
  return {
    rpId: "key-wallet.local",
    rpName: "KeyWallet",
    userId: new Uint8Array([1, 2, 3, 4]),
    userName: "alice",
    userDisplayName: "Alice",
    requireResidentKey: true,
    userVerification: "required",
    authenticatorAttachment: "cross-platform",
    ...overrides,
  };
}

function makeAssertionOptions(overrides?: Partial<AssertionOptions>): AssertionOptions {
  return {
    rpId: "key-wallet.local",
    credentialId: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
    hmacSalt: new Uint8Array(32).fill(0x42),
    userVerification: "required",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Fido2CliHardwareIdentityProvider", () => {
  let provider: Fido2CliHardwareIdentityProvider;

  beforeEach(() => {
    capturedSpawnArgs = null;
    tempFileCapture.content = null;
    mockApp.isPackaged = false;
    mockApp.getAppPath.mockReturnValue("/project");
    // Remove resourcesPath if set from a previous test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (process as any).resourcesPath;
    provider = new Fido2CliHardwareIdentityProvider();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1 ──────────────────────────────────────────────────────────────
  it("Test 1: createCredential() stdin line order is [clientData, rpId, userName, userIdB64]", async () => {
    setupSpawnMock(makeFido2CredStdout());
    const opts = makeEnrollmentOptions({
      userName: "bob",
      userId: new Uint8Array([0x10, 0x20, 0x30, 0x40]),
    });

    await provider.createCredential("windows://hello", opts);

    expect(tempFileCapture.content).not.toBeNull();
    const lines = tempFileCapture.content!.split("\n").filter((l) => l.trim() !== "");

    // [0] clientData — non-empty base64
    expect(lines[0]).toBeTruthy();
    // [1] rpId
    expect(lines[1]).toBe("key-wallet.local");
    // [2] userName — NOT userId
    expect(lines[2]).toBe("bob");
    // [3] userIdBase64
    const expectedUserIdB64 = Buffer.from(new Uint8Array([0x10, 0x20, 0x30, 0x40])).toString("base64");
    expect(lines[3]).toBe(expectedUserIdB64);
  });

  // ─── Test 2 ──────────────────────────────────────────────────────────────
  it("Test 2: createCredential() reads credentialId from stdout line index 4", async () => {
    const knownCred = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const knownCredB64 = Buffer.from(knownCred).toString("base64");
    setupSpawnMock(makeFido2CredStdout(knownCredB64));

    const result = await provider.createCredential("windows://hello", makeEnrollmentOptions());

    expect(result.credentialId).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.credentialId)).toEqual(Buffer.from(knownCred));
  });

  // ─── Test 3 ──────────────────────────────────────────────────────────────
  it("Test 3: createCredential() throws CtapError('UNKNOWN') when stdout has fewer than 5 lines", async () => {
    const variants = [
      "",                                     // 0 lines
      "line0\n",                              // 1 line
      "line0\nline1\n",                       // 2 lines
      "line0\nline1\nline2\n",               // 3 lines
      "line0\nline1\nline2\nline3\n",         // 4 lines
    ];

    for (const stdout of variants) {
      setupSpawnMock(stdout);
      await expect(
        provider.createCredential("windows://hello", makeEnrollmentOptions()),
      ).rejects.toSatisfy((err: unknown) => {
        return err instanceof CtapError && err.code === "UNKNOWN";
      });
    }
  });

  // ─── Test 4 ──────────────────────────────────────────────────────────────
  it("Test 4: getAssertion() stdin line order is [clientData, rpId, credIdB64, hmacSaltB64]", async () => {
    setupSpawnMock(makeFido2AssertStdout6Lines());
    const credId = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const hmacSalt = new Uint8Array(32).fill(0x77);

    await provider.getAssertion("windows://hello", makeAssertionOptions({ credentialId: credId, hmacSalt }));

    expect(tempFileCapture.content).not.toBeNull();
    const lines = tempFileCapture.content!.split("\n").filter((l) => l.trim() !== "");

    // [0] clientData — non-empty base64
    expect(lines[0]).toBeTruthy();
    // [1] rpId
    expect(lines[1]).toBe("key-wallet.local");
    // [2] credentialIdBase64
    expect(lines[2]).toBe(Buffer.from(credId).toString("base64"));
    // [3] hmacSaltBase64
    expect(lines[3]).toBe(Buffer.from(hmacSalt).toString("base64"));
  });

  // ─── Test 5 ──────────────────────────────────────────────────────────────
  it("Test 5: getAssertion() reads hmacSecret from line index 5 when stdout has 6 lines", async () => {
    const expectedHmac = new Uint8Array(32).fill(0xcc);
    setupSpawnMock(makeFido2AssertStdout6Lines(Buffer.from(expectedHmac).toString("base64")));

    const result = await provider.getAssertion("windows://hello", makeAssertionOptions());

    expect(result.hmacOutput).toBeInstanceOf(Uint8Array);
    expect(result.hmacOutput.length).toBe(32);
    expect(Buffer.from(result.hmacOutput)).toEqual(Buffer.from(expectedHmac));
  });

  // ─── Test 6 ──────────────────────────────────────────────────────────────
  it("Test 6: getAssertion() reads hmacSecret from line index 4 when stdout has 5 lines", async () => {
    const expectedHmac = new Uint8Array(32).fill(0xdd);
    setupSpawnMock(makeFido2AssertStdout5Lines(Buffer.from(expectedHmac).toString("base64")));

    const result = await provider.getAssertion("windows://hello", makeAssertionOptions());

    expect(result.hmacOutput).toBeInstanceOf(Uint8Array);
    expect(result.hmacOutput.length).toBe(32);
    expect(Buffer.from(result.hmacOutput)).toEqual(Buffer.from(expectedHmac));
  });

  // ─── Test 7 ──────────────────────────────────────────────────────────────
  it("Test 7: getAssertion() throws CtapError('UNKNOWN') and includes actual length when hmac is not 32 bytes", async () => {
    // 16-byte value encoded as base64
    const shortHmacB64 = Buffer.from(new Uint8Array(16).fill(0xee)).toString("base64");
    // Put the short hmac at line[5] of a 6-line output
    const stdout = [
      "aGFzaA==",
      "key-wallet.local",
      "YXV0aERhdGE=",
      "c2lnbmF0dXJl",
      "dXNlcklk",
      shortHmacB64,
    ].join("\n") + "\n";

    setupSpawnMock(stdout);

    let thrown: unknown = undefined;
    try {
      await provider.getAssertion("windows://hello", makeAssertionOptions());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CtapError);
    expect((thrown as CtapError).code).toBe("UNKNOWN");
    // Error detail must mention the actual byte length (16)
    expect((thrown as CtapError).message).toContain("16");
  });

  // ─── Test 8 ──────────────────────────────────────────────────────────────
  it("Test 8: discoverCredentials() never calls spawnCli; returns { credentials: [] }", async () => {
    // Make spawn throw if called — ensures discoverCredentials doesn't touch it.
    spawnMock.mockImplementation(() => {
      throw new Error("spawn must NOT be called by discoverCredentials");
    });

    const result = await provider.discoverCredentials("windows://hello", "key-wallet.local");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toEqual({ credentials: [] });
  });

  // ─── Test 9 ──────────────────────────────────────────────────────────────
  it("Test 9: 'es256' positional argument is present in fido2-cred args array", async () => {
    setupSpawnMock(makeFido2CredStdout());

    await provider.createCredential("windows://hello", makeEnrollmentOptions());

    expect(capturedSpawnArgs).not.toBeNull();
    expect(capturedSpawnArgs!.args).toContain("es256");
  });

  // ─── Test 10 ─────────────────────────────────────────────────────────────
  it("Test 10: path resolution dev mode — resolved path contains getAppPath() and libfido2 suffix", async () => {
    const appRoot = path.join("C:", "project");          // OS-native path
    mockApp.isPackaged = false;
    mockApp.getAppPath.mockReturnValue(appRoot);
    provider = new Fido2CliHardwareIdentityProvider(); // re-create with fresh app state

    setupSpawnMock(makeFido2CredStdout());
    await provider.createCredential("windows://hello", makeEnrollmentOptions());

    expect(capturedSpawnArgs).not.toBeNull();
    const exePath = capturedSpawnArgs!.exePath;
    // exePath must be rooted at appRoot
    expect(exePath).toContain(appRoot);
    // Must include the libfido2 relative suffix
    expect(exePath).toContain("libfido2-win");
    expect(exePath).toContain(
      path.join("libfido2-1.15.0-win", "Win64", "Release", "v143", "dynamic"),
    );
  });

  // ─── Test 11 ─────────────────────────────────────────────────────────────
  it("Test 11: path resolution packaged mode — resolved path contains process.resourcesPath", async () => {
    const resourcesRoot = path.join("C:", "app", "resources"); // OS-native path
    mockApp.isPackaged = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).resourcesPath = resourcesRoot;
    provider = new Fido2CliHardwareIdentityProvider(); // re-create with packaged state

    setupSpawnMock(makeFido2CredStdout());
    await provider.createCredential("windows://hello", makeEnrollmentOptions());

    expect(capturedSpawnArgs).not.toBeNull();
    const exePath = capturedSpawnArgs!.exePath;
    expect(exePath).toContain(resourcesRoot);
    // Must NOT be rooted at the dev-mode appRoot
    const appRoot = path.join("C:", "project");
    expect(exePath).not.toContain(appRoot);
  });

  // ─── Test 12 ─────────────────────────────────────────────────────────────
  it("Test 12: child process PATH starts with the resolved cliDir", async () => {
    const appRoot = path.join("C:", "project");
    mockApp.isPackaged = false;
    mockApp.getAppPath.mockReturnValue(appRoot);
    provider = new Fido2CliHardwareIdentityProvider();

    setupSpawnMock(makeFido2CredStdout());
    await provider.createCredential("windows://hello", makeEnrollmentOptions());

    expect(capturedSpawnArgs).not.toBeNull();
    const childPath = capturedSpawnArgs!.options.env?.PATH ?? "";
    const expectedCliDir = path.join(
      appRoot,
      "libfido2-win",
      "libfido2-1.15.0-win",
      "Win64",
      "Release",
      "v143",
      "dynamic",
    );
    expect(childPath.startsWith(expectedCliDir)).toBe(true);
  });
});
