// src/renderer/views/ReceiveView.tsx
//
// Displays the wallet's public receive address with a prominent QR code so
// the user can share or scan their Solana Devnet address.
//
// Layout:
//   ┌───────────────────────────────────────────────────────────┐
//   │  ← Back                                                   │
//   │  ════════════════════════════════════════════════════════  │
//   │             ⚠  SOLANA  DEVNET  ⚠                         │
//   │  ════════════════════════════════════════════════════════  │
//   │                   [ QR code ]                             │
//   │  ────────────────────────────────────────────────────────  │
//   │  YOUR ADDRESS                                             │
//   │  7xKf3p…Q2  (full monospace, large)                       │
//   │  ────────────────────────────────────────────────────────  │
//   │                [ Copy Address ]                           │
//   │                ✓ Copied  (toast)                          │
//   └───────────────────────────────────────────────────────────┘
//
// SECURITY: This component MUST NEVER display, log, or render private key
// bytes or Wallet_Seed. Only the public walletAddress string is accepted.
//
// Requirements: Req 6.1, Req 6.4

import React, {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";

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
          aria-label="QR code unavailable"
          style={{
            width: 200,
            height: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border-error)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-error)",
            fontSize: "var(--font-size-sm)",
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

// ─── ReceiveView props ────────────────────────────────────────────────────────

export interface ReceiveViewProps {
  /** The wallet's public Solana Devnet address (Base58). NEVER pass private key bytes. */
  walletAddress: string;
  /** Called when the user clicks the Back button to return to WalletView. */
  onBack: () => void;
}

// ─── ReceiveView ──────────────────────────────────────────────────────────────

export function ReceiveView({
  walletAddress,
  onBack,
}: ReceiveViewProps): React.ReactElement {
  // ── Copy confirmation state ────────────────────────────────────────────────
  const [showCopied, setShowCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    // Invoke IPC handler that copies the address via the main process.
    window.wallet.invoke("address:copy");
    setShowCopied(true);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setShowCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, []);

  // Clear copy timer on unmount.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <main
      role="main"
      aria-label="Receive SOL — your wallet address"
      className="animate-fade-in"
      style={{
        width: "100%",
        maxWidth: "var(--app-max-width)",
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      {/* ── Back navigation ── */}
      <div style={{ marginBottom: "var(--space-4)" }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onBack}
          aria-label="Back to wallet"
        >
          ← Back
        </button>
      </div>

      {/* ── SOLANA DEVNET label — prominent, cannot be missed (Req 6.4) ── */}
      <section
        aria-label="Network warning"
        style={{
          textAlign: "center",
          marginBottom: "var(--space-6)",
        }}
      >
        {/* Full-width accent bar above */}
        <div
          aria-hidden="true"
          style={{
            height: 2,
            background:
              "linear-gradient(90deg, transparent, var(--status-searching), transparent)",
            marginBottom: "var(--space-4)",
            borderRadius: "var(--radius-full)",
          }}
        />

        <div
          role="status"
          aria-label="Warning: this is a Solana Devnet address"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-3)",
            padding: "var(--space-3) var(--space-8)",
            backgroundColor: "rgba(255, 204, 0, 0.10)",
            border: "2px solid var(--status-searching)",
            borderRadius: "var(--radius-lg)",
            color: "var(--status-searching)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--font-size-xl)",
            fontWeight: "var(--font-weight-bold)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            boxShadow: "0 0 24px rgba(255, 204, 0, 0.15)",
          }}
        >
          <span aria-hidden="true">⚠</span>
          SOLANA DEVNET
          <span aria-hidden="true">⚠</span>
        </div>

        {/* Subtitle hint */}
        <p
          style={{
            marginTop: "var(--space-2)",
            marginBottom: 0,
            fontSize: "var(--font-size-xs)",
            color: "var(--text-tertiary)",
            letterSpacing: "0.03em",
          }}
        >
          Only send Devnet SOL to this address
        </p>

        {/* Full-width accent bar below */}
        <div
          aria-hidden="true"
          style={{
            height: 2,
            background:
              "linear-gradient(90deg, transparent, var(--status-searching), transparent)",
            marginTop: "var(--space-4)",
            borderRadius: "var(--radius-full)",
          }}
        />
      </section>

      {/* ── QR code — centered (Req 6.4) ── */}
      <section
        aria-label="QR code for wallet address"
        style={{
          display: "flex",
          justifyContent: "center",
          marginBottom: "var(--space-6)",
        }}
      >
        <div
          className="qr-container animate-fade-in-scale"
          style={{
            padding: "var(--space-5)",
            borderRadius: "var(--radius-xl)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <QrErrorBoundary>
            <QRCodeSVG
              value={walletAddress}
              size={200}
              role="img"
              aria-label={`QR code encoding wallet address ${walletAddress}`}
            />
          </QrErrorBoundary>
        </div>
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

      {/* ── Full wallet address — large monospace (Req 6.1) ── */}
      <section aria-label="Wallet address" style={{ marginBottom: "var(--space-6)" }}>
        {/* Section label */}
        <p
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--text-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: "var(--space-3)",
            textAlign: "center",
          }}
        >
          Your Address
        </p>

        {/* Full address — large monospace, word-break ensures it fits the panel */}
        <output
          aria-label={`Wallet address: ${walletAddress}`}
          style={{
            display: "block",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-2xl)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--text-primary)",
            lineHeight: "var(--line-height-relaxed)",
            letterSpacing: "0.02em",
            wordBreak: "break-all",
            textAlign: "center",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-4) var(--space-5)",
          }}
        >
          {walletAddress}
        </output>
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

      {/* ── Copy button + copied toast ── */}
      <section
        aria-label="Copy address"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={handleCopy}
          aria-label="Copy wallet address to clipboard"
          style={{ minWidth: "180px" }}
        >
          <span aria-hidden="true" style={{ fontSize: "1.1em" }}>⎘</span>
          Copy Address
        </button>

        {/* Inline "Copied" confirmation — shown for 2 s after click */}
        {showCopied && (
          <div
            role="status"
            aria-live="polite"
            aria-label="Address copied to clipboard"
            className="animate-fade-in"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-4)",
              backgroundColor: "rgba(0, 255, 136, 0.12)",
              border: "1px solid rgba(0, 255, 136, 0.30)",
              borderRadius: "var(--radius-full)",
              color: "var(--status-connected)",
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)",
              letterSpacing: "0.02em",
            }}
          >
            <span aria-hidden="true">✓</span>
            Copied!
          </div>
        )}
      </section>
    </main>
  );
}
