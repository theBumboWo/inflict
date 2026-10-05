// src/renderer/views/WalletView.tsx
//
// Active wallet screen shown while a hardware-identity session is live.
//
// Layout:
//   ┌─────────────────────────────────────────────────────────┐
//   │  ● HARDWARE IDENTITY — CONNECTED                        │
//   │ ─────────────────────────────────────────────────────── │
//   │  WALLET                                                  │
//   │  7xKf...9pQ2                      [click to copy]       │
//   │  "Copied" toast (2 s, dismisses auto)                   │
//   │ ─────────────────────────────────────────────────────── │
//   │  0.0000              DEVNET                             │
//   │  [↓ Receive]  [↑ Send]  [⏻ Disconnect]                  │
//   └─────────────────────────────────────────────────────────┘
//
// SECURITY: This component MUST NEVER display, log, or render private key
// bytes or Wallet_Seed. Only SessionPublicData is accepted as a prop.
// (Req 6.6)

import React, {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import type { SessionPublicData } from "../../shared/ipc-types";
import type { BalanceStatus } from "../hooks/useWalletState";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Truncate a Base58 wallet address to the format `XXXX…XXXX`.
 * Shows the first 4 and last 4 characters separated by an ellipsis.
 * Falls back to the full address if it is too short to truncate meaningfully.
 */
function truncateAddress(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// ─── QR Code Error Boundary ───────────────────────────────────────────────────

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
          aria-label="QR code unavailable"
          style={{
            width: 160,
            height: 160,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border-error)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-error)",
            fontSize: "var(--font-size-xs)",
            textAlign: "center",
            padding: "var(--space-2)",
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
      className="alert alert-warning animate-fade-in"
      style={{ marginBottom: "var(--space-4)" }}
    >
      <span style={{ flex: 1, fontSize: "var(--font-size-sm)" }}>
        Another hardware key was detected ({devicePath}). Connect this key to
        switch wallets.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss second device notification"
        className="btn btn-ghost btn-icon"
        style={{ flexShrink: 0, fontSize: "var(--font-size-md)", lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Copied toast ─────────────────────────────────────────────────────────────

interface CopiedToastProps {
  visible: boolean;
}

function CopiedToast({ visible }: CopiedToastProps): React.ReactElement | null {
  if (!visible) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="Address copied confirmation"
      style={{
        position: "fixed",
        bottom: "var(--space-6)",
        left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-accent)",
        borderRadius: "var(--radius-full)",
        padding: "var(--space-2) var(--space-5)",
        fontSize: "var(--font-size-sm)",
        color: "var(--status-connected)",
        fontWeight: "var(--font-weight-medium)",
        letterSpacing: "0.04em",
        boxShadow: "var(--shadow-md)",
        pointerEvents: "none",
        zIndex: 100,
        animation: "fade-in 160ms ease both",
      }}
    >
      Copied
    </span>
  );
}

// ─── WalletView props ─────────────────────────────────────────────────────────

export interface WalletViewProps {
  session: SessionPublicData;
  balanceStatus: BalanceStatus;
  /** Called when the user triggers a manual balance refresh. */
  onRefreshBalance: () => void;
  /** Called when the user clicks the address to copy it. */
  onCopyAddress: () => void;
  /** Called when the user opens the Receive screen. */
  onReceive: () => void;
  /** Called when the user initiates a send transaction. */
  onSend: () => void;
  /** Called when the user terminates the session (Disconnect). */
  onTerminateSession: () => void;
}

// ─── WalletView ───────────────────────────────────────────────────────────────

export function WalletView({
  session,
  balanceStatus,
  onRefreshBalance,
  onCopyAddress,
  onReceive,
  onSend,
  onTerminateSession,
}: WalletViewProps): React.ReactElement {
  // ── Copy confirmation state ───────────────────────────────────────────────
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

  // ── Second-device notification ────────────────────────────────────────────
  const [secondDevicePath, setSecondDevicePath] = useState<string | null>(null);

  useEffect(() => {
    const handleDeviceConnected = (data: {
      devicePath: string;
      supportsHmacSecret: boolean;
    }): void => {
      // Any connection event while a session is active is a second device.
      // Req 5.6, 11.2
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

  // ── Balance display (Req 7.3, 7.4) ───────────────────────────────────────
  let balanceSol: string;
  let balanceUnavailable = false;
  let balanceLoading = false;

  if (balanceStatus.kind === "available") {
    const parsed = parseFloat(balanceStatus.sol);
    balanceSol = isNaN(parsed) ? balanceStatus.sol : parsed.toFixed(4);
  } else if (balanceStatus.kind === "unavailable") {
    balanceSol = "—";
    balanceUnavailable = true;
  } else {
    // kind === "idle" — first fetch in progress
    balanceSol = "—";
    balanceLoading = true;
  }

  // ── Truncated address display (first 4 + "..." + last 4) ─────────────────
  const truncated = truncateAddress(session.walletAddress);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <main
      role="main"
      aria-label="Active wallet"
      className="animate-fade-in"
      style={{
        width: "100%",
        maxWidth: "var(--app-max-width)",
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      {/* ── Second-device notification banner ── */}
      {secondDevicePath !== null && (
        <SecondDeviceBanner
          devicePath={secondDevicePath}
          onDismiss={dismissSecondDeviceBanner}
        />
      )}

      {/* ── Header: "HARDWARE IDENTITY — CONNECTED" status line (Req 6) ── */}
      <header
        aria-label="Hardware identity status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          marginBottom: "var(--space-4)",
        }}
      >
        {/* Green status dot */}
        <span
          className="status-dot status-dot--connected"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        />

        {/* Status text — small caps, muted */}
        <span
          aria-label="Hardware identity connected"
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--text-tertiary)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: "var(--font-weight-medium)",
          }}
        >
          Hardware Identity — Connected
        </span>
      </header>

      {/* ── Separator ── */}
      <hr
        aria-hidden="true"
        style={{
          border: "none",
          borderTop: "1px solid var(--border-subtle)",
          marginBottom: "var(--space-6)",
        }}
      />

      {/* ── Wallet address section (Req 6.1, 6.2, 6.3) ── */}
      <section aria-label="Wallet address" style={{ marginBottom: "var(--space-6)" }}>
        {/* "WALLET" label */}
        <p
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--text-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: "var(--space-2)",
          }}
        >
          Wallet
        </p>

        {/* Truncated address — large monospace, clickable to copy full address (Req 6.2) */}
        <button
          type="button"
          onClick={handleCopyAddress}
          aria-label={`Wallet address ${session.walletAddress} — click to copy`}
          title={`Click to copy: ${session.walletAddress}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-2xl)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--text-primary)",
              letterSpacing: "0.02em",
              lineHeight: "var(--line-height-tight)",
            }}
          >
            {truncated}
          </span>

          {/* Subtle copy icon hint */}
          <span
            aria-hidden="true"
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--text-tertiary)",
              flexShrink: 0,
              opacity: 0.7,
            }}
          >
            ⎘
          </span>
        </button>

        {/* Full address — smaller, also triggers copy (Req 6.2) */}
        <button
          type="button"
          onClick={handleCopyAddress}
          aria-label="Copy full wallet address to clipboard"
          title="Click to copy full address"
          className="address-display"
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            cursor: "pointer",
            marginTop: "var(--space-3)",
            transition: "border-color var(--transition-fast), box-shadow var(--transition-fast)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-accent)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "var(--shadow-accent)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-subtle)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
          }}
        >
          {session.walletAddress}
        </button>
      </section>

      {/* ── Separator ── */}
      <hr
        aria-hidden="true"
        style={{
          border: "none",
          borderTop: "1px solid var(--border-subtle)",
          marginBottom: "var(--space-6)",
        }}
      />

      {/* ── Balance section (Req 7.3, 7.4) ── */}
      <section aria-label="Wallet balance" style={{ marginBottom: "var(--space-6)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            marginBottom: "var(--space-2)",
            flexWrap: "wrap",
          }}
        >
          {/* SOL amount — large number */}
          <span
            aria-live="polite"
            aria-atomic="true"
            aria-label={
              balanceLoading
                ? "Loading balance"
                : balanceUnavailable
                  ? "Balance unavailable"
                  : `Balance: ${balanceSol} SOL`
            }
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-2xl)",
              fontWeight: "var(--font-weight-semibold)",
              color: balanceUnavailable || balanceLoading
                ? "var(--text-tertiary)"
                : "var(--text-primary)",
              lineHeight: "var(--line-height-tight)",
              letterSpacing: "-0.01em",
              transition: "color var(--transition-base)",
            }}
          >
            {balanceLoading ? (
              <span className="spinner" aria-label="Loading balance" />
            ) : (
              balanceSol
            )}
          </span>

          {/* Unit label */}
          {!balanceLoading && !balanceUnavailable && (
            <span
              aria-hidden="true"
              style={{
                fontSize: "var(--font-size-base)",
                color: "var(--text-secondary)",
                fontWeight: "var(--font-weight-medium)",
              }}
            >
              SOL
            </span>
          )}

          {/* DEVNET badge — beside the balance number */}
          <span
            aria-label="Solana devnet"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px var(--space-3)",
              borderRadius: "var(--radius-full)",
              backgroundColor: "rgba(0, 229, 255, 0.12)",
              border: "1px solid var(--border-accent)",
              fontSize: "var(--font-size-xs)",
              fontWeight: "var(--font-weight-bold)",
              color: "var(--accent)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            Devnet
          </span>
        </div>

        {/* Balance unavailable message */}
        {balanceUnavailable && (
          <p
            role="status"
            aria-live="polite"
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--text-error)",
              margin: 0,
            }}
          >
            Balance unavailable — retrying…
          </p>
        )}

        {/* Refresh button */}
        <button
          type="button"
          onClick={onRefreshBalance}
          aria-label="Refresh wallet balance"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: "var(--space-2)", paddingLeft: 0 }}
        >
          <span aria-hidden="true" style={{ fontSize: "0.9em" }}>↻</span>
          Refresh
        </button>
      </section>

      {/* ── Action row: [ Receive ] [ Send ] [ Disconnect ] ── */}
      <section aria-label="Wallet actions" style={{ marginBottom: "var(--space-6)" }}>
        <div
          className="action-row"
          style={{ justifyContent: "stretch", gap: "var(--space-3)" }}
        >
          {/* Receive */}
          <button
            type="button"
            onClick={onReceive}
            aria-label="Receive — show address and QR code for receiving funds"
            className="btn btn-secondary"
            style={{
              flex: 1,
              flexDirection: "column",
              gap: "var(--space-1)",
              padding: "var(--space-3) var(--space-2)",
            }}
          >
            <span aria-hidden="true" style={{ fontSize: "1.1em" }}>↓</span>
            <span style={{ fontSize: "var(--font-size-xs)", letterSpacing: "0.03em" }}>
              Receive
            </span>
          </button>

          {/* Send */}
          <button
            type="button"
            onClick={onSend}
            aria-label="Send SOL"
            className="btn btn-primary"
            style={{
              flex: 1,
              flexDirection: "column",
              gap: "var(--space-1)",
              padding: "var(--space-3) var(--space-2)",
            }}
          >
            <span aria-hidden="true" style={{ fontSize: "1.1em" }}>↑</span>
            <span style={{ fontSize: "var(--font-size-xs)", letterSpacing: "0.03em" }}>
              Send
            </span>
          </button>

          {/* Disconnect */}
          <button
            type="button"
            onClick={onTerminateSession}
            aria-label="Disconnect — terminate session and lock wallet"
            className="btn btn-danger"
            style={{
              flex: 1,
              flexDirection: "column",
              gap: "var(--space-1)",
              padding: "var(--space-3) var(--space-2)",
            }}
          >
            <span aria-hidden="true" style={{ fontSize: "1.1em" }}>⏻</span>
            <span style={{ fontSize: "var(--font-size-xs)", letterSpacing: "0.03em" }}>
              Disconnect
            </span>
          </button>
        </div>
      </section>

      {/* ── QR code (Req 6.4, 6.5) ── */}
      <section
        aria-label="QR code for wallet address"
        style={{
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div className="qr-container">
          <QrErrorBoundary>
            <QRCodeSVG
              value={session.walletAddress}
              size={148}
              role="img"
              aria-label={`QR code for wallet address ${session.walletAddress}`}
            />
          </QrErrorBoundary>
        </div>
      </section>

      {/* ── "Copied" toast (Req 6.2, 6.3) ── */}
      <CopiedToast visible={showCopied} />
    </main>
  );
}
