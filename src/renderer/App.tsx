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
//   │  session active, not sending ──────────────────────> WalletView     │
//   │  session active, send flow ────────────────────────> SendView       │
//   └─────────────────────────────────────────────────────────────────────┘
//
// The `useWalletState` hook provides all state derived from IPC push events.
// App.tsx owns one piece of local state: `isSending` (whether the send flow
// is active), because it is pure UI navigation that does not depend on IPC.

import React, { useState, useCallback } from "react";

import { useWalletState } from "./hooks/useWalletState";
import type { CredentialOption } from "./views/CredentialSelectionView";

import { IdleView } from "./views/IdleView";
import { EnrollView } from "./views/EnrollView";
import {
  CredentialSelectionView,
} from "./views/CredentialSelectionView";
import { WalletView } from "./views/WalletView";
import { SendView } from "./views/SendView";

// ─── App component ────────────────────────────────────────────────────────────

export default function App(): React.ReactElement {
  const walletState = useWalletState();
  const { wallet } = window;

  // Local UI state: whether the send flow is active on top of WalletView.
  const [isSending, setIsSending] = useState(false);

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

  // ── Routing ─────────────────────────────────────────────────────────────

  const { deviceStatus, session, balanceStatus, enrollmentStatus } =
    walletState;

  // 1. Session active: show WalletView or SendView.
  if (session !== null) {
    if (isSending) {
      // Derive currentBalanceLamports from balanceStatus for the SendView.
      const currentBalanceLamports =
        balanceStatus.kind === "available"
          ? BigInt(balanceStatus.lamports)
          : 0n;
      return (
        <SendView
          currentBalanceLamports={currentBalanceLamports}
          onBack={handleBackFromSend}
        />
      );
    }
    return (
      <WalletView
        session={session}
        balanceStatus={balanceStatus}
        onRefreshBalance={handleRefreshBalance}
        onCopyAddress={handleCopyAddress}
        onSend={handleSend}
        onTerminateSession={handleTerminateSession}
      />
    );
  }

  // 2. No session — check device status.

  // 2a. No device or unsupported device → IdleView.
  if (deviceStatus.kind === "none") {
    return <IdleView />;
  }

  if (deviceStatus.kind === "unsupported") {
    return <IdleView unsupportedReason={deviceStatus.reason} />;
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
