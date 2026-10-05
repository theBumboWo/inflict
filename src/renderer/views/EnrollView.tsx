// src/renderer/views/EnrollView.tsx
//
// Enrollment view — displayed when a device is connected but no active session
// exists, or when enrollment is in progress.
//
// Redesign (task 36.3): polished visual treatment using the KeyWallet design
// system. Highlights:
//   - Step indicator showing the current enrollment stage
//   - Animated touch-ripple on the key icon for the "awaiting-touch" state
//   - PIN guidance as a collapsible info box (not a modal)
//   - Name input with floating label (minimal underline style)
//   - Cancel as a subtle text link rather than a large button
//
// Requirements: Req 2.1, Req 2.6, Req 2.10, Req 12.3

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { EnrollmentState } from "../../shared/ipc-types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredCredential {
  credentialId: string;
  userDisplayName: string;
}

// ─── Step indicator data ──────────────────────────────────────────────────────

// The ordered list of active stages shown in the step indicator.
const ENROLLMENT_STEPS: Array<Exclude<EnrollmentState, "idle" | "failed">> = [
  "checking-pin",
  "awaiting-touch",
  "storing-metadata",
  "complete",
];

const STEP_LABELS: Record<Exclude<EnrollmentState, "idle" | "failed">, string> = {
  "checking-pin":    "Verify PIN",
  "awaiting-touch":  "Touch Key",
  "storing-metadata": "Finalise",
  "complete":        "Done",
};

// ─── Stage messages ───────────────────────────────────────────────────────────

