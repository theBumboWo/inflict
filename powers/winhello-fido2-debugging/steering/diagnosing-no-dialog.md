# Diagnosing: no dialog, or dialog then stall

Work through these in order. Stop at the first hit.

## 1. Did the CLI even start?
Most "no dialog" reports are the app failing *before* spawning.
- Does any code path call `listDevices()` and treat an empty list as
  "No device connected"? A timeout, missing exe, or non-zero exit in a probe can
  silently produce `[]`.
- Check the bundled tools exist at the resolved path (dev: project root;
  packaged: `process.resourcesPath`). A missing exe must log loudly.
- Add a console log at the IPC handler entry and right before `spawn`. If the
  second never prints, the bug is upstream of libfido2.

## 2. Leftover processes from a previous attempt
A hung earlier attempt can block new prompts.
```
tasklist | findstr /i "fido2 CredentialUIBroker"
```
Kill stray `fido2-*.exe`. If `CredentialUIBroker.exe` is stuck, sign out or
reboot once, then retest.

## 3. Contention
Anything else touching `webauthn.dll` during an assertion can interfere. Look for
timers or monitors that spawn `fido2-token.exe` or other CLI calls while the
dialog is open. Remove the poll (see `electron-child-process-hygiene.md`).

## 4. Window handle
No usable foreground/top window means libfido2 fails with no UI. Check the app
window is visible and not minimised when the CLI starts. Spawning with
`windowsHide: false` lets a console app get a window; test both settings.

## 5. Get the real error
Run by hand from the CLI folder (input file = client data, rpId, credential id,
hmac salt, each on its own line, base64 where applicable):
```
fido2-assert.exe -d -G -h -w -t uv=true -i test.txt windows://hello
```
- Dialog appears manually but not from the app: the problem is how the app
  spawns it (env, parent window, concurrency).
- Fails manually too: read the stderr trace. It is libfido2 / Windows, not app code.
- Share **stderr only**.

## 6. Dialog appears, user touches, then 60 s stall
The child never exits, so the app's timeout is what ends it. Check for another
concurrent `webauthn.dll` caller (step 3) and capture stderr with `-d`.
