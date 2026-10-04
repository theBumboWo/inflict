// src/preload/index.ts
//
// Preload script — runs in a privileged Node.js context before the renderer
// page loads, but with the renderer security model active.
//
// Security settings enforced by the BrowserWindow that loads this script
// (see src/main/index.ts):
//   contextIsolation: true   — this script runs in a separate context from the
//                              renderer page; the `window` objects are distinct.
//   nodeIntegration: false   — the renderer page has NO access to Node.js APIs.
//   sandbox: true            — this script runs in a sandboxed context with a
//                              limited subset of Node.js APIs.
//
// IMPORTANT: This file MUST NOT import CTAP2, libfido2, or @solana/web3.js.
// The only inter-process primitive exposed here is the typed contextBridge API.

import { contextBridge, ipcRenderer } from "electron";

import type {
  IpcRequest,
  IpcEvent,
  RequestChannel,
  EventName,
  PayloadFor,
  DataFor,
  EventListener,
  WalletApi,
} from "../shared/ipc-types";

// Re-export WalletApi so any module that previously imported it from here
// continues to compile without changes.
export type { WalletApi };

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Internal map from (event name, typed listener) → the raw IPC listener
 * wrapper.  Required because `ipcRenderer.on` passes two arguments
 * (_event, data) but the typed `EventListener` accepts only one (data).
 * We need to keep the original wrapper around to remove it with `off`.
 */
const listenerMap = new WeakMap<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  EventListener<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (_event: Electron.IpcRendererEvent, data: any) => void
>();

const walletApi: WalletApi = {
  invoke<C extends RequestChannel>(
    ...args: PayloadFor<C> extends undefined
      ? [channel: C]
      : [channel: C, payload: PayloadFor<C>]
  ): Promise<unknown> {
    const [channel, payload] = args as [C, PayloadFor<C> | undefined];
    // ipcRenderer.invoke(channel) and ipcRenderer.invoke(channel, payload)
    // are both valid; passing undefined as the second argument is safe.
    return ipcRenderer.invoke(channel, payload);
  },

  on<E extends EventName>(event: E, listener: EventListener<E>): void {
    // Wrap the typed listener so it receives only `data`, stripping the
    // internal Electron `IpcRendererEvent` first argument.
    const wrapper = (
      _ipcEvent: Electron.IpcRendererEvent,
      data: DataFor<E>
    ): void => {
      listener(data);
    };
    listenerMap.set(listener, wrapper);
    ipcRenderer.on(event, wrapper);
  },

  off<E extends EventName>(event: E, listener: EventListener<E>): void {
    const wrapper = listenerMap.get(listener);
    if (wrapper) {
      ipcRenderer.removeListener(event, wrapper);
      listenerMap.delete(listener);
    }
  },
};

// ─── Expose via contextBridge ─────────────────────────────────────────────────

/**
 * Exposes `window.wallet` to the renderer.
 *
 * contextBridge.exposeInMainWorld clones the object across the context
 * boundary; only plain values, arrays, Buffers, and functions survive.
 * The WalletApi methods are all plain functions, so they transfer safely.
 */
contextBridge.exposeInMainWorld("wallet", walletApi);
