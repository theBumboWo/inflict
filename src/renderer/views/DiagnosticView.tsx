// src/renderer/views/DiagnosticView.tsx
//
// Hardware diagnostic panel (Req 22.7).
//
// Calls `hardware:diagnose` on mount and renders a table of diagnostic results.
// Never displays secret material — the IPC handler guarantees this.
//
// Accessible attributes:
//   - The results table has `role="table"` with proper row/cell semantics.
//   - Status icons are accompanied by visible text and `aria-label`.
//   - The close button has a descriptive `aria-label`.

import React, { useEffect, useState, useCallback } from "react";
import type { DiagnosticResult } from "../../shared/ipc-types";

// ─── Component ────────────────────────────────────────────────────────────────

interface DiagnosticViewProps {
  /** Called when the user closes the diagnostic panel. */
  onClose: () => void;
}

type DiagnosticState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: DiagnosticResult };

export function DiagnosticView({ onClose }: DiagnosticViewProps): React.ReactElement {
  const [state, setState] = useState<DiagnosticState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    window.wallet
      .invoke("hardware:diagnose")
      .then((raw) => {
        if (cancelled) return;
        setState({ kind: "done", result: raw as DiagnosticResult });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Diagnostic call failed";
        setState({ kind: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = useCallback(() => {
    setState({ kind: "loading" });
    window.wallet
      .invoke("hardware:diagnose")
      .then((raw) => {
        setState({ kind: "done", result: raw as DiagnosticResult });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Diagnostic call failed";
        setState({ kind: "error", message });
      });
  }, []);

  return (
    <div
      role="region"
      aria-label="Hardware diagnostic panel"
      style={styles.container}
    >
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title} id="diagnostic-heading">
          Hardware Diagnostic
        </h2>
        <div style={styles.headerActions}>
          <button
            type="button"
            onClick={handleRefresh}
            aria-label="Re-run hardware diagnostic"
            style={styles.refreshButton}
          >
            ↻ Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close hardware diagnostic panel"
            style={styles.closeButton}
          >
            ✕ Close
          </button>
        </div>
      </div>

      {/* Content */}
      {state.kind === "loading" && (
        <p
          role="status"
          aria-live="polite"
          style={styles.statusText}
        >
          Running hardware diagnostic…
        </p>
      )}

      {state.kind === "error" && (
        <p
          role="alert"
          aria-live="assertive"
          style={{ ...styles.statusText, color: "#e53e3e" }}
        >
          Error: {state.message}
        </p>
      )}

      {state.kind === "done" && (
        <DiagnosticTable result={state.result} />
      )}
    </div>
  );
}

// ─── DiagnosticTable ──────────────────────────────────────────────────────────

interface DiagnosticTableProps {
  result: DiagnosticResult;
}

function DiagnosticTable({ result }: DiagnosticTableProps): React.ReactElement {
  const rows: Array<{ label: string; value: React.ReactNode; bool?: boolean | null }> = [
    {
      label: "Device detected",
      value: result.deviceDetected ? result.devicePath ?? "Yes" : "No",
      bool: result.deviceDetected,
    },
    {
      label: "FIDO2 supported",
      value: boolText(result.fido2Supported),
      bool: result.fido2Supported,
    },
    {
      label: "HMAC-secret supported",
      value: boolText(result.hmacSecretSupported),
      bool: result.hmacSecretSupported,
    },
    {
      label: "Credential found",
      value: boolText(result.credentialFound),
      bool: result.credentialFound,
    },
    {
      label: "PRF operation",
      value: result.prfOperationResult,
    },
    {
      label: "Extensions",
      value:
        result.extensions.length > 0
          ? result.extensions.join(", ")
          : "—",
    },
    {
      label: "Versions",
      value:
        result.versions.length > 0 ? result.versions.join(", ") : "—",
    },
    {
      label: "Error",
      value: result.error ?? "None",
      bool: result.error === null ? true : false,
    },
  ];

  return (
    <table
      role="table"
      aria-labelledby="diagnostic-heading"
      style={styles.table}
    >
      <thead>
        <tr>
          <th scope="col" style={styles.th}>
            Property
          </th>
          <th scope="col" style={styles.th}>
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} style={styles.tr}>
            <td style={styles.tdLabel}>{row.label}</td>
            <td style={styles.tdValue}>
              {row.bool !== undefined && row.bool !== null && (
                <StatusIcon ok={row.bool} />
              )}
              <span>{row.value}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── StatusIcon ───────────────────────────────────────────────────────────────

function StatusIcon({ ok }: { ok: boolean }): React.ReactElement {
  return (
    <span
      aria-label={ok ? "Supported" : "Not supported"}
      role="img"
      style={{
        ...styles.statusIcon,
        color: ok ? "#38a169" : "#e53e3e",
      }}
    >
      {ok ? "✓ " : "✗ "}
    </span>
  );
}

function boolText(v: boolean): string {
  return v ? "Yes" : "No";
}

// ─── Styles (inline — no external CSS required) ───────────────────────────────

const styles = {
  container: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: "640px",
    margin: "0 auto",
    padding: "24px",
    backgroundColor: "#1a1a2e",
    color: "#e2e8f0",
    borderRadius: "8px",
  } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "16px",
  } as React.CSSProperties,

  headerActions: {
    display: "flex",
    gap: "8px",
  } as React.CSSProperties,

  title: {
    fontSize: "1.25rem",
    fontWeight: 600,
    margin: 0,
  } as React.CSSProperties,

  refreshButton: {
    padding: "6px 12px",
    borderRadius: "4px",
    border: "1px solid #4a5568",
    backgroundColor: "#2d3748",
    color: "#e2e8f0",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as React.CSSProperties,

  closeButton: {
    padding: "6px 12px",
    borderRadius: "4px",
    border: "1px solid #4a5568",
    backgroundColor: "#2d3748",
    color: "#e2e8f0",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as React.CSSProperties,

  statusText: {
    fontSize: "0.9rem",
    color: "#a0aec0",
  } as React.CSSProperties,

  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.875rem",
  } as React.CSSProperties,

  th: {
    textAlign: "left" as const,
    padding: "8px 12px",
    borderBottom: "1px solid #4a5568",
    color: "#a0aec0",
    fontWeight: 500,
  } as React.CSSProperties,

  tr: {
    borderBottom: "1px solid #2d3748",
  } as React.CSSProperties,

  tdLabel: {
    padding: "8px 12px",
    color: "#a0aec0",
    whiteSpace: "nowrap" as const,
    width: "220px",
  } as React.CSSProperties,

  tdValue: {
    padding: "8px 12px",
    color: "#e2e8f0",
  } as React.CSSProperties,

  statusIcon: {
    fontWeight: 700,
    marginRight: "4px",
  } as React.CSSProperties,
} as const;
