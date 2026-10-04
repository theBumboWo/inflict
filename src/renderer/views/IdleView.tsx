// src/renderer/views/IdleView.tsx
//
// Displayed when no compatible hardware security key is connected.
// Placeholder implementation — full UI is implemented in task 19.2.

import React from "react";

export interface IdleViewProps {
  /** Set when the main process reports a connected but unsupported device. */
  unsupportedReason?: string;
}

export function IdleView({ unsupportedReason }: IdleViewProps): React.ReactElement {
  return (
    <main role="main" aria-label="Idle — no device connected">
      {unsupportedReason != null ? (
        <p role="alert" aria-live="assertive">
          {`Unsupported device: ${unsupportedReason}`}
        </p>
      ) : (
        <p>Connect a compatible FIDO2 hardware security key to get started.</p>
      )}
    </main>
  );
}
