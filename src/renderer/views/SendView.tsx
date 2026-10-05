// src/renderer/views/SendView.tsx
//
// Transaction construction and signing flow — polished two-panel redesign.
//
// State machine:
//   form         → user enters destination address and SOL amount
//   previewing   → fetching blockhash / fee estimate (loading state)
//   confirmation → shows preview summary card; user confirms
//   signing      → "READY TO SIGN — Touch your security key" state
//   success      → shows transaction signature
//   (rpcError is inline within confirmation with retry)
//
// IPC channels used:
//   transaction:validate — validate inputs; returns TransactionValidationError | null
//   transaction:preview  — fetch blockhash and fee; returns TransactionPreview
//   transaction:submit   — sign and submit; returns { signature: string }
//
// Props:
//   currentBalanceLamports — active session balance for fee/amount validation
//   onBack                 — called when the user cancels OR completes the flow

import React, { useCallback, useId, useRef, useState } from "react";
import type { TransactionPreview, TransferParams } from "../../shared/ipc-types";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Field-level validation error returned by transaction:validate. */
type TransactionValidationError =
  | { field: "destination"; reason: string }
  | { field: "amount"; reason: string };

type Screen = "form" | "previewing" | "confirmation" | "signing" | "success";

interface FieldErrors {
  destination?: string;
  amount?: string;
}

interface RpcError {
  category: string;
  message: string;
}

// ─── Address validation indicator ─────────────────────────────────────────────

type AddressValidity = "empty" | "valid" | "invalid";

