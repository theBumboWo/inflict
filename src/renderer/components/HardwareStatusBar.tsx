// src/renderer/components/HardwareStatusBar.tsx
//
// Persistent hardware status bar that maps wallet state to one of six named
// visual states and renders a coloured dot + label.
//
// Hardware state → visual state mapping:
//   no device                          → SEARCHING  (amber pulse)
//   unsupported device                 → DISCONNECTED (dim)
//   device connected, no session,
//     enrollment in progress           → AUTHENTICATING (cyan pulse)
//   device connected, no session,
//     enrollment idle                  → CONNECTED (green)
//   session active                     → READY (green, stable)
//   lastError present                  → ERROR (red)
//   device removed after session        → DISCONNECTED (dim)
//
// Props:
//   The component derives everything it needs from three slices of WalletState
//   that are passed as individual props to keep the interface narrow and easy
//   to test.

import React from "react";
import type {
  DeviceStatus,
  EnrollmentStatus,
  WalletError,
} from "../hooks/useWalletState";
import type { SessionPublicData } from "../../shared/ipc-types";

// ─── Visual state type ────────────────────────────────────────────────────────

export type HardwareVisualState =
  | "searching"
  | "connected"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "error";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface HardwareStatusBarProps {
  deviceStatus: DeviceStatus;
  session: SessionPublicData | null;
  enrollmentStatus: EnrollmentStatus;
  lastError: WalletError | null;
}

// ─── State derivation ─────────────────────────────────────────────────────────

/**
 * Pure function that maps wallet state slices to a HardwareVisualState.
 * Exported so it can be unit-tested independently.
 */
export function deriveVisualState(
  deviceStatus: DeviceStatus,
  session: SessionPublicData | null,
  enrollmentStatus: EnrollmentStatus,
  lastError: WalletError | null
): HardwareVisualState {
  // Errors take priority over other states.
  if (lastError !== null) return "error";

  // Session active → ready.
  if (session !== null) return "ready";

  // No device or unsupported device → searching / disconnected.
  if (deviceStatus.kind === "none") return "searching";
  if (deviceStatus.kind === "unsupported") return "disconnected";

  // Device connected — check enrollment.
  if (enrollmentStatus.kind === "in-progress") return "authenticating";

  return "connected";
}

// ─── Label and colour config ──────────────────────────────────────────────────

interface StateConfig {
  label: string;
  /** CSS class applied to the dot element. */
  dotClass: string;
  /** CSS class applied to the label text. */
  textClass: string;
}

const STATE_CONFIG: Record<HardwareVisualState, StateConfig> = {
  searching: {
    label: "SEARCHING",
    dotClass: "hw-status-dot hw-status-dot--searching",
    textClass: "hw-status-label hw-status-label--searching",
  },
  connected: {
    label: "CONNECTED",
    dotClass: "hw-status-dot hw-status-dot--connected",
    textClass: "hw-status-label hw-status-label--connected",
  },
  authenticating: {
    label: "AUTHENTICATING",
    dotClass: "hw-status-dot hw-status-dot--authenticating",
    textClass: "hw-status-label hw-status-label--authenticating",
  },
  ready: {
    label: "READY",
    dotClass: "hw-status-dot hw-status-dot--ready",
    textClass: "hw-status-label hw-status-label--ready",
  },
  disconnected: {
    label: "DISCONNECTED",
    dotClass: "hw-status-dot hw-status-dot--disconnected",
    textClass: "hw-status-label hw-status-label--disconnected",
  },
  error: {
    label: "ERROR",
    dotClass: "hw-status-dot hw-status-dot--error",
    textClass: "hw-status-label hw-status-label--error",
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * HardwareStatusBar — always-visible strip at the bottom of the app shell
 * that displays the current hardware/session state.
 *
 * Accessibility:
 *   - role="status" with aria-live="polite" so screen readers announce changes
 *     without interrupting.
 *   - aria-label provides a full human-readable description of the current state.
 */
export function HardwareStatusBar({
  deviceStatus,
  session,
  enrollmentStatus,
  lastError,
}: HardwareStatusBarProps): React.ReactElement {
  const visualState = deriveVisualState(
    deviceStatus,
    session,
    enrollmentStatus,
    lastError
  );
  const config = STATE_CONFIG[visualState];

  return (
    <div
      className="hw-status-bar"
      role="status"
      aria-live="polite"
      aria-label={`Hardware status: ${config.label}`}
    >
      <span className={config.dotClass} aria-hidden="true" />
      <span className={config.textClass}>{config.label}</span>
    </div>
  );
}
