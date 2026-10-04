// src/renderer/hooks/useWalletState.ts
//
// Custom hook that subscribes to all IpcEvent push events via the preload
// bridge (window.wallet.on/off) and exposes a unified, typed wallet state to
// React components.
//
// All state mutations happen through a single `useReducer` so the transition
// logic stays in one place and is easy to unit-test.

import { useEffect, useReducer } from "react";
import type {
  SessionPublicData,
  ErrorCategory,
  EnrollmentState,
  EventName,
  EventListener,
} from "../../shared/ipc-types";

// ─── Device state ─────────────────────────────────────────────────────────────

export interface ConnectedDevice {
  devicePath: string;
  supportsHmacSecret: boolean;
}

export type DeviceStatus =
  | { kind: "none" }
  | { kind: "connected"; device: ConnectedDevice }
  | { kind: "unsupported"; reason: string };

// ─── Balance state ────────────────────────────────────────────────────────────

export type BalanceStatus =
  | { kind: "idle" }
  | { kind: "available"; sol: string; lamports: string }
  | { kind: "unavailable" };

// ─── Enrollment state ─────────────────────────────────────────────────────────

export type EnrollmentStatus =
  | { kind: "idle" }
  | { kind: "in-progress"; stage: EnrollmentState };

// ─── Error state ──────────────────────────────────────────────────────────────

export interface WalletError {
  category: ErrorCategory;
  message: string;
}

// ─── Unified wallet state ─────────────────────────────────────────────────────

export interface WalletState {
  /** Current device detection status. */
  deviceStatus: DeviceStatus;

  /**
   * Active session, or null when no session is open.
   * Populated by `session:changed` events.
   */
  session: SessionPublicData | null;

  /** Balance for the active session's wallet address. */
  balanceStatus: BalanceStatus;

  /** Enrollment progress for the in-progress enrollment flow. */
  enrollmentStatus: EnrollmentStatus;

  /**
   * Most recent error pushed by the main process, or null.
   * Cleared on the next successful session:changed event.
   */
  lastError: WalletError | null;
}

const initialState: WalletState = {
  deviceStatus: { kind: "none" },
  session: null,
  balanceStatus: { kind: "idle" },
  enrollmentStatus: { kind: "idle" },
  lastError: null,
};

// ─── Reducer actions ──────────────────────────────────────────────────────────

type WalletAction =
  | {
      type: "DEVICE_CONNECTED";
      devicePath: string;
      supportsHmacSecret: boolean;
    }
  | { type: "DEVICE_REMOVED"; devicePath: string }
  | { type: "DEVICE_UNSUPPORTED"; reason: string }
  | { type: "SESSION_CHANGED"; session: SessionPublicData | null }
  | { type: "BALANCE_UPDATED"; sol: string; lamports: string }
  | { type: "BALANCE_UNAVAILABLE" }
  | { type: "ENROLLMENT_PROGRESS"; stage: EnrollmentState }
  | { type: "ERROR"; category: ErrorCategory; message: string };

function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "DEVICE_CONNECTED":
      return {
        ...state,
        deviceStatus: {
          kind: "connected",
          device: {
            devicePath: action.devicePath,
            supportsHmacSecret: action.supportsHmacSecret,
          },
        },
      };

    case "DEVICE_REMOVED":
      // Only clear device status if the removed path matches the connected one.
      if (
        state.deviceStatus.kind === "connected" &&
        state.deviceStatus.device.devicePath === action.devicePath
      ) {
        return {
          ...state,
          deviceStatus: { kind: "none" },
          // Session is terminated by the main process; wait for session:changed.
          balanceStatus: { kind: "idle" },
          enrollmentStatus: { kind: "idle" },
        };
      }
      return state;

    case "DEVICE_UNSUPPORTED":
      return {
        ...state,
        deviceStatus: { kind: "unsupported", reason: action.reason },
      };

    case "SESSION_CHANGED":
      return {
        ...state,
        session: action.session,
        // Clear balance when session goes away.
        balanceStatus:
          action.session === null ? { kind: "idle" } : state.balanceStatus,
        // Clear enrollment progress when a session opens (enrollment complete).
        enrollmentStatus:
          action.session !== null ? { kind: "idle" } : state.enrollmentStatus,
        // Clear last error on successful session open.
        lastError: action.session !== null ? null : state.lastError,
      };

    case "BALANCE_UPDATED":
      return {
        ...state,
        balanceStatus: {
          kind: "available",
          sol: action.sol,
          lamports: action.lamports,
        },
      };

    case "BALANCE_UNAVAILABLE":
      return {
        ...state,
        balanceStatus: { kind: "unavailable" },
      };

    case "ENROLLMENT_PROGRESS":
      return {
        ...state,
        enrollmentStatus: {
          kind: "in-progress",
          stage: action.stage,
        },
      };

    case "ERROR":
      return {
        ...state,
        lastError: { category: action.category, message: action.message },
      };
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Subscribes to all IpcEvent push events from the main process and returns a
 * unified, typed wallet state.
 *
 * The hook registers listeners on mount and removes them on unmount.  Because
 * `window.wallet` is injected by the preload script before React renders, it
 * is always available when this hook runs.
 */
