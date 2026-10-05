// src/renderer/views/IdleView.tsx
//
// Hardware connection screen — shown when no compatible hardware security key
// is connected, or when a connected device is unsupported.
//
// States:
//   • searching    — no device connected; pulse animation on the key icon
//   • unsupported  — device connected but not FIDO2/hmac-secret capable
//   • connected    — device recognised (transitional; visible only briefly)
//
// Task 36.2: full redesign with polished dark-theme UI.

import React from "react";

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface IdleViewProps {
  /** Set when the main process reports a connected but unsupported device. */
  unsupportedReason?: string;
  /**
   * Explicit device status override.
   * When omitted, the component infers the status from `unsupportedReason`:
   *   • undefined  → "searching"
   *   • defined    → "unsupported"
   */
  deviceKind?: "none" | "connected" | "unsupported";
}

// ─── Hardware Key SVG Icon ─────────────────────────────────────────────────────

/**
 * Outline hardware security key icon.
 * Drawn as a USB key: rectangular body + cylindrical USB plug.
 */
function HardwareKeyIcon({
  className,
  "aria-hidden": ariaHidden = true,
}: {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 80 48"
      fill="none"
      aria-hidden={ariaHidden}
      focusable="false"
      className={className}
      style={{ display: "block" }}
    >
      {/* Key fob body */}
      <rect
        x="2"
        y="10"
        width="50"
        height="28"
        rx="8"
        ry="8"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      {/* Contact pads on key fob */}
      <rect x="10" y="18" width="8" height="12" rx="2" fill="currentColor" opacity="0.5" />
      <rect x="24" y="18" width="8" height="12" rx="2" fill="currentColor" opacity="0.5" />
      {/* USB plug neck */}
      <rect
        x="52"
        y="20"
        width="10"
        height="8"
        fill="currentColor"
        opacity="0.35"
      />
      {/* USB Type-A plug housing */}
      <rect
        x="62"
        y="16"
        width="16"
        height="16"
        rx="2"
        ry="2"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
      />
      {/* USB plug interior detail lines */}
      <line x1="66" y1="21" x2="74" y2="21" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <line x1="66" y1="27" x2="74" y2="27" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      {/* Status LED dot on fob */}
      <circle cx="42" cy="24" r="3" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

// ─── IdleView ──────────────────────────────────────────────────────────────────

export function IdleView({
  unsupportedReason,
  deviceKind,
}: IdleViewProps): React.ReactElement {
  // Derive status from props.
  const status: "searching" | "connected" | "unsupported" = (() => {
    if (deviceKind === "connected") return "connected";
    if (deviceKind === "unsupported" || unsupportedReason != null)
      return "unsupported";
    return "searching";
  })();

  // Aria-live region label for the current status.
  const ariaLabel =
    status === "searching"
      ? "Searching for hardware security key"
      : status === "connected"
        ? "Hardware security key connected"
        : `Hardware security key unsupported: ${unsupportedReason ?? "unknown reason"}`;

  // Whether the key icon should pulse (only while searching).
  const iconPulses = status === "searching";

  return (
    <main
      role="main"
      aria-label={ariaLabel}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        width: "100%",
        textAlign: "center",
        gap: 0,
        padding: "var(--space-8) var(--space-6)",
        backgroundColor: "var(--bg-primary)",
      }}
    >
      {/* ── Wordmark ──────────────────────────────────────────────────────── */}
      <header
        aria-label="KeyWallet application"
        style={{
          marginBottom: "var(--space-2)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-semibold)",
            letterSpacing: "0.22em",
            textTransform: "uppercase" as const,
            fontVariant: "small-caps",
            color: "var(--text-primary)",
            lineHeight: "var(--line-height-tight)",
          }}
        >
          KEYWALLET
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-xs)",
            color: "var(--text-tertiary)",
            letterSpacing: "0.14em",
            textTransform: "uppercase" as const,
            marginTop: "var(--space-1)",
          }}
        >
          HARDWARE IDENTITY
        </span>
      </header>

      {/* ── Key icon ──────────────────────────────────────────────────────── */}
      <section
        aria-label="Hardware key graphic"
        style={{
          marginTop: "var(--space-12)",
          marginBottom: "var(--space-8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            color:
              status === "connected"
                ? "var(--status-connected)"
                : status === "unsupported"
                  ? "var(--status-error)"
                  : "var(--accent)",
            width: 120,
            height: 72,
            animation: iconPulses ? "idle-key-pulse 2.4s ease-in-out infinite" : undefined,
          }}
          aria-hidden="true"
        >
          <HardwareKeyIcon
            className={undefined}
            aria-hidden={true}
          />
        </div>
      </section>

      {/* ── Primary label ─────────────────────────────────────────────────── */}
      <p
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--font-size-base)",
          fontWeight: "var(--font-weight-medium)",
          color: "var(--text-primary)",
          marginBottom: "var(--space-4)",
          letterSpacing: "0.01em",
        }}
      >
        {status === "connected"
          ? "Security key detected"
          : "Insert your security key"}
      </p>

      {/* ── Status indicator ──────────────────────────────────────────────── */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={ariaLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-xs)",
          letterSpacing: "0.08em",
          textTransform: "uppercase" as const,
          padding: "var(--space-1) var(--space-3)",
          borderRadius: "var(--radius-full)",
          ...(status === "connected"
            ? {
                color: "var(--status-connected)",
                backgroundColor: "rgba(0, 255, 136, 0.10)",
                border: "1px solid rgba(0, 255, 136, 0.25)",
              }
            : status === "unsupported"
              ? {
                  color: "var(--status-error)",
                  backgroundColor: "rgba(255, 68, 85, 0.10)",
                  border: "1px solid rgba(255, 68, 85, 0.25)",
                }
              : {
                  color: "var(--status-searching)",
                  backgroundColor: "rgba(255, 204, 0, 0.10)",
                  border: "1px solid rgba(255, 204, 0, 0.25)",
                }),
        }}
      >
        {/* Coloured dot */}
        <span
          aria-hidden="true"
          className={
            status === "connected"
              ? "status-dot status-dot--connected"
              : status === "unsupported"
                ? "status-dot status-dot--error"
                : "status-dot status-dot--searching"
          }
        />
        {status === "connected"
          ? "CONNECTED"
          : status === "unsupported"
            ? "UNSUPPORTED"
            : "SEARCHING"}
      </div>

      {/* ── Unsupported device error (inline, Req 1.3) ────────────────────── */}
      {status === "unsupported" && unsupportedReason != null && (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          style={{
            marginTop: "var(--space-6)",
            maxWidth: 340,
            textAlign: "center" as const,
            backgroundColor: "rgba(255, 68, 85, 0.07)",
            border: "1px solid rgba(255, 68, 85, 0.30)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-4) var(--space-5)",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "var(--font-size-sm)",
              color: "var(--text-primary)",
              marginBottom: "var(--space-2)",
              fontWeight: "var(--font-weight-medium)",
            }}
          >
            Device not supported
          </p>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-xs)",
              color: "var(--status-error)",
              marginBottom: 0,
              letterSpacing: "0.02em",
              wordBreak: "break-word",
            }}
          >
            {unsupportedReason}
          </p>
        </div>
      )}
    </main>
  );
}
