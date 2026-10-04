// src/renderer/views/SendView.tsx
//
// Transaction construction and signing flow.
//
// Three-screen state machine:
//   form        → user enters destination address and SOL amount
//   confirmation → shows preview (destination, amountSol, estimatedFeeSol)
//   success     → shows transaction signature
//   (error is inline within the confirmation screen with retry)
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

type Screen = "form" | "confirmation" | "success";

interface FieldErrors {
  destination?: string;
  amount?: string;
}

interface RpcError {
  category: string;
  message: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a SOL string (float) to lamports bigint.  Returns null on invalid input. */
function solToLamports(solStr: string): bigint | null {
  const trimmed = solStr.trim();
  if (trimmed === "") return null;
  const num = parseFloat(trimmed);
  if (!isFinite(num) || num < 0) return null;
  // Multiply by 1e9 and round to the nearest integer.
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
  // useId produces a stable unique ID per component instance.
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

  // ── Handle "Preview" button click (form → confirmation) ───────────────────
  const handlePreview = useCallback(async () => {
    // Clear previous errors.
    setFieldErrors({});

    const params = buildTransferParams();
    if (params === null) {
      // Amount could not be parsed — surface a local error before IPC.
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

    // Step 2: fetch preview via IPC.
    let previewData: TransactionPreview;
    try {
      previewData = (await window.wallet.invoke(
        "transaction:preview",
        params
      )) as TransactionPreview;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to fetch preview.";
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

  // ── Handle "Confirm & Send" and "Retry" button clicks ─────────────────────
  const handleSubmit = useCallback(async () => {
    const params = buildTransferParams();
    if (params === null) return;

    setIsSubmitting(true);
    setRpcError(null);

    try {
      const result = (await window.wallet.invoke(
        "transaction:submit",
        params
      )) as { signature: string };

      // Clear retry timer — no longer needed.
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      setSignature(result.signature);
      setScreen("success");
    } catch (err: unknown) {
      // Determine error category from the error object if possible.
      let category = "rpc-error";
      let message = "Transaction submission failed. Please try again.";
      if (err instanceof Error) {
        message = err.message;
        // The main process may encode category in the message with a prefix.
        const match = /^\[([^\]]+)\]\s*(.*)$/.exec(err.message);
        if (match) {
          category = match[1];
          message = match[2] || message;
        }
      }
      setRpcError({ category, message });
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

  // ─── Render: form screen ──────────────────────────────────────────────────
  if (screen === "form") {
    const hasDestError = Boolean(fieldErrors.destination);
    const hasAmountError = Boolean(fieldErrors.amount);

    return (
      <main role="main" aria-label="Send SOL">
        <h1>Send SOL</h1>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handlePreview();
          }}
          noValidate
          aria-label="Send SOL form"
        >
          {/* ── Destination address ── */}
          <div style={{ marginBottom: 16 }}>
            <label htmlFor={destId} style={{ display: "block", marginBottom: 4 }}>
              Destination Address
            </label>
            <input
              id={destId}
              type="text"
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                if (fieldErrors.destination) {
                  setFieldErrors((prev) => ({ ...prev, destination: undefined }));
                }
              }}
              aria-label="Destination Solana address"
              aria-required="true"
              aria-invalid={hasDestError}
              aria-describedby={hasDestError ? destErrorId : undefined}
              placeholder="Base58 address (32–44 characters)"
              autoComplete="off"
              spellCheck={false}
              style={{
                display: "block",
                width: "100%",
                fontFamily: "monospace",
                padding: "6px 8px",
                border: `1px solid ${hasDestError ? "#c00" : "#ccc"}`,
                borderRadius: 4,
                boxSizing: "border-box",
              }}
            />
            {hasDestError && (
              <span
                id={destErrorId}
                role="alert"
                aria-live="assertive"
                style={{ color: "#c00", fontSize: 13, marginTop: 4, display: "block" }}
              >
                {fieldErrors.destination}
              </span>
            )}
          </div>

          {/* ── Amount (SOL) ── */}
          <div style={{ marginBottom: 16 }}>
            <label htmlFor={amountId} style={{ display: "block", marginBottom: 4 }}>
              Amount (SOL)
            </label>
            <input
              id={amountId}
              type="text"
              inputMode="decimal"
              value={amountSol}
              onChange={(e) => {
                setAmountSol(e.target.value);
                if (fieldErrors.amount) {
                  setFieldErrors((prev) => ({ ...prev, amount: undefined }));
                }
              }}
              aria-label="Amount in SOL"
              aria-required="true"
              aria-invalid={hasAmountError}
              aria-describedby={hasAmountError ? amountErrorId : undefined}
              placeholder="e.g. 0.5"
              autoComplete="off"
              style={{
                display: "block",
                width: "100%",
                padding: "6px 8px",
                border: `1px solid ${hasAmountError ? "#c00" : "#ccc"}`,
                borderRadius: 4,
                boxSizing: "border-box",
              }}
            />
            {hasAmountError && (
              <span
                id={amountErrorId}
                role="alert"
                aria-live="assertive"
                style={{ color: "#c00", fontSize: 13, marginTop: 4, display: "block" }}
              >
                {fieldErrors.amount}
              </span>
            )}
          </div>

          {/* ── Actions ── */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              aria-label="Preview transaction"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={onBack}
              aria-label="Cancel send and return to wallet"
            >
              Cancel
            </button>
          </div>
        </form>
      </main>
    );
  }

  // ─── Render: confirmation screen ──────────────────────────────────────────
  if (screen === "confirmation" && preview !== null) {
    return (
      <main role="main" aria-label="Confirm transaction">
        <h1>Confirm Transaction</h1>

        <section aria-label="Transaction details">
          <dl>
            <div style={{ marginBottom: 8 }}>
              <dt style={{ fontWeight: "bold" }}>To</dt>
              <dd
                aria-label="Destination address"
                style={{ fontFamily: "monospace", wordBreak: "break-all", margin: 0 }}
              >
                {preview.destinationAddress}
              </dd>
            </div>
            <div style={{ marginBottom: 8 }}>
              <dt style={{ fontWeight: "bold" }}>Amount</dt>
              <dd aria-label="Transfer amount in SOL" style={{ margin: 0 }}>
                {preview.amountSol} SOL
              </dd>
            </div>
            <div style={{ marginBottom: 8 }}>
              <dt style={{ fontWeight: "bold" }}>Estimated fee</dt>
              <dd aria-label="Estimated transaction fee in SOL" style={{ margin: 0 }}>
                {preview.estimatedFeeSol} SOL
              </dd>
            </div>
          </dl>
        </section>

        {/* ── RPC error (inline, with retry) ── */}
        {rpcError !== null && (
          <div
            id={rpcErrorId}
            role="alert"
            aria-live="assertive"
            aria-label="Transaction error"
            style={{
              backgroundColor: "#fff0f0",
              border: "1px solid #c00",
              borderRadius: 4,
              padding: "10px 12px",
              marginBottom: 16,
            }}
          >
            <strong>Error ({rpcError.category}):</strong> {rpcError.message}
            {!retryExpired && (
              <span style={{ marginLeft: 8, fontSize: 13, color: "#666" }}>
                (retry available for 30 seconds)
              </span>
            )}
            {retryExpired && (
              <span
                style={{ marginLeft: 8, fontSize: 13, color: "#c00" }}
                aria-label="Retry window expired"
              >
                Retry window expired.
              </span>
            )}
          </div>
        )}

        {/* ── Actions ── */}
        <div style={{ display: "flex", gap: 8 }}>
          {/* Show "Confirm & Send" when no error, or "Retry" when error and within 30s */}
          {rpcError === null ? (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting}
              aria-label="Confirm and send transaction"
              aria-describedby={rpcError !== null ? rpcErrorId : undefined}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? "Sending…" : "Confirm & Send"}
            </button>
          ) : (
            <button
              type="button"
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
              {isSubmitting ? "Retrying…" : "Retry"}
            </button>
          )}

          <button
            type="button"
            onClick={handleBackToForm}
            disabled={isSubmitting}
            aria-label="Go back to send form"
          >
            Back
          </button>
        </div>
      </main>
    );
  }

  // ─── Render: success screen ───────────────────────────────────────────────
  if (screen === "success" && signature !== null) {
    return (
      <main role="main" aria-label="Transaction sent">
        <h1>Transaction Sent</h1>

        <section aria-label="Transaction confirmation">
          <p>Your transaction was submitted successfully.</p>
          <div style={{ marginTop: 12 }}>
            <label
              htmlFor="tx-signature"
              style={{ display: "block", fontWeight: "bold", marginBottom: 4 }}
            >
              Transaction Signature
            </label>
            <output
              id="tx-signature"
              aria-label="Transaction signature"
              style={{
                display: "block",
                fontFamily: "monospace",
                fontSize: 13,
                wordBreak: "break-all",
                padding: "6px 8px",
                border: "1px solid #ccc",
                borderRadius: 4,
                backgroundColor: "#f9f9f9",
              }}
            >
              {signature}
            </output>
          </div>
        </section>

        <div style={{ marginTop: 16 }}>
          <button
            type="button"
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
      <p>Loading…</p>
    </main>
  );
}
