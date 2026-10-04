# Requirements Document

## Introduction

KeyWallet is a vendor-neutral, hardware-security-key-derived Solana wallet for desktop (devnet only). It derives a deterministic Solana Ed25519 keypair from a FIDO2/WebAuthn hardware security key using the CTAP2 `hmac-secret` extension (surfaced as the WebAuthn PRF extension in browser contexts). There is no account creation, no password, no seed phrase, and no backend login. The same physical hardware key produces the same wallet identity on any computer. Different keys produce different wallet identities. KeyWallet is explicitly a prototype/devnet tool — it is not a production wallet.

---

## WebAuthn PRF / CTAP2 hmac-secret Feasibility Findings

> **These findings must be read before interpreting any requirement that references PRF.**

### Finding 1 — PRF is authenticator-bound, not machine-bound (VALIDATED ✅)

The CTAP2 `hmac-secret` extension computes `HMAC-SHA256(credential_key, salt)` entirely inside the hardware authenticator. The credential key never leaves the device. Because the computation is performed on the authenticator itself, the output is the **same 32-byte secret on any computer** provided:
- The same physical hardware key is used.
- The same credential ID is presented.
- The same application salt is supplied.
- The same user-verification state is in effect.

This satisfies the core portability requirement: **Security Key A + Computer A → Wallet A**, and **Security Key A + Computer B → Wallet A**.

### Finding 2 — Cross-computer credential discovery requires a discoverable (resident) credential (VALIDATED ✅)

A non-discoverable credential stores the credential handle on the relying party server. In a server-free desktop app there is no server, so credential discovery across machines requires the credential to be stored on the authenticator itself as a **discoverable (resident) credential**. The credential is then enumerable by RP ID without needing a server-supplied credential list. Hardware keys with CTAP2.1+ support discoverable credentials directly. The app must use `requireResidentKey: true` (or `residentKey: "required"`) at enrollment time.

*Limitation:* Most hardware security keys have finite resident-credential storage (typically 8–100 slots depending on firmware). This is documented but does not block the prototype.

### Finding 3 — hmac-secret support across authenticator classes (VALIDATED ✅)

The CTAP2 `hmac-secret` extension is standardized in the FIDO2 CTAP2 specification and is broadly supported by:
- YubiKey 5 series and Security Key series (CTAP2, firmware ≥ 5.2)
- SoloKeys Solo 2
- Nitrokey FIDO2, Nitrokey 3
- Token2 FIDO2 keys
- Google Titan (USB-A/C)

Platform authenticators (TPM, Touch ID, Windows Hello) may also support PRF but their output is machine-bound via the platform credential store, which **breaks portability**. Platform authenticators MUST NOT be used as the identity source for KeyWallet. Only cross-platform (roaming) hardware authenticators are eligible.

### Finding 4 — Desktop WebAuthn / CTAP2 integration path (VALIDATED ✅)

Electron's renderer process does NOT expose `navigator.credentials` for security keys with `hmac-secret`/PRF in its embedded Chromium on all platforms. The reliable, vendor-neutral path for a cross-platform desktop application is:

