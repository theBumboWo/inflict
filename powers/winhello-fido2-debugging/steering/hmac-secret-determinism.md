# hmac-secret: missing, wrong length, or changed

## Missing or short output
`fido2-assert -G -h` prints, in order: client data hash, rp id, authenticator
data, signature, optional user id, then the hmac-secret. If the hmac line is
absent, libfido2 likely proceeded without hmac-secret (see POWER.md). Causes:
- `webauthn.dll` too old for hmac-secret on GetAssertion
- the authenticator returned no hmac value
- a 64-byte (two-salt) result, which libfido2 also drops
Handle by counting lines defensively and raising a clear error, not by guessing
which line is the secret.

## Wrong length
The secret must be exactly 32 bytes after base64 decode. Treat any other length
as an error and zero the buffer.

## Address changed between runs
Per libfido2's documentation, the resulting hmac-secret varies according to
whether user verification was performed. Therefore:
- Use the same `uv` setting at enrollment and every unlock.
- Use the same salt constant, rpId and credential.
- If any of these change, the derived wallet address changes. Warn the user
  before shipping such a change.

## Input format reminders
- Windows Hello computes the client-data hash itself, so pass the *unhashed*
  client data (`-w` on the CLI).
- Salt must be exactly 32 bytes (base64 of 32 bytes).
