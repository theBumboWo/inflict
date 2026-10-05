# Spawning CLI tools from Electron safely

## Timeouts
- Interactive operations (assertion, enrollment): generous (60 s) because a human
  is involved.
- Passive probes: must be **shorter** than any caller-side race timeout, so the
  child dies when the caller gives up instead of lingering.
- Always `child.kill()` on timeout, and include captured stderr in the error.

## Polling
- Do not poll by spawning processes. A 500 ms poll that spawns a CLI tool piles
  up children whenever the tool is slow.
- Windows presence: scan HID vendor IDs (`node-hid`) or use OS device events.
- If a poll must exist, guard against overlap *and* pause it while an
  interactive operation is in flight.

## Errors must not be silent
- `listDevices()` returning `[]` on any failure hides the cause. Log the reason
  (exe missing, timeout, exit code) before returning.
- Distinguish "no device" from "probe failed" in the UI where possible.

## Logging secrets
- stderr: safe to log (use it).
- stdout of `fido2-assert`: contains the hmac-secret. Never log it, never put it
  in an error message, zero buffers in `finally`.
- Debug flag `-d` writes its trace to stderr. Gate it behind an env var.

## Temp files
- Input files hold salt and credential id. Create with mode 0o600, delete in
  `finally`, never leave them in the repo.
