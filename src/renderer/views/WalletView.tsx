// src/renderer/views/WalletView.tsx
//
// Displays the active wallet session:
//   - Wallet address (Base58, 32–44 chars) in a prominent field
//   - QR code of the wallet address (with error boundary)
//   - Copy-address button with 2-second "Copied!" confirmation
//   - Balance in SOL (4 decimal places) or unavailable/loading indicators
//   - Manual refresh button
//   - Current credential display name as persistent label
//   - Informational banner when a second device connects
//   - "Send" and "Lock wallet" buttons
//
// SECURITY: This component MUST NEVER display, log, or render private key
// bytes or Wallet_Seed. Only SessionPublicData is accepted as a prop.

import React, { Component, useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { SessionPublicData } from "../../shared/ipc-types";
import type { BalanceStatus } from "../hooks/useWalletState";

// ─── QR Code Error Boundary ──────────────────────────────────────────────────

interface QrBoundaryState {
  hasError: boolean;
}

class QrErrorBoundary extends Component<
  { children: React.ReactNode },
  QrBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): QrBoundaryState {
    return { hasError: true };
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="img"
          aria-label="QR code error"
          style={{
            width: 160,
            height: 160,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid #c00",
            borderRadius: 4,
            color: "#c00",
            fontSize: 12,
            textAlign: "center",
            padding: 8,
          }}
        >
          QR code unavailable
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Second-device notification banner ───────────────────────────────────────

interface SecondDeviceBannerProps {
  devicePath: string;
  onDismiss: () => void;
}

function SecondDeviceBanner({
  devicePath,
  onDismiss,
}: SecondDeviceBannerProps): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Second device connected notification"
      style={{
        backgroundColor: "#fff8e1",
        border: "1px solid #f9a825",
        borderRadius: 4,
        padding: "8px 12px",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span style={{ fontSize: 14 }}>
        Another hardware key was detected ({devicePath}). Connect this key to
        switch wallets.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss second device notification"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontWeight: "bold",
          fontSize: 16,
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        ×
      </button>
    </div>
  );
}

// ─── WalletView props ─────────────────────────────────────────────────────────

export interface WalletViewProps {
  session: SessionPublicData;
  balanceStatus: BalanceStatus;
  /** Called when the user triggers a manual balance refresh. */
  onRefreshBalance: () => void;
  /** Called when the user clicks "Copy address". */
  onCopyAddress: () => void;
  /** Called when the user initiates a send transaction. */
  onSend: () => void;
  /** Called when the user terminates the session. */
  onTerminateSession: () => void;
}

// ─── WalletView ───────────────────────────────────────────────────────────────

export function WalletView({
  session,
  balanceStatus,
  onRefreshBalance,
  onCopyAddress,
  onSend,
  onTerminateSession,
}: WalletViewProps): React.ReactElement {
  // ── Copy confirmation state ────────────────────────────────────────────────
  const [showCopied, setShowCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyAddress = useCallback(() => {
    onCopyAddress();
    setShowCopied(true);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setShowCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, [onCopyAddress]);

  // Clear copy timer on unmount.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  // ── Second-device notification ─────────────────────────────────────────────
  // Track the most recently connected second device (if any) while session is
  // active. Cleared when the user dismisses the banner.
  const [secondDevicePath, setSecondDevicePath] = useState<string | null>(null);

  useEffect(() => {
    const handleDeviceConnected = (data: {
      devicePath: string;
      supportsHmacSecret: boolean;
    }): void => {
      // Only show the banner for devices different from the session's device.
      // The session doesn't track the device path, so any new connection event
      // while a session is active is treated as a second device (Req 5.6, 11.2).
      setSecondDevicePath(data.devicePath);
    };

    window.wallet.on("device:connected", handleDeviceConnected);
    return () => {
      window.wallet.off("device:connected", handleDeviceConnected);
    };
  }, []);

  const dismissSecondDeviceBanner = useCallback(() => {
    setSecondDevicePath(null);
  }, []);

  // ── Balance display ────────────────────────────────────────────────────────
  let balanceDisplay: string;
  if (balanceStatus.kind === "available") {
    // Format to exactly 4 decimal places (Req 7.3).
    const parsed = parseFloat(balanceStatus.sol);
    balanceDisplay = isNaN(parsed)
      ? balanceStatus.sol
      : parsed.toFixed(4) + " SOL";
  } else if (balanceStatus.kind === "unavailable") {
    balanceDisplay = "Balance unavailable";
  } else {
    // kind === "idle" — loading on first fetch
    balanceDisplay = "Loading balance…";
  }

  return (
    <main role="main" aria-label="Wallet">
      {/* ── Second-device notification banner ── */}
      {secondDevicePath !== null && (
        <SecondDeviceBanner
          devicePath={secondDevicePath}
          onDismiss={dismissSecondDeviceBanner}
        />
      )}

      {/* ── Credential display name (persistent indicator, Req 10.4) ── */}
      <section aria-label="Active credential">
        <p
          aria-label="Active credential display name"
          style={{ fontWeight: "bold", marginBottom: 4 }}
        >
          {session.displayName}
        </p>
      </section>

      {/* ── Wallet address (Req 6.1) ── */}
      <section aria-label="Wallet address section">
        <label htmlFor="wallet-address-field" style={{ display: "block", marginBottom: 4 }}>
          Wallet Address
        </label>
        <output
          id="wallet-address-field"
          aria-label="Wallet address"
          style={{
            display: "block",
            fontFamily: "monospace",
            fontSize: 13,
            wordBreak: "break-all",
            padding: "6px 8px",
            border: "1px solid #ccc",
            borderRadius: 4,
            backgroundColor: "#f9f9f9",
            marginBottom: 8,
          }}
        >
          {session.walletAddress}
        </output>

        {/* ── Copy address button (Req 6.2, 6.3) ── */}
        <button
          type="button"
          onClick={handleCopyAddress}
          aria-label="Copy wallet address to clipboard"
          style={{ marginRight: 8 }}
        >
          Copy Address
        </button>
        {showCopied && (
          <span
            role="status"
            aria-live="polite"
            aria-label="Address copied confirmation"
            style={{ fontSize: 13, color: "#2e7d32" }}
          >
            Copied!
          </span>
        )}
      </section>

      {/* ── QR code (Req 6.4, 6.5) ── */}
      <section aria-label="QR code section" style={{ marginTop: 12 }}>
        <QrErrorBoundary>
          <QRCodeSVG
            value={session.walletAddress}
            size={160}
            aria-label={`QR code for wallet address ${session.walletAddress}`}
            role="img"
          />
        </QrErrorBoundary>
      </section>

      {/* ── Balance display (Req 7.3, 7.4) ── */}
      <section aria-label="Balance section" style={{ marginTop: 12 }}>
        <p
          aria-live="polite"
          aria-label="Wallet balance"
          aria-atomic="true"
          style={{ marginBottom: 8 }}
        >
          {balanceDisplay}
        </p>
        <button
          type="button"
          onClick={onRefreshBalance}
          aria-label="Refresh wallet balance"
          style={{ marginRight: 8 }}
        >
          Refresh Balance
        </button>
      </section>

      {/* ── Actions ── */}
      <section aria-label="Wallet actions" style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onSend}
          aria-label="Send SOL"
        >
          Send
        </button>
        <button
          type="button"
          onClick={onTerminateSession}
          aria-label="Lock wallet and terminate session"
        >
          Lock Wallet
        </button>
      </section>
    </main>
  );
}
