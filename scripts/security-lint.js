#!/usr/bin/env node
/**
 * security-lint.js — Static security pattern scanner for KeyWallet source files.
 *
 * Usage:  node scripts/security-lint.js <filePath>
 * Exit:   0 = clean, 1 = file error, 2 = one or more violations found
 *
 * Enforces security rules from .kiro/steering/security.md:
 *   Rule 1 — No secret bytes to disk
 *   Rule 2 — No logging of secret material
 *   Rule 4 — No Math.random() for security values (src/main/ files only)
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Secret variable names that must never reach disk or logs
// ---------------------------------------------------------------------------
const SECRET_VAR_NAMES = [
  "prfOutput",
  "prf_output",
  "walletSeed",
  "wallet_seed",
  "secretKey",
  "secret_key",
  "privateKey",
  "private_key",
];

// Build a regex alternation of the secret names (word-boundary matched)
const secretNamesAlt = SECRET_VAR_NAMES.join("|");

// ---------------------------------------------------------------------------
// Rule definitions
// Each rule is an object with:
//   name    — short rule identifier
//   pattern — RegExp to test against a single line
//   describe(line) — returns a human-readable description of the violation
//   appliesToFile(filePath) — returns true if this rule should be checked
// ---------------------------------------------------------------------------
const RULES = [
  {
    // Rule 1a: writeFile / writeFileSync with a secret variable
    name: "NO_SECRET_TO_DISK",
    pattern: new RegExp(
      `(?:writeFile|writeFileSync)\\s*\\([^)]*\\b(?:${secretNamesAlt})\\b`,
      "i"
    ),
    describe: () =>
      "Secret material (PRF output / wallet seed / private key) passed to writeFile/writeFileSync — must never be written to disk",
    appliesToFile: () => true,
  },
  {
    // Rule 1b: fs.write with a secret variable
    name: "NO_SECRET_TO_DISK",
    pattern: new RegExp(
      `\\bfs\\.write\\s*\\([^)]*\\b(?:${secretNamesAlt})\\b`,
      "i"
    ),
    describe: () =>
      "Secret material (PRF output / wallet seed / private key) passed to fs.write — must never be written to disk",
    appliesToFile: () => true,
  },
  {
    // Rule 2: console.* / logger.* logging secret material
    name: "NO_SECRET_LOG",
    pattern: new RegExp(
      `(?:console\\.(?:log|error|debug|info|warn)|logger\\.(?:log|error|debug|info|warn))\\s*\\([^)]*\\b(?:${secretNamesAlt})\\b`,
      "i"
    ),
    describe: () =>
      "Secret material (PRF output / wallet seed / private key) passed to a log function — must never appear in logs",
    appliesToFile: () => true,
  },
  {
    // Rule 4: Math.random() in src/main/ files
    name: "CSPRNG_ONLY",
    pattern: /\bMath\.random\s*\(\s*\)/,
    describe: () =>
      "Math.random() is not cryptographically secure — use randomBytes() from node:crypto or crypto.getRandomValues() instead",
    appliesToFile: (filePath) => {
      // Normalise separators for cross-platform comparison
      const normalised = filePath.replace(/\\/g, "/");
      return normalised.includes("src/main/");
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error("[security-lint] ERROR: No file path provided.");
    console.error("Usage: node scripts/security-lint.js <filePath>");
    process.exit(1);
  }

  // Resolve to an absolute path so error messages are always unambiguous
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    console.error(`[security-lint] ERROR: File not found: ${absPath}`);
    process.exit(1);
  }

  let content;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    console.error(`[security-lint] ERROR: Could not read file: ${absPath}`);
    console.error(err.message);
    process.exit(1);
  }

  const lines = content.split("\n");
  const violations = [];

  for (const rule of RULES) {
    // Skip rules that don't apply to this file
    if (!rule.appliesToFile(absPath)) {
      continue;
    }

    lines.forEach((lineContent, index) => {
      // Skip pure comment lines (single-line // comments and block comment lines)
      const trimmed = lineContent.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
        return;
      }

      if (rule.pattern.test(lineContent)) {
        violations.push({
          rule: rule.name,
          description: rule.describe(lineContent),
          lineNumber: index + 1,
          lineContent: lineContent.trim(),
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  if (violations.length === 0) {
    console.log(`[security-lint] ✓ ${absPath} — no violations found`);
    process.exit(0);
  }

  console.error(
    `[security-lint] ✗ ${absPath} — ${violations.length} violation(s) found:\n`
  );

  for (const v of violations) {
    console.error(
      `[SECURITY VIOLATION] [${v.rule}] ${v.description} (line ${v.lineNumber}: ${v.lineContent})`
    );
  }

  console.error(
    `\n[security-lint] Summary: ${violations.length} security violation(s) in ${path.basename(absPath)}.`
  );
  console.error(
    "[security-lint] Fix the violations above before committing this file."
  );

  process.exit(2);
}

main();
