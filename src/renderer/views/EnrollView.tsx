// src/renderer/views/EnrollView.tsx
//
// Displayed when a device is connected but no credential has been enrolled yet,
// or when enrollment is in progress.
//
// Responsibilities (task 20.1):
//   - On mount call `credential:discover` to check for existing credentials
//   - 0 credentials → show enrollment form (display name input + start button)
//   - 1+ credentials → show credential selection list (max 20 entries)
//   - Subscribe to `enrollment:progress` to show per-stage UI messages
//   - Show PIN setup guidance when stage is `checking-pin`
//   - Cancel button calls `enrollment:cancel` IPC then calls onCancel
//   - All interactive elements have accessible ARIA attributes
//
// Requirements: Req 2.1, Req 2.6, Req 2.10, Req 12.3

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { EnrollmentState } from "../../shared/ipc-types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredCredential {
  credentialId: string;
  userDisplayName: string;
}

// ─── Stage message helpers ────────────────────────────────────────────────────

const STAGE_MESSAGES: Record<Exclude<EnrollmentState, "idle">, string> = {
  "checking-pin": "Checking device PIN status...",
  "awaiting-touch": "Please touch your security key...",
  "storing-metadata": "Saving credential...",
  complete: "Enrollment complete!",
  failed: "Enrollment failed. Please try again.",
};

// ─── Props ────────────────────────────────────────────────────────────────────

export interface EnrollViewProps {
  devicePath: string;
  enrollmentStage: EnrollmentState;
  /** Called when the user confirms enrollment with a display name. */
  onEnroll: (displayName: string) => void;
  /** Called when the user cancels the enrollment flow. */
  onCancel: () => void;
}

// ─── EnrollView ───────────────────────────────────────────────────────────────

