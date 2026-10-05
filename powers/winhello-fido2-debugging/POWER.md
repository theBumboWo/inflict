---
name: "winhello-fido2-debugging"
displayName: "Windows Hello / FIDO2 Debugging"
description: "Diagnose hangs, missing prompts and bad hmac-secret output when an Electron or Node app drives a FIDO2 security key through libfido2 and windows://hello on Windows."
keywords: ["windows hello", "fido2", "libfido2", "hmac-secret", "webauthn", "yubikey", "security key", "fido2-assert", "electron", "ctap2"]
author: "inflict"
---

# Windows Hello / FIDO2 Debugging

Use this power when an app shells out to the libfido2 CLI tools (`fido2-assert.exe`,
`fido2-cred.exe`, `fido2-token.exe`) against the synthetic device path
`windows://hello`, and something goes wrong: the dialog never appears, the app
stalls after the touch, or the hmac-secret comes back missing or different.

## How the stack works (verified against libfido2 1.15.0 `src/winhello.c`)

```
App -> spawn fido2-assert.exe -> libfido2 winhello backend -> webauthn.dll
    -> CredentialUIBroker.exe (hosts the Windows Hello / security-key dialog)
```

- `windows://hello` does not talk to the key directly. Everything goes through
  `webauthn.dll`, and the dialog is shown by a separate system process,
  `CredentialUIBroker.exe`, modal to a window handle.
- The handle is `GetForegroundWindow()`, falling back to `GetTopWindow(NULL)`.
  If both are null the call fails without showing anything.
- `fido2-token -I windows://hello` returns a **hardcoded** capability list. It
  never contacts the authenticator, so it is useless as a presence check or poll.
- If `webauthn.dll` is too old to support hmac-secret on GetAssertion, or returns
  no value, libfido2 silently proceeds without it. The symptom is fewer stdout
  lines than expected, not an error.

## Steering files

Load the file that matches the symptom:

- `diagnosing-no-dialog.md` - dialog never appears, or appears then stalls
- `electron-child-process-hygiene.md` - how to spawn, time out, poll and log safely
- `hmac-secret-determinism.md` - output missing, wrong length, or address changed

## Onboarding

1. Run `scripts/diagnose-winhello.ps1` from the folder holding the libfido2 CLI
   tools. It reports leftover processes, tool presence and Windows build.
2. Ask the user for **stderr only** from a manual `fido2-assert.exe -d ...` run.
   Never ask for stdout: on success it contains the hmac-secret.
3. Read the matching steering file before proposing code changes.

## Hard rules

- Never log, paste, or persist stdout of `fido2-assert` (it carries the secret).
- Never poll `windows://hello` by spawning a process. Presence comes from a
  vendor-ID scan or OS device events.
- Do not change `uv` / user-verification flags between enrollment and unlock
  without telling the user the derived secret will change.