const STAGE_MESSAGES: Record<Exclude<EnrollmentState, "idle">, string> = {
  "checking-pin":    "Verifying your device PIN…",
  "awaiting-touch":  "Touch your security key when prompted",
  "storing-metadata": "Finalising — please wait…",
  "complete":        "Enrollment complete!",
  "failed":          "Enrollment failed. Please try again.",
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

// ─── Inline styles ────────────────────────────────────────────────────────────
//
// These supplement the design-system classes where a one-off property is needed
// that would not warrant its own utility class.

const sx = {
  // ── Layout wrapper ───────────────────────────────────────────────────────
  main: {
    animation: "slide-up var(--transition-slow) both",
  } as React.CSSProperties,

  // ── Header area ──────────────────────────────────────────────────────────
  header: {
    textAlign: "center" as const,
    marginBottom: "var(--space-8)",
  } as React.CSSProperties,

  heading: {
    fontSize: "var(--font-size-xl)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--text-primary)",
    marginBottom: "var(--space-2)",
    letterSpacing: "-0.01em",
  } as React.CSSProperties,

  subheading: {
    fontSize: "var(--font-size-sm)",
    color: "var(--text-tertiary)",
    margin: 0,
  } as React.CSSProperties,

  // ── Step indicator ───────────────────────────────────────────────────────
  stepRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    marginBottom: "var(--space-8)",
  } as React.CSSProperties,

  stepItem: (_isActive: boolean, _isDone: boolean): React.CSSProperties => ({
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "var(--space-1)",
    flex: "0 0 auto",
  }),

  stepDot: (isActive: boolean, isDone: boolean): React.CSSProperties => ({
    width: 28,
    height: 28,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--font-size-xs)",
    fontWeight: "var(--font-weight-semibold)",
    transition: "all var(--transition-base)",
    border: isDone || isActive
      ? "2px solid var(--accent)"
      : "2px solid var(--border-default)",
    background: isDone
      ? "var(--accent)"
      : isActive
        ? "var(--accent-dim)"
        : "transparent",
    color: isDone
      ? "var(--text-inverse)"
      : isActive
        ? "var(--accent)"
        : "var(--text-tertiary)",
    boxShadow: isActive ? "0 0 10px rgba(0,229,255,0.35)" : "none",
  }),

  stepLabel: (isActive: boolean, isDone: boolean): React.CSSProperties => ({
    fontSize: "var(--font-size-xs)",
    fontWeight: isActive ? "var(--font-weight-medium)" : "var(--font-weight-regular)",
    color: isActive
      ? "var(--accent)"
      : isDone
        ? "var(--text-secondary)"
        : "var(--text-tertiary)",
    transition: "color var(--transition-base)",
    letterSpacing: "0.02em",
    textTransform: "uppercase" as const,
  }),

  stepConnector: (isDone: boolean): React.CSSProperties => ({
    flex: "1 1 0",
    height: 2,
    minWidth: 20,
    maxWidth: 48,
    background: isDone ? "var(--accent)" : "var(--border-subtle)",
    transition: "background var(--transition-slow)",
    marginBottom: "var(--space-4)",
  }),

  // ── Key icon + touch ripple area ─────────────────────────────────────────
  iconWrap: {
    position: "relative" as const,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 72,
    height: 72,
    margin: "0 auto var(--space-6)",
  } as React.CSSProperties,

  keyIconSvg: (isComplete: boolean, isFailed: boolean): React.CSSProperties => ({
    width: 40,
    height: 40,
    color: isFailed
      ? "var(--status-error)"
      : isComplete
        ? "var(--status-connected)"
        : "var(--accent)",
    transition: "color var(--transition-slow)",
    position: "relative" as const,
    zIndex: 1,
  }),

  // Ripple rings — rendered as pseudo-elements via CSS is tricky from inline;
  // we conditionally render DOM elements instead.
  rippleRing: (delay: number): React.CSSProperties => ({
    position: "absolute" as const,
    inset: 0,
    borderRadius: "50%",
    border: "2px solid var(--accent)",
    opacity: 0,
    animation: `touch-ripple 1.8s ease-out ${delay}s infinite`,
  }),

  // ── Stage message ────────────────────────────────────────────────────────
  stageMsg: {
    textAlign: "center" as const,
    fontSize: "var(--font-size-base)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--status-searching)",
    marginBottom: "var(--space-4)",
    minHeight: "1.5em",
    transition: "color var(--transition-slow)",
  } as React.CSSProperties,

  stageMsgComplete: {
    color: "var(--status-connected)",
  } as React.CSSProperties,

  stageMsgFailed: {
    color: "var(--status-error)",
  } as React.CSSProperties,

  // ── PIN guidance (collapsible) ────────────────────────────────────────────
  pinGuidanceSummary: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    cursor: "pointer",
    padding: "var(--space-4) var(--space-5)",
    listStyle: "none",
    userSelect: "none" as const,
    fontSize: "var(--font-size-sm)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--status-searching)",
  } as React.CSSProperties,

  pinGuidanceBody: {
    padding: "0 var(--space-5) var(--space-4)",
  } as React.CSSProperties,

  // ── Floating label field ─────────────────────────────────────────────────
  floatField: {
    position: "relative" as const,
    marginBottom: "var(--space-6)",
  } as React.CSSProperties,

  floatInput: (hasValue: boolean, hasError: boolean): React.CSSProperties => ({
    display: "block",
    width: "100%",
    background: "transparent",
    border: "none",
    borderBottom: hasError
      ? "2px solid var(--status-error)"
      : "2px solid var(--border-default)",
    borderRadius: 0,
    padding: "var(--space-6) 0 var(--space-2)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--font-size-base)",
    outline: "none",
    transition: "border-color var(--transition-fast)",
    boxShadow: "none",
  }),

  floatLabel: (isFocused: boolean, hasValue: boolean): React.CSSProperties => ({
    position: "absolute" as const,
    left: 0,
    top: isFocused || hasValue ? 0 : "calc(var(--space-6) + 4px)",
    fontSize: isFocused || hasValue ? "var(--font-size-xs)" : "var(--font-size-base)",
    color: isFocused
      ? "var(--accent)"
      : hasValue
        ? "var(--text-tertiary)"
        : "var(--text-tertiary)",
    transition: "all var(--transition-base)",
    pointerEvents: "none" as const,
    fontWeight: "var(--font-weight-medium)",
    letterSpacing: isFocused || hasValue ? "0.06em" : 0,
    textTransform: isFocused || hasValue ? ("uppercase" as const) : ("none" as const),
  }),

  floatUnderline: (isFocused: boolean): React.CSSProperties => ({
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    height: 2,
    background: "var(--accent)",
    width: isFocused ? "100%" : "0%",
    transition: "width var(--transition-base)",
    borderRadius: "var(--radius-full)",
  }),

  // ── Cancel link ──────────────────────────────────────────────────────────
  cancelLink: {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color: "var(--text-tertiary)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-sans)",
    textDecoration: "underline",
    textUnderlineOffset: 2,
    transition: "color var(--transition-fast)",
    display: "inline-block",
    marginTop: "var(--space-4)",
  } as React.CSSProperties,

  // ── Misc ─────────────────────────────────────────────────────────────────
  centeredActions: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "var(--space-3)",
  } as React.CSSProperties,
} as const;

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

  /** Display name field */
  const [displayName, setDisplayName] = useState("");
  const [displayNameFocused, setDisplayNameFocused] = useState(false);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);

  /** Whether the PIN guidance details box is expanded */
  const [pinGuidanceOpen, setPinGuidanceOpen] = useState(false);

  /** Track mounted state to avoid setState after unmount */
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
              userDisplayName:
                c.userDisplayName ?? c.displayName ?? c.credentialId,
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

  // ── Stage transition observer ────────────────────────────────────────────
  // Observes stage changes so side-effects can be added here if needed
  // (e.g. auto-advance, auditory cues). Actual view routing lives in App.tsx.
  const prevStageRef = useRef<EnrollmentState>(enrollmentStage);
  useEffect(() => {
    prevStageRef.current = enrollmentStage;
  }, [enrollmentStage]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleCancel = useCallback(async () => {
    try {
      await wallet.invoke("enrollment:cancel");
    } catch {
      // Best-effort cancel; always proceed
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

  // ── Derived flags ────────────────────────────────────────────────────────

  const isActiveStage = enrollmentStage !== "idle" && enrollmentStage !== "failed";
  const isEnrolling   = isActiveStage && enrollmentStage !== "complete";
  const isFailed      = enrollmentStage === "failed";
  const isComplete    = enrollmentStage === "complete";
  const isAwaitingTouch = enrollmentStage === "awaiting-touch";
  const isCheckingPin   = enrollmentStage === "checking-pin";

  // Which step index is currently active (for the step indicator)
  const activeStepIndex = ENROLLMENT_STEPS.indexOf(
    enrollmentStage as Exclude<EnrollmentState, "idle" | "failed">
  );

  const stageMessage =
    enrollmentStage !== "idle"
      ? STAGE_MESSAGES[enrollmentStage as Exclude<EnrollmentState, "idle">]
      : null;

  // Resolve stage-message colour
  const stageMsgStyle: React.CSSProperties = {
    ...sx.stageMsg,
    ...(isComplete ? sx.stageMsgComplete : {}),
    ...(isFailed ? sx.stageMsgFailed : {}),
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Touch-ripple keyframe injected once per render tree */}
      <style>{`
        @keyframes touch-ripple {
          0%   { opacity: 0.7; transform: scale(0.85); }
          100% { opacity: 0;   transform: scale(2.1);  }
        }
        .enroll-float-input:focus {
          border-bottom-color: var(--accent) !important;
          box-shadow: none !important;
          background: transparent !important;
        }
        .enroll-cancel-link:hover {
          color: var(--text-secondary) !important;
        }
        .enroll-cancel-link:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
          border-radius: var(--radius-sm);
        }
      `}</style>

      <main
        role="main"
        aria-label="Enroll hardware security key"
        style={sx.main}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header style={sx.header}>
          <h1 style={sx.heading}>Hardware Security Key</h1>
          <p style={sx.subheading}>
            {isEnrolling || isComplete
              ? "Enrollment in progress"
              : isFailed
                ? "Something went wrong"
                : "Connect and enroll your key"}
          </p>
        </header>

        {/* ── Step indicator (shown when a stage is active) ──────────────── */}
        {(isActiveStage || isFailed) && activeStepIndex !== -1 && (
          <nav
            aria-label="Enrollment steps"
            style={sx.stepRow}
          >
            {ENROLLMENT_STEPS.map((step, idx) => {
              const isDone   = idx < activeStepIndex;
              const isActive = idx === activeStepIndex;
              return (
                <React.Fragment key={step}>
                  <div
                    style={sx.stepItem(isActive, isDone)}
                    aria-current={isActive ? "step" : undefined}
                  >
                    <div
                      style={sx.stepDot(isActive, isDone)}
                      aria-hidden="true"
                    >
                      {isDone ? (
                        // Check mark SVG
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                          <path d="M2 7l4 4 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                        </svg>
                      ) : (
                        String(idx + 1)
                      )}
                    </div>
                    <span style={sx.stepLabel(isActive, isDone)}>
                      {STEP_LABELS[step]}
                    </span>
                  </div>
                  {idx < ENROLLMENT_STEPS.length - 1 && (
                    <div
                      style={sx.stepConnector(isDone)}
                      aria-hidden="true"
                    />
                  )}
                </React.Fragment>
              );
            })}
          </nav>
        )}

        {/* ── Key icon with optional touch ripple ───────────────────────── */}
        {(isActiveStage || isFailed) && (
          <div style={{ textAlign: "center" }}>
            <div style={sx.iconWrap} aria-hidden="true">
              {/* Ripple rings rendered only during awaiting-touch */}
              {isAwaitingTouch && (
                <>
                  <span style={sx.rippleRing(0)} />
                  <span style={sx.rippleRing(0.5)} />
                  <span style={sx.rippleRing(1.0)} />
                </>
              )}

              {/* Key icon SVG */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={sx.keyIconSvg(isComplete, isFailed)}
                aria-hidden="true"
              >
                <circle cx="7.5" cy="15.5" r="5.5" />
                <path d="M21 2l-9.6 9.6" />
                <path d="M15.5 7.5l3 3" />
                <path d="M18.5 4.5l2 2" />
                <circle cx="7.5" cy="15.5" r="2" fill="currentColor" stroke="none" />
              </svg>
            </div>
          </div>
        )}

        {/* ── Stage progress message ─────────────────────────────────────── */}
        {stageMessage && (
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={stageMsgStyle}
          >
            {stageMessage}
          </p>
        )}

        {/* ── Collapsible PIN guidance (checking-pin stage) ─────────────── */}
        {isCheckingPin && (
          <details
            open={pinGuidanceOpen}
            onToggle={(e) =>
              setPinGuidanceOpen((e.currentTarget as HTMLDetailsElement).open)
            }
            className="pin-guidance"
            aria-label="PIN setup guidance"
            style={{ marginBottom: "var(--space-5)", cursor: "default" }}
          >
            <summary
              style={sx.pinGuidanceSummary}
              aria-expanded={pinGuidanceOpen}
            >
              {/* Warning icon */}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 2L1.5 13.5h13L8 2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path d="M8 7v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
              </svg>
              PIN setup required
              {/* Chevron */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden="true"
                style={{
                  marginLeft: "auto",
                  transform: pinGuidanceOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform var(--transition-base)",
                }}
              >
                <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div style={sx.pinGuidanceBody}>
              <p className="pin-guidance" style={{ background: "none", border: "none", padding: 0, margin: 0 }}>
                Your security key needs a PIN before enrollment. Set one using
                your device management software or browser — for example,{" "}
                <code>chrome://settings/securityKeys</code> — then try again.
              </p>
            </div>
          </details>
        )}

        {/* ── Failed state alert ─────────────────────────────────────────── */}
        {isFailed && (
          <div
            role="alert"
            aria-live="assertive"
            className="alert alert-error animate-fade-in"
            style={{ marginBottom: "var(--space-5)" }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="8" cy="11" r="0.75" fill="currentColor" />
            </svg>
            Enrollment failed. Please remove and reinsert your key, then try again.
          </div>
        )}

        {/* ── Complete state ─────────────────────────────────────────────── */}
        {isComplete && (
          <div
            role="status"
            aria-live="polite"
            className="alert alert-success animate-fade-in"
            style={{ marginBottom: "var(--space-5)", textAlign: "center" }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Enrollment complete — opening your wallet…
          </div>
        )}

        {/* ── Spinner for mid-enrollment stages ────────────────────────── */}
        {(isEnrolling && !isAwaitingTouch) && (
          <div
            style={{ display: "flex", justifyContent: "center", marginBottom: "var(--space-5)" }}
            aria-hidden="true"
          >
            <span className="spinner" />
          </div>
        )}

        {/* ── Discovery loading ──────────────────────────────────────────── */}
        {credentials === null && !isEnrolling && enrollmentStage === "idle" && (
          <div
            style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", justifyContent: "center", marginBottom: "var(--space-5)" }}
          >
            <span className="spinner" aria-hidden="true" />
            <p
              role="status"
              aria-live="polite"
              style={{ margin: 0, color: "var(--text-tertiary)", fontSize: "var(--font-size-sm)" }}
            >
              Checking device…
            </p>
          </div>
        )}

        {/* ── Credential selection list (1+ credentials found) ──────────── */}
        {credentials !== null && credentials.length > 0 && !isEnrolling && !isFailed && (
          <section aria-label="Select an existing credential" className="animate-slide-up">
            <h2 style={{ fontSize: "var(--font-size-lg)", marginBottom: "var(--space-2)" }}>
              Select a credential
            </h2>
            <p style={{ fontSize: "var(--font-size-sm)", marginBottom: "var(--space-4)" }}>
              Choose an existing credential to unlock your wallet.
            </p>
            <ul
              role="list"
              aria-label={`${credentials.length} credential${credentials.length === 1 ? "" : "s"} found`}
              className="credential-list"
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

        {/* ── Enrollment form (0 credentials, no enrollment in progress) ─── */}
        {credentials !== null &&
          credentials.length === 0 &&
          !isEnrolling &&
          !isComplete &&
          !isFailed && (
            <section
              aria-label="New enrollment"
              className="animate-fade-in"
            >
              <h2 style={{ fontSize: "var(--font-size-lg)", marginBottom: "var(--space-2)" }}>
                Create a new wallet
              </h2>
              <p style={{ fontSize: "var(--font-size-sm)", marginBottom: "var(--space-6)" }}>
                No credentials found. Give your key a name and tap{" "}
                <strong>Enroll Key</strong> to create a Solana wallet.
              </p>

              <form
                onSubmit={handleEnrollSubmit}
                aria-label="Enrollment form"
                noValidate
              >
                {/* Floating-label name input */}
                <div style={sx.floatField}>
                  <input
                    id="enroll-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => {
                      setDisplayName(e.target.value);
                      if (displayNameError) setDisplayNameError(null);
                    }}
                    onFocus={() => setDisplayNameFocused(true)}
                    onBlur={() => setDisplayNameFocused(false)}
                    aria-required="true"
                    aria-describedby={
                      displayNameError ? "enroll-name-error" : undefined
                    }
                    aria-invalid={displayNameError != null}
                    aria-label="Key name"
                    autoComplete="off"
                    maxLength={64}
                    className="enroll-float-input"
                    style={sx.floatInput(displayName.length > 0, displayNameError != null)}
                  />
                  <label
                    htmlFor="enroll-display-name"
                    style={sx.floatLabel(displayNameFocused, displayName.length > 0)}
                  >
                    Key name
                  </label>
                  {/* Focus underline accent */}
                  <span
                    aria-hidden="true"
                    style={sx.floatUnderline(displayNameFocused)}
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

                <div style={sx.centeredActions}>
                  <button
                    type="submit"
                    className="btn btn-primary btn-full"
                    aria-label="Start enrollment with this key name"
                    disabled={displayName.trim().length === 0}
                  >
                    Enroll Key
                  </button>
                </div>
              </form>
            </section>
          )}

        {/* ── Cancel link — shown except when complete ───────────────────── */}
        {enrollmentStage !== "complete" && (
          <div style={{ textAlign: "center", marginTop: "var(--space-4)" }}>
            <button
              type="button"
              onClick={handleCancel}
              aria-label="Cancel enrollment and return to idle"
              className="enroll-cancel-link"
              style={sx.cancelLink}
              disabled={enrollmentStage === "storing-metadata"}
            >
              Cancel
            </button>
          </div>
        )}
      </main>
    </>
  );
}
