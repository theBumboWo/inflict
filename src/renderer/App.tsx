// src/renderer/App.tsx
//
// Top-level React component.  Acts as the application state machine router,
// selecting which view to render based on device and session state.
//
// State machine transitions:
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │                         State Machine                               │
//   │                                                                     │
//   │  no device connected ──────────────────────────────> IdleView       │
//   │  device connected, unsupported ────────────────────> IdleView       │
//   │        (with unsupportedReason prop)                                │
//   │                                                                     │
//   │  device connected, no session, 0 or 1 credential ──> EnrollView    │
//   │  device connected, no session, N>1 credentials ────> CredentialSel.│
//   │                                                                     │
//   │  session active, receiving ─────────────────────────> ReceiveView   │
//   │  session active, sending ───────────────────────────> SendView      │
//   │  session active, idle ──────────────────────────────> WalletView    │
//   └─────────────────────────────────────────────────────────────────────┘
//
// The `useWalletState` hook provides all state derived from IPC push events.
// App.tsx owns local state for active overlay flows: `isSending` and
// `isReceiving`, because they are pure UI navigation that does not depend
// on IPC.

import React, { useState, useCallback, useEffect } from "react";

import { useWalletState } from "./hooks/useWalletState";
import type { CredentialOption } from "./views/CredentialSelectionView";

import { IdleView } from "./views/IdleView";
import { EnrollView } from "./views/EnrollView";
import {
  CredentialSelectionView,
} from "./views/CredentialSelectionView";
import { WalletView } from "./views/WalletView";
import { SendView } from "./views/SendView";
import { ReceiveView } from "./views/ReceiveView";
import { DiagnosticView } from "./views/DiagnosticView";
import { HardwareStatusBar } from "./components/HardwareStatusBar";

// ─── App component ────────────────────────────────────────────────────────────

export default function App(): React.ReactElement {
  const walletState = useWalletState();
  const { wallet } = window;

  // Local UI state: whether the send flow is active on top of WalletView.
  const [isSending, setIsSending] = useState(false);

  // Local UI state: whether the receive view is active on top of WalletView.
  const [isReceiving, setIsReceiving] = useState(false);

  // Local UI state: whether the hardware diagnostic panel is visible.
  // Toggled with Ctrl+Shift+D (or Cmd+Shift+D on macOS).
  const [isDiagnosing, setIsDiagnosing] = useState(false);

  // Register keyboard shortcut for the diagnostic panel.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setIsDiagnosing((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────

  /** Start enrollment on the currently connected device. */
  const handleEnroll = useCallback(
    (displayName: string) => {
      wallet.invoke("enrollment:start", { displayName });
    },
    [wallet]
  );

  /** Cancel the in-progress enrollment. */
  const handleCancelEnroll = useCallback(() => {
    wallet.invoke("enrollment:cancel");
  }, [wallet]);

  /** Select a specific credential for wallet derivation. */
  const handleSelectCredential = useCallback(
    (credentialId: string) => {
      const { deviceStatus } = walletState;
      if (deviceStatus.kind !== "connected") return;
      wallet.invoke("credential:select", { credentialId });
    },
    [wallet, walletState]
  );

  /** Trigger a balance refresh from WalletView. */
  const handleRefreshBalance = useCallback(() => {
    wallet.invoke("balance:refresh");
  }, [wallet]);

  /** Copy the wallet address to clipboard. */
  const handleCopyAddress = useCallback(() => {
    wallet.invoke("address:copy");
  }, [wallet]);

  /** Terminate the current session from WalletView. */
  const handleTerminateSession = useCallback(() => {
    wallet.invoke("session:terminate");
  }, [wallet]);

  /** Open the send flow. */
  const handleSend = useCallback(() => {
    setIsSending(true);
  }, []);

  /** Close the send flow, return to WalletView (cancel or done). */
  const handleBackFromSend = useCallback(() => {
    setIsSending(false);
  }, []);

  /** Open the receive view. */
  const handleReceive = useCallback(() => {
    setIsReceiving(true);
  }, []);

  /** Close the receive view, return to WalletView. */
  const handleBackFromReceive = useCallback(() => {
    setIsReceiving(false);
  }, []);

  /** Close the diagnostic panel. */
  const handleCloseDiagnostic = useCallback(() => {
    setIsDiagnosing(false);
  }, []);

  // ── Routing ─────────────────────────────────────────────────────────────

  const { deviceStatus, session, balanceStatus, enrollmentStatus } =
    walletState;

  // Shared status bar rendered on every path.
  const statusBar = (
    <HardwareStatusBar
      deviceStatus={deviceStatus}
      session={session}
      enrollmentStatus={enrollmentStatus}
      lastError={walletState.lastError}
    />
  );

  // Diagnostic overlay: shown on top of any view when isDiagnosing is true.
  if (isDiagnosing) {
    return (
      <>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hardware diagnostic"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <DiagnosticView onClose={handleCloseDiagnostic} />
        </div>
        {statusBar}
      </>
    );
  }

  // 1. Session active: show WalletView, SendView, or ReceiveView.
  if (session !== null) {
    if (isReceiving) {
      return (
        <>
          <div className="view-transition">
            <ReceiveView
              walletAddress={session.walletAddress}
              onBack={handleBackFromReceive}
            />
          </div>
          {statusBar}
        </>
      );
    }
    if (isSending) {
      // Derive currentBalanceLamports from balanceStatus for the SendView.
      const currentBalanceLamports =
        balanceStatus.kind === "available"
          ? BigInt(balanceStatus.lamports)
          : 0n;
      return (
        <>
          <div className="view-transition">
            <SendView
              currentBalanceLamports={currentBalanceLamports}
              onBack={handleBackFromSend}
            />
          </div>
          {statusBar}
        </>
      );
    }
    return (
      <>
        <div className="view-transition">
          <WalletView
            session={session}
            balanceStatus={balanceStatus}
            onRefreshBalance={handleRefreshBalance}
            onCopyAddress={handleCopyAddress}
            onReceive={handleReceive}
            onSend={handleSend}
            onTerminateSession={handleTerminateSession}
          />
        </div>
        {statusBar}
      </>
    );
  }

  // 2. No session — check device status.

  // 2a. No device or unsupported device → IdleView.
  if (deviceStatus.kind === "none") {
    return (
      <>
        <div className="view-transition"><IdleView /></div>
        {statusBar}
      </>
    );
  }

  if (deviceStatus.kind === "unsupported") {
    return (
      <>
        <div className="view-transition">
          <IdleView unsupportedReason={deviceStatus.reason} />
        </div>
        {statusBar}
      </>
    );
  }

  // 2b. Device connected — determine enrollment / credential state.
  // The main process pushes credential data via session:changed or enrollment
  // events.  App.tsx derives the credential list from a credential:discover
  // call issued when the device connects (see below).  For now, track
  // discovered credentials in a piece of local state that gets populated once
  // credential:discover resolves.
  //
  // Until credentials have been queried, show EnrollView (which the main
  // process will transition away from once derivation succeeds).
  return (
    <>
      <div className="view-transition">
        <DeviceConnectedRouter
          devicePath={deviceStatus.device.devicePath}
          enrollmentStage={
            enrollmentStatus.kind === "in-progress"
              ? enrollmentStatus.stage
              : "idle"
          }
          onEnroll={handleEnroll}
          onCancelEnroll={handleCancelEnroll}
          onSelectCredential={handleSelectCredential}
        />
      </div>
      {statusBar}
    </>
  );
}