**Primary path (all platforms):** Use `libfido2` (Yubico's open-source C library) via a Node.js native addon (`@vaultys/webauthn-node` or equivalent). `libfido2` communicates directly with authenticators over USB HID, NFC, and BLE without requiring browser intermediation. It exposes the `hmac-secret` extension natively.

**Secondary path (macOS only):** Electron + Apple AuthenticationServices framework (via `electron-webauthn`), which does support PRF including `hmac-secret`. Only viable on macOS 13+ and does not generalize to Windows/Linux.

**Chosen path:** `libfido2`-based native Node.js integration as the primary path to ensure cross-platform portability. This is wrapped behind a clean `HardwareIdentityProvider` abstraction so alternative implementations can be swapped in.

*Platform note for Windows:* `libfido2` on Windows requires that the application either runs as Administrator or that the device is accessible via the `WebAuthn.dll` Windows API (available on Windows 10 1903+). Windows 10 1903+ exposes a `WebAuthn.dll` that `libfido2` can optionally route through, which avoids the Administrator requirement. This limitation must be documented in the app UI.

### Finding 5 — PRF output → Ed25519 key derivation (VALIDATED ✅)

The `hmac-secret` extension returns a 32-byte secret. This is suitable as input material for HKDF-SHA-256. The HKDF output (32 bytes with a domain-separated info string) can be passed directly to `Keypair.fromSeed(seed)` in `@solana/web3.js`, which creates an Ed25519 keypair. This is the same method used by Solana paper wallets. The derivation is deterministic: same PRF output + same HKDF info string → same Solana keypair.

### Finding 6 — Security considerations for the PRF-to-key pipeline (DOCUMENTED ⚠️)

The following limitations apply to this architecture and MUST be clearly communicated to users:

1. **Prototype, not production:** The wallet identity is as secure as the hardware key. Loss or destruction of the hardware key means permanent loss of wallet access. No seed phrase backup exists.
2. **No user-verification requirement enforced by spec:** If the app does not enforce `userVerification: "required"`, an attacker with physical possession of the key could enumerate the PRF without the PIN. The app SHALL require user verification (PIN/biometric) for all wallet derivation operations.
3. **iCloud/Google platform authenticators break portability:** If a user accidentally enrolls a platform authenticator (passkey synced to iCloud/Google), the PRF output will not be machine-independent. The app SHALL reject platform authenticators during enrollment.
4. **The credential ID must travel with the key:** The credential ID is stored as resident/discoverable, so the key itself stores it. If the user resets the key, the credential (and thus wallet access) is lost.
5. **Solana devnet only:** All transactions are on devnet. The app contains no mainnet RPC endpoints.

### Finding 7 — Architecture decision

The architecture uses `libfido2` directly via Node.js native bindings in the Electron main process. WebAuthn `prf` extension framing is used conceptually; at the CTAP2 wire level this is the `hmac-secret` extension. The `HardwareIdentityProvider` abstraction wraps all CTAP2 interactions so that tests can inject a deterministic software mock.

---

## Glossary

- **KeyWallet**: The desktop application described in this document.
- **Authenticator**: A FIDO2/WebAuthn hardware security key (cross-platform/roaming authenticator only).
- **Credential**: A FIDO2 credential (public/private keypair) created on an Authenticator and stored as a discoverable (resident) credential.
- **Credential_ID**: The opaque byte string identifying a specific Credential on an Authenticator. Stored on-device for discoverable credentials.
- **PRF**: Pseudo-Random Function. The WebAuthn `prf` extension, backed at the CTAP2 level by the `hmac-secret` extension. Returns a deterministic 32-byte secret bound to a Credential.
- **PRF_Output**: The 32-byte secret returned by the Authenticator's `hmac-secret` computation for a given Credential and application salt.
- **PRF_Salt**: A fixed, domain-separated 32-byte value supplied by the application as input to the PRF.
- **Wallet_Seed**: The 32-byte value derived from PRF_Output via HKDF-SHA-256 with a domain-separated info string. Used as the Ed25519 seed.
- **Wallet_Keypair**: The Ed25519 keypair derived from Wallet_Seed via `Keypair.fromSeed()`.
- **Wallet_Address**: The Base58-encoded Ed25519 public key, used as the Solana account address.
- **Session**: The period during which a Wallet_Keypair is active in memory, bounded by Authenticator presence.
- **HardwareIdentityProvider**: The software abstraction layer that wraps all CTAP2/hmac-secret operations.
- **EnrollmentService**: The component that manages Credential creation (registration) on an Authenticator.
- **DerivationService**: The component that invokes PRF and performs HKDF to produce Wallet_Seed.
- **SessionService**: The component that manages in-memory Session state and keypair lifetime.
- **SolanaService**: The component that communicates with the Solana devnet RPC.
- **TransactionService**: The component that constructs and signs Solana transactions.
- **DeviceMonitor**: The component that detects Authenticator connection and removal events.
- **RP_ID**: Relying Party identifier used in FIDO2 credential scoping. Fixed value for KeyWallet: `key-wallet.local`.
- **CTAP2**: Client-to-Authenticator Protocol version 2. The low-level USB/NFC protocol between a platform and a hardware Authenticator.
- **Devnet**: The Solana development network used for all transactions in KeyWallet.
- **UV**: User Verification — PIN entry or biometric confirmation on or associated with the Authenticator.
- **libfido2**: The open-source C library for CTAP2 authenticator communication used in the HardwareIdentityProvider implementation.

---

## Requirements

---

### Requirement 1: Authenticator Detection and Presence Monitoring

**User Story:** As a user, I want KeyWallet to detect when I plug in or remove my hardware security key, so that my wallet session opens and closes automatically without manual login steps.

#### Acceptance Criteria

1. WHEN an Authenticator is connected to the computer via USB or NFC, THE DeviceMonitor SHALL emit a device-connected event within 2 seconds of physical connection.
2. WHEN an Authenticator is disconnected from the computer, THE DeviceMonitor SHALL emit a device-removed event within 2 seconds of physical disconnection.
3. WHILE no Authenticator is connected, THE KeyWallet SHALL display an idle state that prompts the user to connect a compatible hardware security key.
4. WHILE a device-connected event has been emitted and no active Session exists, THE KeyWallet SHALL transition to credential discovery or enrollment flow within 3 seconds of the device-connected event.
5. WHEN an Authenticator is connected, THE DeviceMonitor SHALL poll the device using the CTAP2 `authenticatorGetInfo` command to determine whether the device supports the `hmac-secret` extension, completing the poll within 5 seconds of the device-connected event.
6. IF a connected device does not support the CTAP2 `hmac-secret` extension, THEN THE DeviceMonitor SHALL emit an unsupported-device event and THE KeyWallet SHALL display a message indicating the device is not compatible with KeyWallet.
7. THE DeviceMonitor SHALL NOT identify devices by vendor-specific identifiers; device compatibility SHALL be determined solely by the presence of the `hmac-secret` capability flag returned by the CTAP2 `authenticatorGetInfo` command.
8. IF the CTAP2 `authenticatorGetInfo` command does not return a response within 5 seconds of being issued, THEN THE DeviceMonitor SHALL emit an unsupported-device event and THE KeyWallet SHALL display a message indicating that the device could not be verified as compatible.
9. IF a device-connected event is emitted for an Authenticator while another Authenticator is already connected and an active Session exists, THEN THE KeyWallet SHALL ignore the new device-connected event and maintain the existing Session without interruption.

---

### Requirement 2: Credential Enrollment

**User Story:** As a user with a compatible hardware security key that has no KeyWallet credential, I want to enroll my key, so that KeyWallet can derive a deterministic wallet identity for that key.

#### Acceptance Criteria

1. WHEN a connected Authenticator has no discoverable Credential scoped to RP_ID `key-wallet.local`, THE EnrollmentService SHALL present an enrollment prompt to the user within 2 seconds of the device-connected event.
2. WHEN the user initiates enrollment, THE EnrollmentService SHALL create a CTAP2 discoverable (resident) Credential on the Authenticator with `requireResidentKey: true`, `userVerification: "required"`, and the `hmac-secret` extension enabled.
3. THE EnrollmentService SHALL set the Credential's RP ID to the fixed value `key-wallet.local`.
4. IF the Authenticator does not support discoverable credentials, THEN THE EnrollmentService SHALL abort enrollment and display an error indicating the device is not supported.
5. IF the Authenticator reports that it does not support the `hmac-secret` extension during credential creation, THEN THE EnrollmentService SHALL abort enrollment and display an error specifying that the device does not support the required PRF extension.
6. IF the user cancels the enrollment gesture (touch, PIN entry), THEN THE EnrollmentService SHALL abort enrollment, discard all partial state, and return the UI to the idle state within 2 seconds.
7. IF enrollment fails due to the Authenticator's resident credential storage being full, THEN THE EnrollmentService SHALL display a message informing the user that the device's credential storage is full and that enrollment cannot proceed until storage space is freed.
8. WHEN enrollment succeeds, THE EnrollmentService SHALL store only the Credential_ID and RP metadata (no secret material) in local application storage for future credential discovery optimization.
9. THE EnrollmentService SHALL NOT store any PRF_Output, Wallet_Seed, or Wallet_Keypair to disk at any point during or after enrollment.
10. WHERE the user has not set a PIN on the Authenticator, THE EnrollmentService SHALL prompt the user to set a PIN before credential creation begins; credential creation SHALL NOT proceed until the user confirms PIN setup is complete or a 300-second timeout elapses.
11. IF the credential creation ceremony has not completed within 120 seconds of being initiated, THEN THE EnrollmentService SHALL abort enrollment, discard all partial state, and return the UI to the idle state.
12. IF enrollment fails for a reason not covered by criteria 4–7 and 11, THEN THE EnrollmentService SHALL abort enrollment, discard all partial state, display a generic error message, and return the UI to the idle state.

---

### Requirement 3: Credential Discovery

**User Story:** As a user returning to KeyWallet with a previously enrolled hardware security key on any computer, I want KeyWallet to find my credential automatically, so that I do not need to identify myself by any other means.

#### Acceptance Criteria

1. WHEN a Credential is not found in local application storage for a connected Authenticator, THE EnrollmentService SHALL attempt discoverable credential enumeration on the Authenticator for RP_ID `key-wallet.local` using CTAP2 credential management commands, and SHALL treat the enumeration as failed if it does not complete within 10 seconds.
2. WHEN exactly one discoverable Credential for RP_ID `key-wallet.local` is found on the Authenticator, THE DerivationService SHALL proceed with that Credential without prompting the user to select one.
3. WHEN more than one discoverable Credential for RP_ID `key-wallet.local` is found on the Authenticator, THE KeyWallet SHALL display a credential selection UI showing each credential's display name, listing at most 20 credentials, and SHALL allow the user to choose which wallet to open.
4. IF no discoverable Credential for RP_ID `key-wallet.local` is found on the Authenticator, THEN THE KeyWallet SHALL offer to enroll the key as a new credential.
5. IF credential enumeration fails due to a CTAP2 error, THEN THE KeyWallet SHALL map the error to one of the following user-visible categories: "Device Error", "PIN Required", "PIN Locked", "Operation Not Supported", or "Unknown Error", SHALL display that category without exposing raw CTAP2 error codes, and SHALL offer a retry option up to 3 times before disabling the retry option and requiring the user to reconnect the Authenticator.
6. IF the Authenticator is physically disconnected or becomes unresponsive during credential enumeration, THEN THE KeyWallet SHALL cancel the enumeration, display an error message indicating the device was disconnected, and return to the initial connected-device detection state.

---

### Requirement 4: Wallet Derivation

**User Story:** As a user with an enrolled hardware security key, I want KeyWallet to derive my Solana wallet deterministically from my key, so that the same key always produces the same wallet address on any computer.

#### Acceptance Criteria

1. WHEN a Credential has been identified for a connected Authenticator, THE DerivationService SHALL invoke the CTAP2 `hmac-secret` extension (assertion/GetAssertion) on the Authenticator with the identified Credential_ID, `userVerification: "required"`, and a fixed, domain-separated PRF_Salt.
2. THE DerivationService SHALL use a PRF_Salt derived by computing HKDF-SHA256 with IKM = UTF-8 encoding of `"key-wallet-prf-salt-v1"`, salt = empty, and info = UTF-8 encoding of `"solana-wallet-derivation"`, producing a fixed 32-byte constant hard-coded in the application source.
3. WHEN the PRF operation succeeds, THE DerivationService SHALL derive Wallet_Seed by computing HKDF-SHA256 with IKM = PRF_Output, salt = empty, and info = UTF-8 encoding of `"key-wallet:solana:ed25519:v1"`, producing a 32-byte output.
4. WHEN Wallet_Seed has been derived, THE DerivationService SHALL construct the Wallet_Keypair in memory using `Keypair.fromSeed(Wallet_Seed)`.
5. WHEN the Wallet_Keypair has been constructed, THE DerivationService SHALL zero-overwrite the PRF_Output and Wallet_Seed memory buffers before returning the Wallet_Keypair to the caller.
6. IF the Authenticator returns an error or the user cancels the UV gesture during wallet derivation, THEN THE DerivationService SHALL discard all partial derivation state (including any PRF_Output and Wallet_Seed bytes) and return a typed error to the caller distinguishing user cancellation from authenticator error.
7. THE DerivationService SHALL NOT log, emit, store, or transmit PRF_Output, Wallet_Seed, or the private key component of Wallet_Keypair at any time.
8. THE DerivationService SHALL ensure that two calls with different Credential_IDs produce different Wallet_Keypairs.
9. THE DerivationService SHALL ensure that two calls with the same Credential_ID and Authenticator produce the same Wallet_Address.

---

### Requirement 5: Session Lifecycle

**User Story:** As a user, I want my wallet session to remain active only while my hardware security key is physically connected, so that removing the key automatically locks the wallet.

#### Acceptance Criteria

1. WHEN the Wallet_Keypair has been successfully derived, THE SessionService SHALL create an active Session containing only the Wallet_Keypair and Wallet_Address, and assign it a unique Session_ID.
2. WHILE a Session is active, THE KeyWallet SHALL display the Wallet_Address and wallet balance UI.
3. WHEN the DeviceMonitor emits a device-removed event for the Authenticator that owns the active Session, THE SessionService SHALL terminate the Session within 200 milliseconds of receiving the event.
4. WHEN the SessionService terminates a Session, THE SessionService SHALL zero-overwrite all Wallet_Keypair private key bytes in memory and clear all in-memory Session state before the termination completes.
5. WHEN a Session is terminated, THE KeyWallet SHALL return to the idle state within 500 milliseconds.
6. IF a different Authenticator is connected while a Session is active, THEN THE SessionService SHALL NOT automatically switch sessions, and THE KeyWallet SHALL display an informational message indicating that another key was detected and present an option to switch wallets.
7. THE SessionService SHALL NOT persist the Wallet_Keypair or private key material to disk, system keychain, or any persistent store.
8. WHILE no active Session exists, THE KeyWallet SHALL reject all transaction construction and signing requests with an error indicating the wallet is locked.
9. IF the DeviceMonitor fails to emit a device-removed event within 5 seconds of the SessionService detecting that the Authenticator owning the active Session is no longer present, THEN THE SessionService SHALL terminate the active Session and clear all in-memory Session state.

---

### Requirement 6: Wallet Address Display

**User Story:** As a user, I want to see my Solana wallet address clearly, so that I can share it to receive funds or verify I have the right wallet open.

#### Acceptance Criteria

1. WHILE a Session is active, THE KeyWallet SHALL display the Wallet_Address as a 32–44 character Base58 string in a dedicated, visible field in the main UI.
2. WHEN the user activates the copy-address control, THE KeyWallet SHALL copy the exact, unmodified Wallet_Address to the system clipboard.
3. WHEN the user activates the copy-address control, THE KeyWallet SHALL display a transient confirmation indicator for at least 1 second and no more than 5 seconds, then return to the default state.
4. WHILE a Session is active, THE KeyWallet SHALL display a QR code representation of the Wallet_Address in the main UI.
5. IF the QR code rendering fails, THEN THE KeyWallet SHALL display an error indicator in the QR code area without hiding the text Wallet_Address field.
6. THE KeyWallet SHALL NOT display, log, copy to clipboard, or emit the Wallet_Keypair private key bytes or Wallet_Seed in any form.

---

### Requirement 7: Devnet Balance Display

**User Story:** As a user, I want to see my current Solana devnet balance, so that I know whether I have funds to send.

#### Acceptance Criteria

1. WHILE a Session is active, THE SolanaService SHALL fetch the Wallet_Address balance from the Solana devnet RPC endpoint at session open and SHALL refresh the balance every 30 seconds.
2. WHEN the user activates a manual refresh control, THE SolanaService SHALL fetch the current balance immediately, independent of the 30-second refresh interval, and SHALL reset the 30-second interval timer upon completion.
3. THE KeyWallet SHALL display the balance in SOL as a non-negative number with exactly 4 decimal places, updating the displayed value within 2 seconds of receiving a successful RPC response.
4. IF the devnet RPC request fails, THEN THE SolanaService SHALL display a "balance unavailable" indicator in place of the balance value, retain the last successfully fetched balance value in memory, and SHALL retry using exponential backoff starting at 2 seconds and doubling on each failure up to a maximum retry interval of 60 seconds.
5. THE SolanaService SHALL only connect to Solana devnet RPC endpoints; mainnet endpoints SHALL NOT be configurable or accessible from the application.
6. IF the Session becomes inactive, THEN THE SolanaService SHALL stop all periodic balance refresh polling immediately.

---

### Requirement 8: Transaction Construction and Signing

**User Story:** As a user with an active wallet session, I want to construct and sign a SOL transfer on devnet, so that I can send funds between devnet addresses.

#### Acceptance Criteria

1. WHILE a Session is active, THE KeyWallet SHALL provide a send-SOL UI containing a destination address input field and an amount input field for constructing a transfer transaction.
2. WHEN the user submits a send-SOL form, THE TransactionService SHALL validate that the destination address decodes to exactly 32 bytes from a valid Base58 string of 32–44 characters.
3. WHEN the user submits a send-SOL form, THE TransactionService SHALL validate that the transfer amount is at least 1 lamport (0.000000001 SOL) and does not exceed the current balance minus the estimated transaction fee.
4. WHEN the TransactionService constructs a transaction, THE TransactionService SHALL fetch a recent blockhash from the Solana devnet RPC within a 10-second timeout; IF the blockhash fetch times out, THE TransactionService SHALL abort construction and display a timeout error; the fetched blockhash SHALL be used within its 60-second validity window.
5. WHEN a valid transaction has been constructed, THE TransactionService SHALL present a confirmation screen displaying the destination address, the transfer amount in SOL, and the estimated fee in SOL, and SHALL require explicit user confirmation before proceeding to signing.
6. WHEN the user confirms the transaction, THE TransactionService SHALL sign the transaction using the in-memory Wallet_Keypair private key without persisting the private key to any storage.
7. WHEN the transaction has been signed, THE TransactionService SHALL submit it to the Solana devnet RPC and display the non-empty alphanumeric transaction signature upon success.
8. IF the destination address is invalid, THEN THE TransactionService SHALL display a specific validation error and SHALL NOT submit the transaction.
9. IF the transfer amount is zero, sub-lamport, or exceeds the available balance minus the estimated fee, THEN THE TransactionService SHALL display a specific validation error and SHALL NOT submit the transaction.
10. IF the transaction submission fails due to an RPC error, THEN THE TransactionService SHALL display the error category and the signed transaction SHALL remain in memory for up to 30 seconds to allow one retry attempt.
11. IF a Session is terminated while a transaction is in progress, THEN THE TransactionService SHALL abort the transaction within 2 seconds, discard all signed transaction bytes and transaction state, and return to idle.
12. THE TransactionService SHALL only construct transfer transactions targeting the Solana devnet cluster; THE TransactionService SHALL NOT accept or use mainnet-beta or testnet cluster names or their associated RPC endpoints.

---

### Requirement 9: Security Key Removal During Operations

**User Story:** As a user, I want the wallet to handle my security key being removed at any point gracefully, so that no partial operation can compromise my wallet.

#### Acceptance Criteria

1. IF the Authenticator is removed during a PRF/derivation operation, THEN THE DerivationService SHALL discard all in-memory intermediate key bytes and Wallet_Seed material associated with the operation and SHALL propagate a session-aborted event to the SessionService.
2. IF the Authenticator is removed during a transaction signing operation, THEN THE TransactionService SHALL discard the partially constructed transaction and all associated signing inputs and SHALL propagate a session-aborted event to the SessionService.
3. WHEN a session-aborted event is received, THE SessionService SHALL zero-overwrite all in-memory Wallet_Keypair and Wallet_Seed state and SHALL return the UI to a state where no operation is in progress, no wallet data is displayed, and all action controls are disabled, within 500 milliseconds.
4. WHEN a session-aborted event is received, THE KeyWallet SHALL NOT retain any Wallet_Keypair, Wallet_Seed, or intermediate derivation bytes in memory after the zero-overwrite in criterion 3 completes.

---

### Requirement 10: Multiple Credentials on One Physical Key

**User Story:** As a user who has enrolled multiple KeyWallet credentials on a single physical security key, I want to choose which wallet to open, so that I can manage multiple Solana identities from one device.

#### Acceptance Criteria

1. WHEN a connected Authenticator returns exactly one discoverable Credential scoped to RP_ID `key-wallet.local`, THE KeyWallet SHALL skip the credential-selection screen and load that Credential directly; WHEN a connected Authenticator returns two or more discoverable Credentials scoped to RP_ID `key-wallet.local`, THE KeyWallet SHALL present a credential-selection screen listing each credential's display name and its associated Wallet_Address.
2. WHEN the user selects a Credential from the credential-selection screen, THE KeyWallet SHALL derive the Wallet_Keypair for that Credential_ID and display the resulting Wallet_Address as the active wallet within 3 seconds.
3. THE KeyWallet SHALL derive a distinct Wallet_Keypair for each distinct Credential_ID; two different Credential_IDs on the same physical key MUST produce different Wallet_Addresses.
4. WHILE a wallet session is active, THE KeyWallet SHALL display a persistent indicator showing the display name and Wallet_Address of the currently active Credential, updating immediately whenever the active Credential changes.
5. IF the DerivationService fails to derive a Wallet_Keypair after a Credential is selected, THEN THE KeyWallet SHALL display an error message indicating the derivation failure, remain on the credential-selection screen, and leave any previously active wallet session unchanged.

---

### Requirement 11: Multiple Physical Keys

**User Story:** As a user with multiple hardware security keys, I want each key to produce a distinct wallet identity, so that different keys are never confused.

#### Acceptance Criteria

1. THE DerivationService SHALL produce distinct Wallet_Addresses for distinct physical Authenticators that each have a valid KeyWallet Credential.
2. WHILE a Session is active for a first Authenticator, WHEN a second Authenticator is connected, THE KeyWallet SHALL display an informational notification identifying the newly connected Authenticator and offering to switch to the wallet derived from it.
3. WHEN the user chooses to switch to a different key's wallet, THE SessionService SHALL terminate the current Session (zero-overwriting all Wallet_Keypair private key bytes) before initiating derivation for the new key, such that no Wallet_Keypair data from the previous session is accessible after termination.
4. IF the user dismisses the switch offer, THEN THE KeyWallet SHALL continue the current Session without modification and remove the notification.
5. IF derivation for the new key fails after the previous Session has been terminated, THEN THE KeyWallet SHALL display an error indicating that no active session exists and prompt the user to reconnect a key.

---

### Requirement 12: Error and Unsupported-Device Handling

**User Story:** As a user with an unsupported or misconfigured hardware security key, I want clear guidance on what went wrong, so that I can resolve the issue without guessing.

#### Acceptance Criteria

1. IF the connected Authenticator does not support CTAP2, THEN THE KeyWallet SHALL display an error message indicating the device is not a FIDO2 authenticator and is not compatible, and SHALL present a link or in-app reference to a list of compatible device classes.
2. IF the connected Authenticator does not advertise the `hmac-secret` extension in its `authenticatorGetInfo` response, THEN THE KeyWallet SHALL display an error message indicating the device does not support the required PRF capability, and SHALL list at least one compatible device class within the same error view.
3. IF the user has not set a PIN on the Authenticator and the app requires user verification, THEN THE KeyWallet SHALL display a guided message instructing the user to set a PIN on the device before enrollment can proceed, and SHALL not advance the enrollment flow until the condition is re-evaluated.
4. IF a CTAP2 operation returns a PIN-locked error, THEN THE KeyWallet SHALL display a warning indicating the device PIN is locked due to too many incorrect attempts, SHALL advise the user not to reset the key without a backup, and SHALL disable retry controls for that operation within the same session.
5. IF local credential metadata references a Credential_ID not found on the Authenticator during credential discovery, THEN THE KeyWallet SHALL detect the mismatch, SHALL display an error message indicating the stored credential is no longer valid, and SHALL present the user with the option to re-enroll or to clear the stale local metadata, requiring explicit user confirmation before any metadata is deleted.
6. IF a SolanaService or TransactionService operation does not receive a valid response within 15 seconds, THEN THE SolanaService or TransactionService SHALL surface an error categorized as timeout, unreachable, or invalid response without exposing raw RPC error details, and SHALL display an error message indicating the category of failure and prompting the user to retry.
7. IF a SolanaService or TransactionService operation fails due to a network error other than timeout, THEN THE SolanaService or TransactionService SHALL surface an error categorized as unreachable or invalid response without exposing raw RPC error details, and SHALL preserve any unsent transaction data for the duration of the current session.

---

### Requirement 13: Platform Authentication Rejection

**User Story:** As a user, I want KeyWallet to reject platform authenticators (Touch ID, Windows Hello, etc.) during enrollment, so that my wallet identity remains hardware-key-bound and portable.

#### Acceptance Criteria

1. THE EnrollmentService SHALL set `authenticatorAttachment: "cross-platform"` in all credential creation requests, ensuring only roaming (hardware) authenticators are eligible.
2. WHEN a credential creation response is received, THE EnrollmentService SHALL verify that the authenticator attachment type in the response is "cross-platform" before accepting the credential.
3. IF the authenticator attachment type in the credential creation response is not "cross-platform", THEN THE EnrollmentService SHALL reject the credential, discard any partially created credential data, and display an error message indicating that only portable hardware security keys are supported.
4. THE EnrollmentService SHALL display in application help text an explanation that platform authenticators are disallowed because they bind the wallet identity to a single device, which prevents portability across devices.

---

### Requirement 14: No Plaintext Secret Storage

**User Story:** As a security-conscious user, I want assurance that no secret cryptographic material is ever written to disk, so that my wallet remains protected even if the computer is compromised.

#### Acceptance Criteria

1. THE KeyWallet SHALL NOT write PRF_Output, Wallet_Seed, Wallet_Keypair private key bytes, or any intermediate derivation value to any persistent storage medium including disk, system keychain, browser storage, or cloud sync.
2. THE KeyWallet SHALL NOT include PRF_Output, Wallet_Seed, or private key bytes in log files, error reports, analytics events, MCP tool responses, or debug output.
3. WHEN a signing operation completes or a Session ends, THE KeyWallet SHALL zero all memory buffers holding Wallet_Keypair private key bytes within 1 second of the triggering event; derivation of Wallet_Keypair private key bytes SHALL occur no earlier than immediately before the signing operation that requires them.
4. THE KeyWallet SHALL use cryptographically secure random number generation sourced exclusively from the platform CSPRNG for all nonces, challenges, and salts it generates.
5. IF the KeyWallet generates a nonce, challenge, or salt using any source other than the platform CSPRNG, THEN THE KeyWallet SHALL reject that value and report an error indicating CSPRNG unavailability without producing a security-sensitive output.
6. WHERE the KeyWallet stores local credential metadata (Credential_ID, RP metadata, display name), THE KeyWallet SHALL store only non-secret data fields that contain no PRF_Output, Wallet_Seed, private key bytes, or intermediate derivation values.

---

### Requirement 15: Kiro Feature Integration — Spec-Driven Development

**User Story:** As a developer demonstrating spec-driven development, I want all architecture, design, and implementation tasks to follow from this requirements document, so that there is a clear traceable chain from requirement to task to code.

#### Acceptance Criteria

1. THE KeyWallet project SHALL have a requirements document, a design document, and a task list, where each task list item references one or more requirement identifiers (e.g., "Req 4", "Req 8") that the task satisfies.
2. EACH implementation task SHALL include an explicit requirement reference field identifying the requirement(s) it satisfies.
3. THE design document SHALL include at least one concrete technology decision with justification, at least one data flow diagram or description, a threat model section, and the WebAuthn PRF feasibility findings from this requirements document.

---

### Requirement 16: Kiro Feature Integration — Steering Documents

**User Story:** As a developer demonstrating steering documents, I want workspace-level rules for security, architecture, and testing conventions that guide AI-assisted development throughout the project.

#### Acceptance Criteria

1. THE KeyWallet project SHALL contain a security steering document that explicitly names the following rules: no PRF_Output or private key bytes to disk, no logging of secret material, zero memory buffers immediately after use, use platform CSPRNG only.
2. THE KeyWallet project SHALL contain an architecture steering document that explicitly names the following rules: all CTAP2 operations execute in the Electron main process only, all hardware interactions go through the `HardwareIdentityProvider` interface, the Solana layer SHALL NOT import any CTAP2 or libfido2 modules.
3. THE KeyWallet project SHALL contain a testing steering document that specifies: property-based tests use 32-byte arrays as PRF_Output test data, no property-based test connects to real hardware, the software mock `HardwareIdentityProvider` returns deterministic output for the same input within a single test run.

---

### Requirement 17: Kiro Feature Integration — Hooks

**User Story:** As a developer demonstrating hooks, I want automated checks to run when relevant source files change, so that security regressions and test failures are surfaced immediately.

#### Acceptance Criteria

1. WHEN a file matching `src/services/**` is saved, THE KeyWallet project's Kiro hook SHALL run security linting that audits for secret-logging patterns.
2. WHEN a file matching the derivation or KDF source paths is saved, THE KeyWallet project's Kiro hook SHALL run the property-based test suite for the `DerivationService`.
3. WHEN a hook detects a violation, THE hook SHALL surface the violation output including file path, line number, and rule description for each violation found, and SHALL exit with a non-zero code.

---

### Requirement 18: Kiro Feature Integration — Property-Based Testing

**User Story:** As a developer demonstrating property-based testing, I want a suite of generative tests for the deterministic derivation pipeline, domain separation, and transaction invariants, so that correctness properties are verified across a wide input space.

#### Acceptance Criteria

1. THE DerivationService test suite SHALL include a property: for any fixed 32-byte PRF_Output array, `derive(prf_output)` returns the same Wallet_Address on every invocation (idempotence).
2. THE DerivationService test suite SHALL include a property: for any two distinct 32-byte PRF_Output arrays, the derived Wallet_Addresses differ.
3. THE DerivationService test suite SHALL include a property: the HKDF domain-separation info string applied to any 32-byte PRF_Output produces a 32-byte seed that is accepted as a valid Ed25519 private key seed by the Solana keypair library.
4. THE TransactionService test suite SHALL include a property: serializing and deserializing a constructed (unsigned) transaction produces a transaction with field-by-field equal program identifiers, account lists, and instruction data.
5. THE TransactionService test suite SHALL include a property: the transaction amount field is always a positive integer in lamports and never exceeds the session balance passed to the constructor.
6. ALL property-based tests SHALL use a software mock `HardwareIdentityProvider` that returns the same deterministic 32-byte PRF_Output for the same input on every invocation within a single test run; NO property test SHALL connect to real hardware.

---

### Requirement 19: Kiro Feature Integration — MCP (Model Context Protocol)

**User Story:** As a developer demonstrating MCP, I want a safe transaction inspection tool and network inspection tool available via MCP that never expose secret material, so that AI assistants can reason about transaction structure and network state without accessing private keys.

#### Acceptance Criteria

1. THE KeyWallet project SHALL expose an MCP tool `inspect_transaction` that accepts a base64-encoded unsigned Solana transaction and returns decoded human-readable fields (program, accounts, instruction data) without accepting or returning private keys.
2. THE KeyWallet project SHALL expose an MCP tool `query_devnet` that accepts a Solana public address and returns balance and the 10 most recent transaction signatures from devnet.
3. THE MCP tools SHALL NOT accept private keys, Wallet_Seeds, or PRF_Outputs as parameters.
4. THE MCP tools SHALL NOT return private keys, Wallet_Seeds, or PRF_Outputs in their responses.
5. THE MCP server SHALL enforce that all `inspect_transaction` inputs are valid base64 and that the decoded transaction is parseable before returning a response; invalid inputs SHALL return a structured error containing a failure-reason field and no partial transaction data.

---

### Requirement 20: Kiro Feature Integration — Custom Agent

**User Story:** As a developer demonstrating custom agents, I want a security-focused code review agent that checks cryptographic and signing code for vulnerabilities, so that the most sensitive parts of the codebase are reviewed by a specialized agent.

#### Acceptance Criteria

1. THE KeyWallet project SHALL include a custom Kiro agent configuration for a "Crypto Security Reviewer" agent.
2. THE Crypto_Security_Reviewer agent SHALL be scoped to the `HardwareIdentityProvider`, `DerivationService`, and `TransactionService` modules and SHALL NOT produce findings for files outside those modules.
3. THE Crypto_Security_Reviewer agent SHALL check for: use of `Math.random()` for security-sensitive values, plaintext logging of secret material, missing buffer zeroing after key use, use of non-audited cryptographic libraries, and hardcoded non-domain-separated salts.
4. THE Crypto_Security_Reviewer agent SHALL produce a structured report where each finding includes all four of the following fields: file path, line number, rule violated, and remediation suggestion; findings missing any of these four fields SHALL NOT be emitted.

---

### Requirement 21: Kiro Feature Integration — Powers

**User Story:** As a developer demonstrating Powers, I want a reusable hardware-wallet security development Power that packages the security steering document, the MCP tools, and the custom agent, so that the capability can be reused across projects.

#### Acceptance Criteria

1. THE KeyWallet project SHALL define a Kiro Power named `hardware-wallet-security` that references by explicit file path or identifier: the security steering document, the MCP transaction inspection tools, and the Crypto_Security_Reviewer agent definition.
2. THE `hardware-wallet-security` Power SHALL include a README with at minimum the following sections: Capabilities, Exposed Tools, and Enforced Security Rules.
3. WHERE the `hardware-wallet-security` Power's MCP tools are activated, WHEN an AI assistant session begins, THE Power SHALL load the security steering rules into the AI assistant context.
