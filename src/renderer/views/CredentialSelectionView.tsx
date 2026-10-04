// src/renderer/views/CredentialSelectionView.tsx
//
// Displayed when multiple credentials are found on the connected device.
// The user selects which credential to use for wallet derivation.
// Placeholder implementation — full UI is implemented in task 20.1.

import React from "react";

export interface CredentialOption {
  credentialId: string;
  displayName: string;
}

export interface CredentialSelectionViewProps {
  credentials: CredentialOption[];
  /** Called with the hex credentialId the user selected. */
  onSelect: (credentialId: string) => void;
  /** Called when the user cancels selection. */
  onCancel: () => void;
}

export function CredentialSelectionView({
  credentials,
  onSelect,
  onCancel,
}: CredentialSelectionViewProps): React.ReactElement {
  return (
    <main role="main" aria-label="Select a credential">
      <p>Multiple credentials found. Select the one you want to use:</p>
      <ul aria-label="Credential list">
        {credentials.slice(0, 20).map((cred) => (
          <li key={cred.credentialId}>
            <button
              type="button"
              onClick={() => onSelect(cred.credentialId)}
              aria-label={`Select credential: ${cred.displayName}`}
            >
              {cred.displayName}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onCancel} aria-label="Cancel selection">
        Cancel
      </button>
    </main>
  );
}
