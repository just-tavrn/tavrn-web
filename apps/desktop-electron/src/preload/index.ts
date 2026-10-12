// SPDX-License-Identifier: Apache-2.0
/**
 * The preload of the main window: exposes the bridge as `window.tavrnShell` (`contextBridge`, the page never sees
 * `ipcRenderer` or Node). Its shape is `TavrnShellBridge` of the client (`web/src/platform/electronBridge.ts`, through
 * the path alias of tsconfig.json); the method names are checked against `src/shared/bridge.ts` at compile time. The
 * preload is bundled into one CommonJS file (`vite.preload.config.ts`): a sandboxed preload cannot load other files.
 *
 * A namespace whose preload side needs more than plain calls gets a module of its own next to this one and replaces
 * the generic `namespace(…)` below; the main process side lives in `src/main` (registered with `ipc.ts`).
 */
import { contextBridge } from "electron";
import type { BridgeMethod, BridgeNamespace, TavrnShellBridge } from "@tavrn/web/electronBridge";
import type { BridgeMethodName, BridgeNamespaceName } from "../shared/bridge.ts";
import { events } from "./events.ts";
import { namespace } from "./invoke.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time: the method list of `src/shared/bridge.ts` is exactly the client's bridge type. */
const sameShape: { namespaces: Same<BridgeNamespace, BridgeNamespaceName> } & { [N in BridgeNamespace]: Same<BridgeMethod<N>, BridgeMethodName<N>> } = {
  namespaces: true,
  shell: true,
  updater: true,
  files: true,
  keychain: true,
  notify: true,
  tray: true,
  hotkeys: true,
  passkeys: true,
  games: true,
};
void sameShape;

const bridge = {
  kind: "electron",
  window: "main",
  shell: namespace("shell"),
  updater: namespace("updater"),
  files: namespace("files"),
  keychain: namespace("keychain"),
  notify: namespace("notify"),
  tray: namespace("tray"),
  hotkeys: namespace("hotkeys"),
  passkeys: namespace("passkeys"),
  games: namespace("games"),
  events,
} as unknown as TavrnShellBridge;

contextBridge.exposeInMainWorld("tavrnShell", bridge);
