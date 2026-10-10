// SPDX-License-Identifier: Apache-2.0
/**
 * The registry of the bridge's IPC channels (one per method of `src/shared/bridge.ts`). Every channel is listened to,
 * and every call is checked before its handler runs:
 *
 * - the sender must be the main window's own page (its top frame showing the bundled client; `index.ts` decides with
 *   `event.senderFrame`): embeds, other windows and the sign-in window (which has no preload anyway) are refused with
 *   `ipc.forbidden`;
 * - the arguments must pass the method's checks (hand-written guards below, no schema library: type, length, range,
 *   exact arity, no unknown fields), otherwise `ipc.invalid_arguments`;
 * - a method whose part of the shell does not exist yet answers "not implemented".
 *
 * Handlers return the value or throw the refusal the Tauri command would reject with: an error code string, an
 * `Error` (its message, the code, travels), or a plain object (a resolve failure).
 */
import { BRIDGE_METHODS, channelOf, type BridgeMethodName, type BridgeNamespaceName, type IpcReply } from "../shared/bridge.ts";

/** The parts of Electron's `IpcMainInvokeEvent` the registry looks at. */
export interface IpcEventLike {
  sender: unknown;
  senderFrame: { url: string } | null;
}

/** The part of Electron's `ipcMain` the registry uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
}

export type ArgsCheck = (args: readonly unknown[]) => boolean;
type Check = (value: unknown) => boolean;
type Handler = (...args: never[]) => unknown;

/** Argument checks for {@link IpcRegistry.handle}. */
export const check = {
  /** Exactly the `required` arguments, then at most the `optional` ones (an absent or `undefined` optional one passes). */
  args:
    (required: readonly Check[], optional: readonly Check[] = []): ArgsCheck =>
    (args) =>
      args.length >= required.length &&
      args.length <= required.length + optional.length &&
      args.every((a, i) => (i < required.length ? required[i]?.(a) : a === undefined || optional[i - required.length]?.(a)) === true),
  string:
    (max: number): Check =>
    (v) =>
      typeof v === "string" && v.length <= max,
  nullableString:
    (max: number): Check =>
    (v) =>
      v === null || (typeof v === "string" && v.length <= max),
  bool: ((v) => typeof v === "boolean") as Check,
  int:
    (min: number, max: number): Check =>
    (v) =>
      Number.isInteger(v) && (v as number) >= min && (v as number) <= max,
  bytes:
    (max: number): Check =>
    (v) =>
      v instanceof Uint8Array && v.byteLength <= max,
  oneOf:
    (...values: readonly string[]): Check =>
    (v) =>
      typeof v === "string" && values.includes(v),
  /** A plain object with exactly these fields (each checked; unknown fields refused). */
  record:
    (shape: Readonly<Record<string, Check>>): Check =>
    (v) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      return Object.keys(o).every((k) => k in shape) && Object.entries(shape).every(([k, c]) => c(o[k]));
    },
};

/** The refusal a handler threw, as the client receives it. */
function refusal(e: unknown): unknown {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) return { ...(e as Record<string, unknown>) };
  return String(e);
}

export class IpcRegistry {
  readonly #trusted: (event: IpcEventLike) => boolean;
  readonly #handlers = new Map<string, { args: ArgsCheck; fn: Handler }>();

  /** `trusted`: whether an event comes from the main window's own page. */
  constructor(trusted: (event: IpcEventLike) => boolean) {
    this.#trusted = trusted;
  }

  /** Registers the handler of a method (once). */
  handle<N extends BridgeNamespaceName>(namespace: N, method: BridgeMethodName<N>, args: ArgsCheck, fn: Handler): void {
    const methods: readonly string[] = BRIDGE_METHODS[namespace] ?? [];
    if (!methods.includes(method)) throw new Error(`${namespace}.${method} is not a method of the bridge`);
    const channel = channelOf(namespace, method);
    if (this.#handlers.has(channel)) throw new Error(`${channel} is handled twice`);
    this.#handlers.set(channel, { args, fn });
  }

  /** Answers one call of a method's channel. */
  async dispatch(channel: string, method: string, event: IpcEventLike, args: unknown[]): Promise<IpcReply> {
    if (!this.#trusted(event)) return { ok: false, error: "ipc.forbidden" };
    const handler = this.#handlers.get(channel);
    if (!handler) return { ok: false, error: `not implemented: ${method}`, notImplemented: true };
    if (!handler.args(args)) return { ok: false, error: "ipc.invalid_arguments" };
    try {
      return { ok: true, value: await (handler.fn as (...a: unknown[]) => unknown)(...args) };
    } catch (e) {
      return { ok: false, error: refusal(e) };
    }
  }

  /** Listens to every channel of the bridge. */
  install(ipcMain: IpcMainLike): void {
    for (const [namespace, methods] of Object.entries(BRIDGE_METHODS)) {
      for (const method of methods) {
        const channel = channelOf(namespace, method);
        ipcMain.handle(channel, (event, ...args) => this.dispatch(channel, method, event, args));
      }
    }
  }
}