function getAddressValidity(address: string): AddressValidity {
  const trimmed = address.trim();
  if (trimmed === "") return "empty";
  // Basic base58 + length heuristic for real-time indicator (full validation is server-side)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(trimmed) ? "valid" : "invalid";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a SOL string (float) to lamports bigint. Returns null on invalid input. */
function solToLamports(solStr: string): bigint | null {
  const trimmed = solStr.trim();
  if (trimmed === "") return null;
  const num = parseFloat(trimmed);
  if (!isFinite(num) || num < 0) return null;
  const lamports = Math.round(num * 1_000_000_000);
  return BigInt(lamports);
}

// ─── SendViewProps ────────────────────────────────────────────────────────────

export interface SendViewProps {
  /** Current balance in lamports — used for amount validation. */
  currentBalanceLamports: bigint;
  /** Called when the user cancels the flow or completes it with "Done". */
  onBack: () => void;
}

// ─── SendView ─────────────────────────────────────────────────────────────────

export function SendView({
  currentBalanceLamports,
  onBack,
}: SendViewProps): React.ReactElement {
  // ── Screen state ──────────────────────────────────────────────────────────
  const [screen, setScreen] = useState<Screen>("form");

  // ── Form inputs ───────────────────────────────────────────────────────────
  const [destination, setDestination] = useState("");
  const [amountSol, setAmountSol] = useState("");

  // ── Validation errors (form screen) ──────────────────────────────────────
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // ── Preview data (confirmation screen) ───────────────────────────────────
  const [preview, setPreview] = useState<TransactionPreview | null>(null);

  // ── Submission state ──────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rpcError, setRpcError] = useState<RpcError | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  // ── Retry timer (30-second window after RPC error) ────────────────────────
  const [retryExpired, setRetryExpired] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── ARIA IDs ──────────────────────────────────────────────────────────────
  const destId = useId();
  const amountId = useId();
  const destErrorId = useId();
  const amountErrorId = useId();
  const rpcErrorId = useId();

  // ── Cleanup retry timer on unmount ────────────────────────────────────────
  React.useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  // ── Build TransferParams from current form values ─────────────────────────
  const buildTransferParams = useCallback((): TransferParams | null => {
    const lamports = solToLamports(amountSol);
    if (lamports === null) return null;
    return {
      destinationAddress: destination.trim(),
      lamports,
      currentBalanceLamports,
    };
  }, [destination, amountSol, currentBalanceLamports]);

  // ── Handle "Preview" button click (form → previewing → confirmation) ──────
  const handlePreview = useCallback(async () => {
    setFieldErrors({});

    const params = buildTransferParams();
    if (params === null) {
      setFieldErrors({ amount: "Enter a valid SOL amount (e.g. 0.5)." });
      return;
    }

    // Step 1: validate via IPC.
    let validationError: TransactionValidationError | null = null;
    try {
      validationError = (await window.wallet.invoke(
        "transaction:validate",
        params
      )) as TransactionValidationError | null;
    } catch {
      setFieldErrors({ amount: "Validation failed. Please try again." });
      return;
    }

    if (validationError !== null) {
      if (validationError.field === "destination") {
        setFieldErrors({ destination: validationError.reason });
      } else {
        setFieldErrors({ amount: validationError.reason });
      }
      return;
    }

    // Step 2: fetch preview via IPC (show loading state).
    setScreen("previewing");

    let previewData: TransactionPreview;
    try {
      previewData = (await window.wallet.invoke(
        "transaction:preview",
        params
      )) as TransactionPreview;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to fetch preview.";
      setScreen("form");
      setFieldErrors({ amount: msg });
      return;
    }

    setPreview(previewData);
    setScreen("confirmation");
  }, [buildTransferParams]);

  // ── Start the 30-second retry countdown ───────────────────────────────────
  const startRetryTimer = useCallback(() => {
    setRetryExpired(false);
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(() => {
      setRetryExpired(true);
      retryTimerRef.current = null;
    }, 30_000);
  }, []);

  // ── Handle "Confirm & Sign" and "Retry" button clicks ─────────────────────
  const handleSubmit = useCallback(async () => {
    const params = buildTransferParams();
    if (params === null) return;

    setIsSubmitting(true);
    setRpcError(null);
    setScreen("signing");

    try {
      const result = (await window.wallet.invoke(
        "transaction:submit",
        params
      )) as { signature: string };

      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      setSignature(result.signature);
      setScreen("success");
    } catch (err: unknown) {
      let category = "rpc-error";
      let message = "Transaction submission failed. Please try again.";
      if (err instanceof Error) {
        message = err.message;
        const match = /^\[([^\]]+)\]\s*(.*)$/.exec(err.message);
        if (match) {
          category = match[1];
          message = match[2] || message;
        }
      }
      setRpcError({ category, message });
      setScreen("confirmation");
      startRetryTimer();
    } finally {
      setIsSubmitting(false);
    }
  }, [buildTransferParams, startRetryTimer]);

  // ── Handle "Back" from confirmation to form ───────────────────────────────
  const handleBackToForm = useCallback(() => {
    setRpcError(null);
    setRetryExpired(false);
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setScreen("form");
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Shared layout wrapper — two-column shell with persistent network badge
  // ─────────────────────────────────────────────────────────────────────────

  const addressValidity = getAddressValidity(destination);
  const hasDestError = Boolean(fieldErrors.destination);
  const hasAmountError = Boolean(fieldErrors.amount);

  // ─── Render: form screen ──────────────────────────────────────────────────
  if (screen === "form" || screen === "previewing") {
    const isPreviewing = screen === "previewing";

    return (
      <main
        role="main"
        aria-label="Send SOL"
        style={{
          width: "100%",
          maxWidth: "var(--app-max-width)",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* ── Header row ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "var(--space-6)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "var(--font-size-xl)" }}>
            Send SOL
          </h1>
          {/* Network badge — always visible */}
          <span
            className="status-chip status-chip--searching"
            aria-label="Network: Solana Devnet"
            role="status"
          >
            <span
              className="status-dot status-dot--searching"
              aria-hidden="true"
            />
            SOLANA DEVNET
          </span>
        </div>

        {/* ── Input panel ── */}
        <section
          aria-label="Transaction inputs"
          className="card"
          style={{ marginBottom: "var(--space-4)" }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handlePreview();
            }}
            noValidate
            aria-label="Send SOL form"
          >
            {/* ── Destination address ── */}
            <div className="field">
              <label htmlFor={destId}>Destination Address</label>
              <div style={{ position: "relative" }}>
                <input
                  id={destId}
                  type="text"
                  className={`input-mono${hasDestError ? " is-error" : ""}`}
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value);
                    if (fieldErrors.destination) {
                      setFieldErrors((prev) => ({
                        ...prev,
                        destination: undefined,
                      }));
                    }
                  }}
                  aria-label="Destination Solana address"
                  aria-required="true"
                  aria-invalid={hasDestError ? "true" : "false"}
                  aria-describedby={
                    hasDestError ? destErrorId : undefined
                  }
                  placeholder="Base58 address (32–44 characters)"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={isPreviewing}
                  style={{ paddingRight: "var(--space-8)" }}
                />
                {/* Inline validity indicator dot */}
                {addressValidity !== "empty" && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      right: "var(--space-3)",
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 8,
                      height: 8,
                      borderRadius: "var(--radius-full)",
                      backgroundColor:
                        addressValidity === "valid"
                          ? "var(--status-connected)"
                          : "var(--status-error)",
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
              {hasDestError && (
                <span
                  id={destErrorId}
                  className="field-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {fieldErrors.destination}
                </span>
              )}
            </div>

            {/* ── Amount (SOL) ── */}
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={amountId}>Amount</label>
              <div style={{ position: "relative" }}>
                <input
                  id={amountId}
                  type="text"
                  inputMode="decimal"
                  className={hasAmountError ? "is-error" : ""}
                  value={amountSol}
                  onChange={(e) => {
                    setAmountSol(e.target.value);
                    if (fieldErrors.amount) {
                      setFieldErrors((prev) => ({
                        ...prev,
                        amount: undefined,
                      }));
                    }
                  }}
                  aria-label="Amount in SOL"
                  aria-required="true"
                  aria-invalid={hasAmountError ? "true" : "false"}
                  aria-describedby={
                    hasAmountError ? amountErrorId : undefined
                  }
                  placeholder="0.000000000"
                  autoComplete="off"
                  disabled={isPreviewing}
                  style={{ paddingRight: "4.5rem" }}
                />
                {/* SOL label inside input */}
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    right: "var(--space-4)",
                    top: "50%",
                    transform: "translateY(-50%)",
                    fontSize: "var(--font-size-sm)",
                    fontWeight: "var(--font-weight-semibold)",
                    color: "var(--text-tertiary)",
                    pointerEvents: "none",
                    userSelect: "none",
                    letterSpacing: "0.04em",
                  }}
                >
                  SOL
                </span>
              </div>
              {hasAmountError && (
                <span
                  id={amountErrorId}
                  className="field-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {fieldErrors.amount}
                </span>
              )}
              {/* Estimated fee hint — shown when we have preview data */}
              {preview !== null && !hasAmountError && (
                <span
                  style={{
                    display: "block",
                    marginTop: "var(--space-2)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--text-tertiary)",
                  }}
                  aria-label={`Estimated fee: ${preview.estimatedFeeSol} SOL`}
                >
                  Est. fee: {preview.estimatedFeeSol} SOL
                </span>
              )}
            </div>

            {/* ── Actions ── */}
            <div
              className="action-row"
              style={{ marginTop: "var(--space-6)" }}
            >
              <button
                type="submit"
                className="btn btn-primary btn-lg"
                disabled={isPreviewing || destination.trim() === "" || amountSol.trim() === ""}
                aria-label="Preview transaction"
                aria-busy={isPreviewing}
              >
                {isPreviewing ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Fetching fee…
                  </>
                ) : (
                  "Preview →"
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onBack}
                disabled={isPreviewing}
                aria-label="Cancel send and return to wallet"
              >
                Cancel
              </button>
            </div>
          </form>
        </section>

        {/* ── Hint card ── */}
        <div
          className="alert alert-info animate-fade-in"
          role="note"
          aria-label="Send information"
        >
          <span
            aria-hidden="true"
            style={{ fontSize: "1rem", flexShrink: 0, marginTop: 1 }}
          >
            ℹ
          </span>
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--text-secondary)" }}>
            You will be asked to touch your security key to sign the transaction.
          </span>
        </div>
      </main>
    );
  }

  // ─── Render: confirmation screen ──────────────────────────────────────────
  if (screen === "confirmation" && preview !== null) {
    return (
      <main
        role="main"
        aria-label="Confirm transaction"
        style={{
          width: "100%",
          maxWidth: "var(--app-max-width)",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* ── Header row ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "var(--space-6)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "var(--font-size-xl)" }}>
            Review &amp; Sign
          </h1>
          <span
            className="status-chip status-chip--searching"
            aria-label="Network: Solana Devnet"
            role="status"
          >
            <span
              className="status-dot status-dot--searching"
              aria-hidden="true"
            />
            SOLANA DEVNET
          </span>
        </div>

        {/* ── Preview summary card ── */}
        <section
          aria-label="Transaction summary"
          className="card-elevated animate-fade-in-scale"
          style={{ marginBottom: "var(--space-4)" }}
        >
          <dl aria-label="Transaction details">
            {/* Recipient */}
            <div
              className="data-row"
              style={{ flexDirection: "column", alignItems: "flex-start", gap: "var(--space-2)", paddingBottom: "var(--space-4)" }}
            >
              <dt
                style={{
                  fontSize: "var(--font-size-xs)",
                  fontWeight: "var(--font-weight-medium)",
                  color: "var(--text-tertiary)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                Recipient
              </dt>
              <dd
                aria-label="Destination address"
                className="address-display"
                style={{ width: "100%", margin: 0 }}
              >
                {preview.destinationAddress}
              </dd>
            </div>

            {/* Amount */}
            <div className="data-row">
              <dt className="data-row__label">Amount</dt>
              <dd
                className="data-row__value"
                aria-label={`Transfer amount: ${preview.amountSol} SOL`}
                style={{ fontSize: "var(--font-size-base)", fontWeight: "var(--font-weight-semibold)", color: "var(--accent)" }}
              >
                {preview.amountSol} <span style={{ color: "var(--text-secondary)", fontWeight: "var(--font-weight-regular)", fontFamily: "var(--font-sans)" }}>SOL</span>
              </dd>
            </div>

            {/* Estimated fee */}
            <div className="data-row">
              <dt className="data-row__label">Estimated fee</dt>
              <dd
                className="data-row__value"
                aria-label={`Estimated transaction fee: ${preview.estimatedFeeSol} SOL`}
              >
                {preview.estimatedFeeSol} SOL
              </dd>
            </div>
          </dl>
        </section>

        {/* ── RPC error (inline) ── */}
        {rpcError !== null && (
          <div
            id={rpcErrorId}
            className="alert alert-error animate-slide-up"
            role="alert"
            aria-live="assertive"
            aria-label="Transaction error"
            style={{ marginBottom: "var(--space-4)" }}
          >
            <span aria-hidden="true" style={{ fontSize: "1rem", flexShrink: 0 }}>⚠</span>
            <div style={{ flex: 1 }}>
              <strong style={{ display: "block", marginBottom: "var(--space-1)" }}>
                Error ({rpcError.category})
              </strong>
              <span style={{ fontSize: "var(--font-size-xs)", color: "var(--text-secondary)" }}>
                {rpcError.message}
              </span>
              {!retryExpired && (
                <span
                  style={{
                    display: "block",
                    marginTop: "var(--space-1)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  Retry available for 30 seconds
                </span>
              )}
              {retryExpired && (
                <span
                  style={{
                    display: "block",
                    marginTop: "var(--space-1)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--status-error)",
                  }}
                  aria-label="Retry window expired"
                >
                  Retry window expired — go back and try again.
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Actions ── */}
        <div className="action-row" style={{ marginBottom: "var(--space-3)" }}>
          {rpcError === null ? (
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting}
              aria-label="Confirm and sign transaction"
              aria-busy={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Signing…
                </>
              ) : (
                "Confirm & Sign"
              )}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || retryExpired}
              aria-label={
                retryExpired
                  ? "Retry not available — retry window expired"
                  : "Retry transaction submission"
              }
              aria-describedby={rpcErrorId}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Retrying…
                </>
              ) : (
                "Retry"
              )}
            </button>
          )}

          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleBackToForm}
            disabled={isSubmitting}
            aria-label="Go back to send form"
          >
            ← Back
          </button>
        </div>
      </main>
    );
  }

  // ─── Render: signing screen ───────────────────────────────────────────────
  if (screen === "signing") {
    return (
      <main
        role="main"
        aria-label="Awaiting hardware key touch"
        style={{
          width: "100%",
          maxWidth: "var(--app-max-width)",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* ── Header row ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "var(--space-6)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "var(--font-size-xl)" }}>
            Sign Transaction
          </h1>
          <span
            className="status-chip status-chip--searching"
            aria-label="Network: Solana Devnet"
            role="status"
          >
            <span
              className="status-dot status-dot--searching"
              aria-hidden="true"
            />
            SOLANA DEVNET
          </span>
        </div>

        {/* ── Signing prompt card ── */}
        <section
          aria-label="Security key signing prompt"
          className="card animate-fade-in-scale"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "var(--space-10) var(--space-6)",
            gap: "var(--space-5)",
            border: "1px solid var(--border-accent)",
            boxShadow: "var(--shadow-accent)",
          }}
        >
          {/* Animated key icon */}
          <div
            aria-hidden="true"
            style={{
              fontSize: "3rem",
              animation: "glow-accent 2s ease-in-out infinite",
              filter: "drop-shadow(0 0 8px var(--accent))",
              lineHeight: 1,
            }}
          >
            🔑
          </div>

          {/* Status label */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-2)",
            }}
          >
            <p
              role="status"
              aria-live="assertive"
              aria-atomic="true"
              style={{
                margin: 0,
                fontWeight: "var(--font-weight-semibold)",
                fontSize: "var(--font-size-md)",
                color: "var(--accent)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                textAlign: "center",
              }}
            >
              READY TO SIGN
            </p>
            <p
              style={{
                margin: 0,
                fontSize: "var(--font-size-sm)",
                color: "var(--text-secondary)",
                textAlign: "center",
              }}
            >
              Touch your security key to authorize this transaction
            </p>
          </div>

          {/* Animated progress bar */}
          <div
            className="progress-bar progress-bar--indeterminate"
            aria-hidden="true"
            style={{ width: "80%", marginTop: "var(--space-2)" }}
          >
            <div className="progress-bar__fill" />
          </div>
        </section>
      </main>
    );
  }

  // ─── Render: success screen ───────────────────────────────────────────────
  if (screen === "success" && signature !== null) {
    return (
      <main
        role="main"
        aria-label="Transaction sent successfully"
        style={{
          width: "100%",
          maxWidth: "var(--app-max-width)",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* ── Header row ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "var(--space-6)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "var(--font-size-xl)" }}>
            Sent
          </h1>
          <span
            className="status-chip status-chip--connected"
            aria-label="Network: Solana Devnet"
            role="status"
          >
            <span
              className="status-dot status-dot--connected"
              aria-hidden="true"
            />
            SOLANA DEVNET
          </span>
        </div>

        {/* ── Success card ── */}
        <section
          aria-label="Transaction confirmation"
          className="card animate-fade-in-scale"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "var(--space-8) var(--space-6)",
            gap: "var(--space-4)",
            border: "1px solid rgba(0, 255, 136, 0.25)",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              fontSize: "2.5rem",
              lineHeight: 1,
              filter: "drop-shadow(0 0 6px var(--status-connected))",
            }}
          >
            ✓
          </div>
          <p
            role="status"
            aria-live="polite"
            style={{
              margin: 0,
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--status-connected)",
              fontSize: "var(--font-size-md)",
              textAlign: "center",
            }}
          >
            Transaction submitted successfully
          </p>
        </section>

        {/* ── Signature display ── */}
        <section
          aria-label="Transaction signature"
          className="card"
          style={{ marginTop: "var(--space-4)" }}
        >
          <label
            htmlFor="tx-signature"
            style={{ marginBottom: "var(--space-3)", display: "block" }}
          >
            Transaction Signature
          </label>
          <output
            id="tx-signature"
            aria-label="Transaction signature"
            className="tx-signature"
            style={{ display: "block" }}
          >
            {signature}
          </output>
        </section>

        {/* ── Actions ── */}
        <div
          className="action-row"
          style={{ marginTop: "var(--space-6)" }}
        >
          <button
            type="button"
            className="btn btn-primary btn-lg btn-full"
            onClick={onBack}
            aria-label="Done, return to wallet"
          >
            Done
          </button>
        </div>
      </main>
    );
  }

  // ─── Fallback (should not be reached) ────────────────────────────────────
  return (
    <main role="main" aria-label="Send SOL">
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          padding: "var(--space-8)",
        }}
      >
        <span className="spinner spinner-lg" aria-label="Loading" />
      </div>
    </main>
  );
}
