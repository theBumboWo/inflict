export type IpcRequest = {
    channel: "device:list";
} | {
    channel: "enrollment:start";
    payload: {
        displayName: string;
    };
} | {
    channel: "enrollment:cancel";
} | {
    channel: "credential:discover";
    payload: {
        devicePath: string;
    };
} | {
    channel: "credential:select";
    payload: {
        credentialId: string;
    };
} | {
    channel: "wallet:derive";
    payload: {
        devicePath: string;
        credentialId: string;
    };
} | {
    channel: "session:get";
} | {
    channel: "session:terminate";
} | {
    channel: "balance:get";
} | {
    channel: "balance:refresh";
} | {
    channel: "transaction:validate";
    payload: TransferParams;
} | {
    channel: "transaction:preview";
    payload: TransferParams;
} | {
    channel: "transaction:submit";
    payload: TransferParams;
} | {
    channel: "address:copy";
};
export type IpcEvent = {
    event: "device:connected";
    data: {
        devicePath: string;
        supportsHmacSecret: boolean;
    };
} | {
    event: "device:removed";
    data: {
        devicePath: string;
    };
} | {
    event: "device:unsupported";
    data: {
        reason: string;
    };
} | {
    event: "session:changed";
    data: SessionPublicData | null;
} | {
    event: "balance:updated";
    data: {
        sol: string;
        lamports: string;
    };
} | {
    event: "balance:unavailable";
} | {
    event: "enrollment:progress";
    data: {
        stage: EnrollmentState;
    };
} | {
    event: "error";
    data: {
        category: ErrorCategory;
        message: string;
    };
};
/** Safe public session data: no private key material */
export interface SessionPublicData {
    sessionId: string;
    walletAddress: string;
    displayName: string;
    credentialId: string;
}
export type ErrorCategory = "device-error" | "pin-required" | "pin-locked" | "operation-not-supported" | "enrollment-failed" | "derivation-failed" | "rpc-timeout" | "rpc-unreachable" | "rpc-invalid-response" | "transaction-invalid" | "session-locked" | "storage-full" | "unknown";
export interface TransferParams {
    destinationAddress: string;
    lamports: bigint;
    currentBalanceLamports: bigint;
}
export type EnrollmentState = "idle" | "checking-pin" | "awaiting-touch" | "storing-metadata" | "complete" | "failed";
export interface TransactionPreview {
    destinationAddress: string;
    /** Formatted to 9 decimal places */
    amountSol: string;
    estimatedFeeSol: string;
    blockhash: string;
}
/** Extract the channel string from an IpcRequest variant. */
export type RequestChannel = IpcRequest["channel"];
/** Extract the event string from an IpcEvent variant. */
export type EventName = IpcEvent["event"];
/**
 * Given a channel string, resolve the full IpcRequest union member that has
 * that channel.  Used to derive the payload type for `invoke`.
 */
export type RequestFor<C extends RequestChannel> = Extract<IpcRequest, {
    channel: C;
}>;
/**
 * Resolve the payload type for a request channel.
 * Channels without a `payload` field resolve to `undefined` so callers can
 * omit the argument.
 */
export type PayloadFor<C extends RequestChannel> = RequestFor<C> extends {
    payload: infer P;
} ? P : undefined;
/**
 * Given an event name, resolve the full IpcEvent union member that has that
 * event.  Used to derive the listener data type for `on` / `off`.
 */
export type EventFor<E extends EventName> = Extract<IpcEvent, {
    event: E;
}>;
/**
 * Resolve the data type for a push event.
 * Events without a `data` field resolve to `undefined`.
 */
export type DataFor<E extends EventName> = EventFor<E> extends {
    data: infer D;
} ? D : undefined;
/** Typed callback for a given push event. */
export type EventListener<E extends EventName> = (data: DataFor<E>) => void;
/**
 * The typed wallet API exposed to the renderer via `window.wallet`.
 *
 * `invoke`  — sends a request to the main process and returns a Promise with
 *             the handler's resolved value.
 * `on`      — subscribes to a push event from the main process.
 * `off`     — unsubscribes a previously registered listener.
 */
export interface WalletApi {
    /**
     * Invoke a main-process IPC handler.
     *
     * Channels that carry no payload (e.g. `"device:list"`) accept no second
     * argument.  Channels that carry a payload require it.
     */
    invoke<C extends RequestChannel>(...args: PayloadFor<C> extends undefined ? [channel: C] : [channel: C, payload: PayloadFor<C>]): Promise<unknown>;
    /**
     * Subscribe to a push event emitted by the main process.
     */
    on<E extends EventName>(event: E, listener: EventListener<E>): void;
    /**
     * Unsubscribe a previously registered listener.
     */
    off<E extends EventName>(event: E, listener: EventListener<E>): void;
}
//# sourceMappingURL=ipc-types.d.ts.map