// ─── DeviceConnectedRouter ────────────────────────────────────────────────────
//
// Sub-component rendered when a device is connected but no session is active.
// Issues a credential:discover IPC call once on mount and routes to either
// EnrollView (0 or 1 credential) or CredentialSelectionView (N > 1).

interface DeviceConnectedRouterProps {
  devicePath: string;
  enrollmentStage: import("../../src/shared/ipc-types").EnrollmentState;
  onEnroll: (displayName: string) => void;
  onCancelEnroll: () => void;
  onSelectCredential: (credentialId: string) => void;
}

function DeviceConnectedRouter({
  devicePath,
  enrollmentStage,
  onEnroll,
  onCancelEnroll,
  onSelectCredential,
}: DeviceConnectedRouterProps): React.ReactElement {
  // Credentials discovered on this device for rpId "key-wallet.local".
  // null = query in progress; [] = no credentials found.
  const [credentials, setCredentials] = useState<CredentialOption[] | null>(
    null
  );

  const { wallet } = window;

  // Issue credential:discover once when the component mounts (device path is
  // stable while this component is rendered).
  React.useEffect(() => {
    let cancelled = false;

    wallet
      .invoke("credential:discover", { devicePath })
      .then((result) => {
        if (cancelled) return;
        // Main process returns an array of { credentialId, displayName }.
        const items = result as Array<{
          credentialId: string;
          displayName: string;
        }>;
        setCredentials(
          Array.isArray(items)
            ? items.map((c) => ({
                credentialId: c.credentialId,
                displayName: c.displayName,
              }))
            : []
        );
      })
      .catch(() => {
        if (!cancelled) setCredentials([]);
      });

    return () => {
      cancelled = true;
    };
  }, [devicePath, wallet]);

  // While discovery is in progress, show EnrollView in its checking stage.
  if (credentials === null) {
    return (
      <EnrollView
        devicePath={devicePath}
        enrollmentStage={enrollmentStage === "idle" ? "checking-pin" : enrollmentStage}
        onEnroll={onEnroll}
        onCancel={onCancelEnroll}
      />
    );
  }

  // N > 1 credentials → let the user choose.
  if (credentials.length > 1) {
    return (
      <CredentialSelectionView
        credentials={credentials}
        onSelect={onSelectCredential}
        onCancel={onCancelEnroll}
      />
    );
  }

  // 0 or 1 credential → EnrollView handles both cases:
  //   0 → prompt enrollment
  //   1 → main process automatically derives once credential:select is called
  //       (EnrollView will call onEnroll or the main process picks it up
  //        via credential:discover response — this is wired in task 20.1)
  return (
    <EnrollView
      devicePath={devicePath}
      enrollmentStage={enrollmentStage}
      onEnroll={onEnroll}
      onCancel={onCancelEnroll}
    />
  );
}