export function useWalletState(): WalletState {
  const [state, dispatch] = useReducer(walletReducer, initialState);

  useEffect(() => {
    // Grab the bridge once; it never changes after page load.
    const { wallet } = window;

    // ── device:connected ────────────────────────────────────────────────────
    const onDeviceConnected: EventListener<"device:connected"> = (data) => {
      dispatch({
        type: "DEVICE_CONNECTED",
        devicePath: data.devicePath,
        supportsHmacSecret: data.supportsHmacSecret,
      });
    };

    // ── device:removed ──────────────────────────────────────────────────────
    const onDeviceRemoved: EventListener<"device:removed"> = (data) => {
      dispatch({ type: "DEVICE_REMOVED", devicePath: data.devicePath });
    };

    // ── device:unsupported ──────────────────────────────────────────────────
    const onDeviceUnsupported: EventListener<"device:unsupported"> = (data) => {
      dispatch({ type: "DEVICE_UNSUPPORTED", reason: data.reason });
    };

    // ── session:changed ─────────────────────────────────────────────────────
    const onSessionChanged: EventListener<"session:changed"> = (data) => {
      dispatch({ type: "SESSION_CHANGED", session: data ?? null });
    };

    // ── balance:updated ─────────────────────────────────────────────────────
    const onBalanceUpdated: EventListener<"balance:updated"> = (data) => {
      dispatch({
        type: "BALANCE_UPDATED",
        sol: data.sol,
        lamports: data.lamports,
      });
    };

    // ── balance:unavailable ─────────────────────────────────────────────────
    const onBalanceUnavailable: EventListener<"balance:unavailable"> = (
      _data
    ) => {
      dispatch({ type: "BALANCE_UNAVAILABLE" });
    };

    // ── enrollment:progress ─────────────────────────────────────────────────
    const onEnrollmentProgress: EventListener<"enrollment:progress"> = (
      data
    ) => {
      dispatch({ type: "ENROLLMENT_PROGRESS", stage: data.stage });
    };

    // ── error ───────────────────────────────────────────────────────────────
    const onError: EventListener<"error"> = (data) => {
      dispatch({
        type: "ERROR",
        category: data.category,
        message: data.message,
      });
    };

    // Register all listeners.
    wallet.on("device:connected", onDeviceConnected);
    wallet.on("device:removed", onDeviceRemoved);
    wallet.on("device:unsupported", onDeviceUnsupported);
    wallet.on("session:changed", onSessionChanged);
    wallet.on("balance:updated", onBalanceUpdated);
    wallet.on("balance:unavailable", onBalanceUnavailable);
    wallet.on("enrollment:progress", onEnrollmentProgress);
    wallet.on("error", onError);

    // Fetch initial session state from main process on mount.
    wallet.invoke("session:get").then((sessionData) => {
      // Main process returns SessionPublicData | null.
      dispatch({
        type: "SESSION_CHANGED",
        session: (sessionData as SessionPublicData | null) ?? null,
      });
    });

    // Cleanup: remove all listeners on unmount.
    return () => {
      wallet.off("device:connected", onDeviceConnected);
      wallet.off("device:removed", onDeviceRemoved);
      wallet.off("device:unsupported", onDeviceUnsupported);
      wallet.off("session:changed", onSessionChanged);
      wallet.off("balance:updated", onBalanceUpdated);
      wallet.off("balance:unavailable", onBalanceUnavailable);
      wallet.off("enrollment:progress", onEnrollmentProgress);
      wallet.off("error", onError);
    };
  }, []); // Empty deps: register once on mount.

  return state;
}