export function EnrollView({
  devicePath,
  enrollmentStage,
  onEnroll,
  onCancel,
}: EnrollViewProps): React.ReactElement {
  const { wallet } = window;

  // ── Local state ─────────────────────────────────────────────────────────

  /** null = discovery in progress; [] = none found; [...] = found some */
  const [credentials, setCredentials] = useState<DiscoveredCredential[] | null>(
    null
  );

  /** Display name input for fresh enrollment */
  const [displayName, setDisplayName] = useState("");
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);

  /** Track whether the component is still mounted to avoid setState after unmount */
  const mountedRef = useRef(true);

  // ── Credential discovery on mount ────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;

    wallet
      .invoke("credential:discover", { devicePath })
      .then((result) => {
        if (!mountedRef.current) return;
        const items = result as Array<{
          credentialId: string;
          userDisplayName?: string;
          displayName?: string;
        }>;
        const mapped: DiscoveredCredential[] = Array.isArray(items)
          ? items.slice(0, 20).map((c) => ({
              credentialId: c.credentialId,
              userDisplayName: c.userDisplayName ?? c.displayName ?? c.credentialId,
            }))
          : [];
        setCredentials(mapped);
      })
      .catch(() => {
        if (mountedRef.current) setCredentials([]);
      });

    return () => {
      mountedRef.current = false;
    };
  }, [devicePath, wallet]);

  // ── enrollment:progress subscription ─────────────────────────────────────
  // EnrollView subscribes here so it can react to `complete` and call onEnroll
  // completion logic. The stage prop is also updated via the parent through the
  // useWalletState hook, but we observe it locally to call onComplete when needed.

  // We detect `complete` via the enrollmentStage prop (driven by useWalletState)
  // rather than subscribing again — avoids duplicate listeners.
  const prevStageRef = useRef<EnrollmentState>(enrollmentStage);
  useEffect(() => {
    if (
      prevStageRef.current !== "complete" &&
      enrollmentStage === "complete"
    ) {
      // Req 2.10: transition to wallet view on complete — App.tsx handles this
      // via session:changed, so we just let the stage message show briefly.
    }
    prevStageRef.current = enrollmentStage;
  }, [enrollmentStage]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleCancel = useCallback(async () => {
    try {
      await wallet.invoke("enrollment:cancel");
    } catch {
      // Best-effort cancel; always proceed to onCancel
    }
    onCancel();
  }, [wallet, onCancel]);

  const handleEnrollSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = displayName.trim();
      if (!trimmed) {
        setDisplayNameError("Please enter a name for this key.");
        return;
      }
      setDisplayNameError(null);
      onEnroll(trimmed);
    },
    [displayName, onEnroll]
  );

  const handleSelectCredential = useCallback(
    (credentialId: string) => {
      wallet.invoke("credential:select", { credentialId });
    },
    [wallet]
  );

  // ── Render ───────────────────────────────────────────────────────────────

  // When enrollment is actively in progress (stage is not idle), show the
  // stage progress overlay regardless of credential discovery state.
  const isEnrolling =
    enrollmentStage !== "idle" && enrollmentStage !== "failed";

  // Stage message for aria-live region
  const stageMessage =
    enrollmentStage !== "idle"
      ? STAGE_MESSAGES[enrollmentStage as Exclude<EnrollmentState, "idle">]
      : null;

  return (
    <main role="main" aria-label="Enroll hardware security key">
      <h1>Hardware Security Key</h1>

      {/* ── Stage progress (shown whenever a stage is active) ──────────── */}
      {stageMessage && (
        <section aria-label="Enrollment progress">
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="stage-message"
          >
            {stageMessage}
          </p>

          {/* Req 12.3: PIN setup guidance when checking-pin stage is active */}
          {enrollmentStage === "checking-pin" && (
            <aside
              role="note"
              aria-label="PIN setup guidance"
              className="pin-guidance"
            >
              <p>
                <strong>PIN required:</strong> Your security key needs a PIN
                before enrollment. Please set a PIN using your device management
                software or browser (e.g., chrome://settings/securityKeys) and
                then try again.
              </p>
            </aside>
          )}

          {/* Failed state: show retry affordance */}
          {enrollmentStage === "failed" && (
            <p role="alert" aria-live="assertive" className="error-message">
              Enrollment failed. Please try again.
            </p>
          )}
        </section>
      )}

      {/* ── Cancel button — always available except on complete ──────────── */}
      {enrollmentStage !== "complete" && (
        <button
          type="button"
          onClick={handleCancel}
          aria-label="Cancel enrollment and return to idle"
          disabled={isEnrolling && enrollmentStage === "storing-metadata"}
        >
          Cancel
        </button>
      )}

      {/* ── Discovery in progress: show loading indicator ──────────────── */}
      {credentials === null && !isEnrolling && enrollmentStage === "idle" && (
        <p role="status" aria-live="polite" aria-label="Checking device...">
          Checking device...
        </p>
      )}

      {/* ── Credential selection list (1+ credentials found) ────────────── */}
      {credentials !== null && credentials.length > 0 && !isEnrolling && (
        <section aria-label="Select an existing credential">
          <h2>Select a credential</h2>
          <p>
            Select an existing credential to unlock your wallet, or enroll a new
            one.
          </p>
          <ul
            role="list"
            aria-label={`${credentials.length} credential${credentials.length === 1 ? "" : "s"} found`}
          >
            {credentials.map((cred) => (
              <li key={cred.credentialId} role="listitem">
                <button
                  type="button"
                  onClick={() => handleSelectCredential(cred.credentialId)}
                  aria-label={`Use credential: ${cred.userDisplayName}`}
                  className="credential-button"
                >
                  {cred.userDisplayName}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Enrollment form (0 credentials found, no enrollment in progress) */}
      {credentials !== null && credentials.length === 0 && !isEnrolling && (
        <section aria-label="New enrollment">
          <h2>Create a new wallet</h2>
          <p>
            No existing credentials found on this key. Enter a name and enroll
            your hardware security key to create a Solana wallet.
          </p>
          <form
            onSubmit={handleEnrollSubmit}
            aria-label="Enrollment form"
            noValidate
          >
            <div>
              <label htmlFor="enroll-display-name">Key name</label>
              <input
                id="enroll-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. My YubiKey"
                aria-required="true"
                aria-describedby={
                  displayNameError ? "enroll-name-error" : undefined
                }
                aria-invalid={displayNameError != null}
                autoComplete="off"
                maxLength={64}
              />
              {displayNameError && (
                <span
                  id="enroll-name-error"
                  role="alert"
                  aria-live="assertive"
                  className="field-error"
                >
                  {displayNameError}
                </span>
              )}
            </div>
            <button
              type="submit"
              aria-label="Start enrollment with this key name"
              disabled={displayName.trim().length === 0}
            >
              Enroll Key
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
