#!/usr/bin/env tsx
/**
 * diagnostics.ts — Runs hardware:diagnose and hardware:test in sequence.
 *
 * Usage:  npx tsx scripts/diagnostics.ts
 *         npm run diagnostics
 *
 * Behaviour:
 *   1. Spawns hardware-diagnose.ts via tsx, captures stdout/stderr
 *   2. Spawns hardware-test.ts via tsx, captures stdout/stderr
 *   3. Writes combined output to logs/hardware-diagnostics.txt (creates logs/ if absent)
 *   4. Prints all output to console as it arrives
 *   5. Exits with the maximum of both child exit codes
 *
 * Requirements: 12.3
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve __dirname equivalent for ESM / tsx / ts-node */
function getScriptsDir(): string {
  // tsx/ts-node run as CJS with __dirname available
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  // ESM fallback
  return path.dirname(fileURLToPath(import.meta.url));
}

const SCRIPTS_DIR = getScriptsDir();
const WORKSPACE_ROOT = path.resolve(SCRIPTS_DIR, "..");
const LOGS_DIR = path.join(WORKSPACE_ROOT, "logs");
const LOG_FILE = path.join(LOGS_DIR, "hardware-diagnostics.txt");

// ---------------------------------------------------------------------------
// Run a child script, stream output to console, and collect combined output
// ---------------------------------------------------------------------------

interface RunResult {
  label: string;
  output: string;
  exitCode: number;
}

function runScript(label: string, scriptPath: string): Promise<RunResult> {
  return new Promise((resolve) => {
    // Find tsx binary: prefer the local node_modules/.bin/tsx
    const tsxBin = path.join(WORKSPACE_ROOT, "node_modules", ".bin", "tsx");

    const child = spawn(tsxBin, [scriptPath], {
      cwd: WORKSPACE_ROOT,
      // Inherit environment so tsx can find TypeScript sources
      env: { ...process.env },
      // Pipe stdout/stderr so we can capture them
      stdio: ["ignore", "pipe", "pipe"],
      // On Windows, shell is not needed — tsx is a .cmd in node_modules/.bin
      // but we may need shell:true so the .cmd wrapper is resolved correctly
      shell: process.platform === "win32",
    });

    const chunks: string[] = [];

    const header = `\n=== ${label} ===\n`;
    process.stdout.write(header);
    chunks.push(header);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(text);
      chunks.push(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Write stderr to stderr so it stays visible in the console
      process.stderr.write(text);
      // But also capture it in the log
      chunks.push(text);
    });

    child.on("close", (code: number | null) => {
      const exitCode = code ?? 1;
      const footer = `\n[${label} exited with code ${exitCode}]\n`;
      process.stdout.write(footer);
      chunks.push(footer);
      resolve({ label, output: chunks.join(""), exitCode });
    });

    child.on("error", (err: Error) => {
      const msg = `\n[Failed to spawn ${label}: ${err.message}]\n`;
      process.stderr.write(msg);
      chunks.push(msg);
      resolve({ label, output: chunks.join(""), exitCode: 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Ensure logs/ directory exists
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const timestamp = `\n[diagnostics run at ${new Date().toISOString()}]\n`;
  process.stdout.write(timestamp);

  const diagnoseScript = path.join(SCRIPTS_DIR, "hardware-diagnose.ts");
  const testScript = path.join(SCRIPTS_DIR, "hardware-test.ts");

  // Run both scripts in sequence
  const diagnoseResult = await runScript("hardware:diagnose", diagnoseScript);
  const testResult = await runScript("hardware:test", testScript);

  // Write combined output to log file
  const combined = [
    timestamp,
    diagnoseResult.output,
    testResult.output,
  ].join("");

  fs.writeFileSync(LOG_FILE, combined, "utf8");
  console.log(`\nOutput written to: ${LOG_FILE}`);

  // Exit with the maximum of both exit codes (Req 12.3)
  const finalCode = Math.max(diagnoseResult.exitCode, testResult.exitCode);
  process.exit(finalCode);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[FATAL] Unexpected error in diagnostics: ${msg}`);
  process.exit(1);
});
