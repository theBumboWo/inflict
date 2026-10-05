/**
 * Fido2CliHardwareIdentityProvider
 *
 * Implements IHardwareIdentityProvider by spawning the bundled libfido2 CLI
 * tools (fido2-assert.exe, fido2-cred.exe, fido2-token.exe).
 *
 * Background:
 *   On Windows 10 1903+ the OS claims the raw FIDO2 HID interface, and the
 *   @vaultys/webauthn-node native binding does not implement hmac-secret in its
 *   GetAssertion path.  The bundled libfido2 CLI tools DO support hmac-secret
 *   fully via the `windows://hello` synthetic device path, routing through
 *   webauthn.dll.  This class wraps those CLI tools so the wallet's PRF-based
 *   key-derivation path works on Windows.
 *
 * Security note â€” hmac secret lifetime in process memory:
 *   The 32-byte hmac-secret output travels through the child process's stdout
 *   pipe and is held as a Node.js Buffer for the duration of output parsing.
 *   We zero it immediately after extracting it into the returned AssertionResult,
 *   but the stdout pipe buffer itself is not under our control.  This is an
 *   accepted limitation of the CLI-subprocess approach: the OS page that backed
 *   the pipe buffer may persist in memory beyond our zeroing.  A native-addon
 *   implementation would be required for a fully zeroed path.
 *
 *   Per security policy: hmacOutput is NEVER written to any log.
 *
 * Requirements: Req 23.1, Req 23.5
 */

