// src/renderer/global.d.ts
//
// Augments the global Window interface so `window.wallet` is typed throughout
// the renderer.  The actual runtime value is injected by the preload script
// via contextBridge.exposeInMainWorld("wallet", ...).
//
// WalletApi lives in src/shared/ipc-types so both the preload tsconfig and the
// renderer tsconfig can reach it without crossing exclusion boundaries.

import type { WalletApi } from "../shared/ipc-types";

declare global {
  interface Window {
    /** Typed IPC bridge injected by the preload script. */
    readonly wallet: WalletApi;
  }
}

// Make this file a module so the `declare global` block is treated as a
// module-level augmentation rather than a script-level declaration.
export {};