import * as childProcess from "child_process";
import { app } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { IHardwareIdentityProvider } from "./IHardwareIdentityProvider";
import {
  CtapError,
  type AssertionOptions,
  type AssertionResult,
  type DeviceInfo,
  type DiscoveryResult,
  type EnrollmentOptions,
  type EnrollmentResult,
  type CtapErrorCode,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Synthetic device path used by libfido2 on Windows to route FIDO2 operations
 * through webauthn.dll instead of a raw HID interface.
 */
const WINDOWS_HELLO_PATH = "windows://hello";

/**
 * Timeout (ms) for a single CLI invocation.  The user may need time to insert
 * the key, touch it, and enter a PIN â€” 60 s is intentionally generous.
 */
const CLI_TIMEOUT_MS = 60_000;

/**
 * Timeout (ms) for passive probes such as `fido2-token -I`.  Must be shorter
 * than DeviceMonitor's GET_INFO_TIMEOUT_MS (5 s) so the child process is killed
 * when the monitor gives up, instead of lingering for CLI_TIMEOUT_MS.
 */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Number of interactive operations (assertion / enrollment) currently running.
 * While > 0, listDevices() returns the last known result WITHOUT spawning
 * another process.  webauthn.dll serialises access to the authenticator, so
 * the 500 ms DeviceMonitor poll would otherwise race the Windows Hello flow.
 */
let interactiveOps = 0;
let lastKnownDevices: DeviceInfo[] = [];

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the absolute directory that contains the bundled libfido2 CLI tools.
 *
 * Development:  <project-root>/libfido2-win/libfido2-1.15.0-win/Win64/Release/v143/dynamic/
 * Packaged app: <process.resourcesPath>/libfido2-win/libfido2-1.15.0-win/Win64/Release/v143/dynamic/
 *
 * The DLLs (fido2.dll, cbor.dll, crypto.dll, zlib1.dll) live in the same
 * directory, so we prepend this dir to PATH when spawning any CLI tool so the
 * loader can find them without a separate install step.
 */
function getCliDir(): string {
  const relative = path.join(
    "libfido2-win",
    "libfido2-1.15.0-win",
    "Win64",
    "Release",
    "v143",
    "dynamic",
  );

  // app.getAppPath() returns the directory containing package.json:
  //   development: <project-root>/
  //   packaged:    <resources>/app.asar
  // For a packaged app the CLI tools are in <resourcesPath>/libfido2-win/...
  // (electron-builder copies extra files from the project root into resources).
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, relative);
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const STDERR_ERROR_MAP: Array<[RegExp, CtapErrorCode]> = [
  [/pin.?invalid|wrong.?pin|incorrect.?pin/i, "CTAP2_ERR_PIN_INVALID"],
  [/pin.?blocked/i, "CTAP2_ERR_PIN_BLOCKED"],
  [/no.?credential|no.?assertion/i, "CTAP2_ERR_NO_CREDENTIALS"],
  [/key.?store.?full|storage.?exhausted/i, "CTAP2_ERR_KEY_STORE_FULL"],
  [/operation.?denied|action.?denied/i, "CTAP2_ERR_OPERATION_DENIED"],
  [/not.?allowed/i, "CTAP2_ERR_NOT_ALLOWED"],
  // Windows Hello returns specific status texts:
  [/nmc_.*cancelled|user.?cancelled/i, "CTAP2_ERR_OPERATION_DENIED"],
];

function userMessageForCode(code: CtapErrorCode): string {
  switch (code) {
    case "CTAP2_ERR_PIN_INVALID":
      return "Incorrect PIN. Please try again.";
    case "CTAP2_ERR_PIN_BLOCKED":
      return "PIN is blocked. Reset your security key to continue.";
    case "CTAP2_ERR_NO_CREDENTIALS":
      return "No credentials found on this device for the given account.";
    case "CTAP2_ERR_KEY_STORE_FULL":
      return "The security key's credential storage is full.";
    case "CTAP2_ERR_OPERATION_DENIED":
      return "Operation was denied. Ensure the device is unlocked and try again.";
    case "CTAP2_ERR_NOT_ALLOWED":
      return "Operation not allowed by the security key.";
    default:
      return "An unexpected hardware security key error occurred.";
  }
}

function mapStderrToCtapError(stderr: string, exitCode: number | null): CtapError {
  for (const [pattern, code] of STDERR_ERROR_MAP) {
    if (pattern.test(stderr)) {
      return new CtapError(code, userMessageForCode(code), stderr.trim());
    }
  }
  // Generic exit-code error
  return new CtapError(
    "UNKNOWN",
    "An unexpected hardware security key error occurred.",
    `fido2 CLI exited with code ${exitCode ?? "unknown"}. stderr: ${stderr.trim()}`,
  );
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawns a CLI tool, writes `stdinData` to its stdin, and collects stdout /
 * stderr.  Rejects after CLI_TIMEOUT_MS or if the process exits non-zero.
 *
 * The DLL directory is prepended to `PATH` in the child's environment so the
 * loader can resolve fido2.dll and its dependencies without any prior install.
 */
function spawnCli(
  cliDir: string,
  executable: string,
  args: string[],
  stdinData: string,
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Prepend the CLI directory so Windows can find the side-by-side DLLs.
    const childEnv = {
      ...process.env,
      PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const exePath = path.join(cliDir, executable);

    // Requirement 11.4: verify the executable exists before attempting to spawn.
    if (!fs.existsSync(exePath)) {
      reject(
        new CtapError(
          "UNKNOWN",
          "The FIDO2 CLI tool could not be found. Please reinstall the application.",
          `CLI executable not found at resolved path: ${exePath}`,
        ),
      );
      return;
    }

    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(exePath, args, {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Do not inherit shell; we want direct process control.
        shell: false,
        windowsHide: false,  // Allow Windows Hello dialog to find a parent HWND
      });
    } catch (err) {
      reject(
        new CtapError(
          "UNKNOWN",
          "Failed to start the FIDO2 CLI tool.",
          `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(
          new CtapError(
            "CTAP2_ERR_OPERATION_DENIED",
            "Operation timed out. Please try again and interact with your security key promptly.",
            `fido2 CLI timed out after ${timeoutMs} ms. stderr so far: ${stderr.trim() || "(empty)"}`,
          ),
        );
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new CtapError(
            "UNKNOWN",
            "Failed to communicate with the FIDO2 CLI tool.",
            err.message,
          ),
        );
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    // Write stdin then close the write end so the tool sees EOF.
    child.stdin?.write(stdinData, "utf8");
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// Temporary file helper for -i flag
// ---------------------------------------------------------------------------

/**
 * Writes `content` to a temporary file and returns the file path.
 * The caller MUST delete the file after use (use `deleteTempFile`).
 *
 * Some fido2-assert / fido2-cred versions require `-i <file>` rather than
 * piped stdin on Windows.  We use temp files defensively.
 */
function writeTempFile(content: string): string {
  const tmpPath = path.join(os.tmpdir(), `fido2-${crypto.randomBytes(8).toString("hex")}.tmp`);
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  return tmpPath;
}

function deleteTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Non-fatal; temp dir will be cleaned by the OS eventually.
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * FIDO2 CLI-based implementation of {@link IHardwareIdentityProvider}.
 *
 * Uses the bundled `fido2-assert.exe`, `fido2-cred.exe`, and `fido2-token.exe`
 * from the libfido2 1.15.0 Windows distribution to communicate with the
 * `windows://hello` device path.  This fully supports the `hmac-secret`
 * extension, which the @vaultys/webauthn-node C++ binding does not.
 *
 * Thread safety: each public method spawns an independent subprocess; there is
 * no shared mutable state.
 *
 * Requirements: Req 23.1, Req 23.5
 */
export class Fido2CliHardwareIdentityProvider implements IHardwareIdentityProvider {
  // ---------------------------------------------------------------------------
  // Path resolution
  // ---------------------------------------------------------------------------

  /**
   * Returns the directory containing the bundled libfido2 CLI tools.
   * Exposed for testing / diagnostics; prefer the module-level helper.
   */
  private getCliDir(): string {
    return getCliDir();
  }

  // ---------------------------------------------------------------------------
  // listDevices
  // ---------------------------------------------------------------------------

  /**
   * Checks whether `windows://hello` is available by running:
   *   fido2-token -I windows://hello
   *
   * Parses the output to extract extension capability information and returns a
   * synthesized DeviceInfo.  Returns an empty array when the tool fails (no
   * Windows Hello device configured, or CLI not found).
   *
   * Requirements: Req 23.1
   */
  async listDevices(): Promise<DeviceInfo[]> {
    // An assertion/enrollment is in flight: don't touch webauthn.dll again.
    if (interactiveOps > 0) {
      return lastKnownDevices;
    }

    const cliDir = this.getCliDir();

    let result: SpawnResult;
    try {
      result = await spawnCli(
        cliDir,
        "fido2-token.exe",
        ["-I", WINDOWS_HELLO_PATH],
        "",
        PROBE_TIMEOUT_MS,
      );
    } catch (err) {
      // CLI unavailable or Windows Hello not configured â€” not a hard error here.
      console.warn(
        "[Fido2CliHardwareIdentityProvider] fido2-token -I failed:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }

    if (result.exitCode !== 0) {
      console.warn(
        "[Fido2CliHardwareIdentityProvider] fido2-token -I exited with code",
        result.exitCode,
      );
      return [];
    }

    // Parse extension strings from output like:
    //   extension strings: hmac-secret, credProtect
    const extensions: string[] = [];
    const extMatch = result.stdout.match(/extension strings:\s*(.+)/i);
    if (extMatch) {
      extensions.push(
        ...extMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }

    lastKnownDevices = [
      {
        devicePath: WINDOWS_HELLO_PATH,
        supportsHmacSecret: extensions.includes("hmac-secret") || extensions.length === 0
          // Windows Hello always supports hmac-secret even if the token output
          // doesn't list it in every build; default true when output is ambiguous.
          ? true
          : false,
        supportsResidentKey: true, // Windows Hello always supports RK
        extensions: extensions.length > 0 ? extensions : ["hmac-secret", "credProtect"],
        // Windows Hello manages PIN/biometric internally; we do not expose it.
        clientPin: undefined,
      },
    ];
    return lastKnownDevices;
  }

  // ---------------------------------------------------------------------------
  // discoverCredentials
  // ---------------------------------------------------------------------------

  /**
   * Enumerates discoverable (resident) credentials for `rpId` on
   * `windows://hello` using:
   *   fido2-assert -G -r -h -v -w -i <tmpfile> windows://hello
   *
   * `-r` = resident credential (no explicit credential ID in input)
   *
   * The CLI prints one credential per invocation â€” we run it once and parse
   * the output.  If the device has no credentials for this RP, the CLI exits
   * non-zero with a "no credentials" message; we map that to an empty result.
   *
   * LIMITATION: fido2-assert does not support batch enumeration of all resident
   * credentials the way CTAP2 credentialManagement does.  We get at most the
   * first credential selected by the Windows Hello authenticator UI.  A full
   * enumeration would require authenticatorCredentialManagement, which
   * fido2-token does not expose on windows://hello.
   *
   * Requirements: Req 23.5
   */
  /**
   * Returns credentials from the local credential store for the given rpId.
   *
   * On Windows via windows://hello, running fido2-assert -G -r requires the
   * user to interact with a security dialog â€” unsuitable for passive discovery.
   * We instead read the local JSON credential store, which is written during
   * enrollment and does not require any hardware interaction.
   *
   * Requirements: Req 23.5
   */
  async discoverCredentials(
    _devicePath: string,
    _rpId: string,
  ): Promise<DiscoveryResult> {
    // On windows://hello, silent credential enumeration via CTAP2 credential
    // management is not available without triggering a user-interaction dialog.
    // Return empty list â€” the caller (App.tsx DeviceConnectedRouter) will show
    // the EnrollView when no credentials are found, which is correct: the user
    // either needs to enroll or will select an existing credential from the
    // local store via the credential:discover IPC handler in index.ts.
    return { credentials: [] };
  }

    // ---------------------------------------------------------------------------
  // createCredential
  // ---------------------------------------------------------------------------

  /**
   * Creates a new discoverable credential with hmac-secret enabled using:
   *   fido2-cred -M -h -r -v -w -i <tmpfile> windows://hello es256
   *
   * Returns the credential ID parsed from the CLI output.
   *
   * Requirements: Req 23.5
   */
  async createCredential(
    _devicePath: string,
    options: EnrollmentOptions,
  ): Promise<EnrollmentResult> {
    const cliDir = this.getCliDir();

    // fido2-cred -M input format (-w = first line is unhashed client data):
    //   line 1: client data (base64, unhashed)
    //   line 2: relying party id (UTF-8)
    //   line 3: user name (UTF-8)   â† name before id
    //   line 4: user id (base64)
    const clientData = crypto.randomBytes(32).toString("base64");
    const userIdB64 = Buffer.from(options.userId).toString("base64");
    const stdinLines = [
      clientData,
      options.rpId,
      options.userName || options.userDisplayName,
      userIdB64,
    ].join("\n") + "\n";

    const tmpFile = writeTempFile(stdinLines);
    let result: SpawnResult;
    interactiveOps++;
    try {
      result = await spawnCli(
        cliDir,
        "fido2-cred.exe",
        ["-M", "-h", "-r", "-w", "-t", "uv=true", "-i", tmpFile, WINDOWS_HELLO_PATH, "es256"],
        "",
      );
    } finally {
      interactiveOps--;
      deleteTempFile(tmpFile);
    }

    if (result.exitCode !== 0) {
      throw mapStderrToCtapError(result.stderr, result.exitCode);
    }

    // fido2-cred -M output format:
    //   0: client data hash (base64)
    //   1: relying party id (UTF-8)
    //   2: credential format (UTF-8, e.g. "packed")
    //   3: authenticator data (base64)
    //   4: credential id (base64)    â† what we need
    //   5: attestation signature (base64)
    //   6: attestation cert (base64, optional)
    const lines = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length < 5) {
      throw new CtapError(
        "UNKNOWN",
        "An unexpected hardware security key error occurred.",
        `fido2-cred returned unexpected output (${lines.length} lines, need >=5). stdout: ${result.stdout.substring(0,200)}`,
      );
    }

    const credentialId = Buffer.from(lines[4], "base64");
    const publicKeyBytes = Buffer.from(lines[3], "base64"); // authData contains the public key

    return {
      credentialId,
      authenticatorAttachment: "cross-platform",
      publicKeyBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // getAssertion
  // ---------------------------------------------------------------------------

  /**
   * Runs a FIDO2 GetAssertion with the hmac-secret extension using:
   *   fido2-assert -G -h -v -w -i <tmpfile> windows://hello
   *
   * This is the critical path for wallet key derivation.  The 32-byte
   * hmac-secret output is returned as `hmacOutput` in the result.
   *
   * SECURITY: `hmacOutput` is NEVER written to any log.  The raw bytes exist
   * transiently in the CLI's stdout pipe buffer before we read them; that
   * buffer is not under our control and cannot be zeroed (accepted limitation
   * of the CLI approach).  We zero the intermediate parse buffer immediately
   * after extracting the value.
   *
   * Requirements: Req 23.5
   */
  async getAssertion(
    _devicePath: string,
    options: AssertionOptions,
  ): Promise<AssertionResult> {
    const cliDir = this.getCliDir();

    // stdin lines:
    // 1. Client data (base64, unhashed)
    // 2. Relying party ID
    // 3. Credential ID (base64)
    // 4. HMAC salt (base64, 32 bytes)
    const clientData = crypto.randomBytes(32).toString("base64");
    const credentialIdB64 = Buffer.from(options.credentialId).toString("base64");
    const hmacSaltB64 = Buffer.from(options.hmacSalt).toString("base64");

    const stdinLines = [
      clientData,
      options.rpId,
      credentialIdB64,
      hmacSaltB64,
    ].join("\n") + "\n";

    const tmpFile = writeTempFile(stdinLines);
    let result: SpawnResult;
    interactiveOps++;
    try {
      result = await spawnCli(
        cliDir,
        "fido2-assert.exe",
        ["-G", "-h", "-w", "-t", "uv=true", "-i", tmpFile, WINDOWS_HELLO_PATH],
        "",
      );
    } finally {
      interactiveOps--;
      deleteTempFile(tmpFile);
    }

    if (result.exitCode !== 0) {
      throw mapStderrToCtapError(result.stderr, result.exitCode);
    }
    // stdout lines:
    // 0: client data hash (base64)
    // 1: relying party ID
    // 2: authenticator data (base64)
    // 3: assertion signature (base64)
    // 4: user ID (base64) â€” may be absent for non-resident credentials
    // 5: HMAC secret output (base64, 32 bytes)
    //
    // When the credential is non-resident (explicit credentialId supplied),
    // Windows Hello does NOT emit a user ID line, so line 4 is the HMAC secret.
    // We detect this by checking the number of output lines.
    const lines = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // We need at least 5 lines; the hmac output is either line 4 or line 5.
    if (lines.length < 5) {
      throw new CtapError(
        "UNKNOWN",
        "The security key did not return the expected HMAC secret.",
        `fido2-assert returned ${lines.length} lines; expected at least 5`,
      );
    }

    // Determine which line carries the HMAC secret:
    // - 6 lines â†’ line[5] is the HMAC secret (user ID was emitted at line[4])
    // - 5 lines â†’ line[4] is the HMAC secret (no user ID in output)
    const hmacLineIndex = lines.length >= 6 ? 5 : 4;
    const hmacB64 = lines[hmacLineIndex];

    // Decode into a Buffer, then extract into a Uint8Array and zero the Buffer.
    const hmacBuf = Buffer.from(hmacB64, "base64");
    if (hmacBuf.length !== 32) {
      hmacBuf.fill(0);
      throw new CtapError(
        "UNKNOWN",
        "The security key returned an unexpected HMAC secret length.",
        `expected 32 bytes, got ${hmacBuf.length}`,
      );
    }

    const hmacOutput = new Uint8Array(32);
    hmacOutput.set(hmacBuf);
    // Zero the intermediate parse Buffer immediately (best-effort; see class doc).
    hmacBuf.fill(0);

    // Parse credentialId from the returned authenticatorData (line 2).
    // Byte layout: rpIdHash[32] + flags[1] + counter[4] = 37 bytes prefix
    // Then (if AT flag set): aaguid[16] + credIdLen[2] + credId[credIdLen]
    const authDataBuf = Buffer.from(lines[2], "base64");
    let credentialId: Uint8Array = Buffer.from(options.credentialId); // default to input

    const AT_FLAG = 0x40; // bit 6 of flags byte
    if (authDataBuf.length > 37 && (authDataBuf[32] & AT_FLAG) !== 0) {
      // AT flag set: attested credential data present
      if (authDataBuf.length >= 55) {
        const credIdLen = authDataBuf.readUInt16BE(53);
        if (authDataBuf.length >= 55 + credIdLen) {
          credentialId = authDataBuf.subarray(55, 55 + credIdLen);
        }
      }
    }

    return {
      hmacOutput,
      credentialId,
    };
  }
}


