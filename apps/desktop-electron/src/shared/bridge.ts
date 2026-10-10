// SPDX-License-Identifier: Apache-2.0
/**
 * The bridge's methods, shared by the preload (which exposes them as `window.tavrnShell.<namespace>.<method>`) and the
 * main process (whose IPC registry answers them, `src/main/ipc.ts`). The names are the Tauri shell's command names in
 * camelCase; the shape and the types of their arguments and answers are `TavrnShellBridge` in the client
 * (`web/src/platform/electronBridge.ts`; the preload checks at compile time that this list matches it). One IPC
 * channel per method, `tavrn:<namespace>.<method>`, and one channel for the shell's events to the main window.
 */
export const BRIDGE_METHODS = {
  shell: ["getConfig", "setNode", "appInfo", "openExternal", "resolveNode", "openConnect", "closeConnect"],
  updater: ["checkUpdate", "installUpdate"],
  files: ["saveFileBegin", "saveFileChunk", "saveFileEnd", "saveFileAbort", "saveFileReveal"],
  keychain: ["keychainGet", "keychainSet", "keychainDelete", "keychainStatus"],
  notify: ["notify"],
  tray: ["traySet", "trayStatus", "setCloseToTray", "quitApp"],
  hotkeys: ["registerHotkey", "unregisterHotkey", "setHotkeysEnabled"],
} as const;

export type BridgeNamespaceName = keyof typeof BRIDGE_METHODS;
export type BridgeMethodName<N extends BridgeNamespaceName> = (typeof BRIDGE_METHODS)[N][number];

/** The IPC channel of a method. */
export function channelOf(namespace: string, method: string): string {
  return `tavrn:${namespace}.${method}`;
}

/** Every IPC channel of the bridge's methods. */
export function bridgeChannels(): string[] {
  return Object.entries(BRIDGE_METHODS).flatMap(([namespace, methods]) => methods.map((m) => channelOf(namespace, m)));
}

/** The channel of the shell's events (main process to the main window). */
export const EVENT_CHANNEL = "tavrn:events";

/**
 * What the main process answers on a method's channel: the value, or the refusal the Tauri command would reject with
 * (an error code string, or an object such as a resolve failure). `notImplemented`: this part of the shell does not
 * exist yet; the preload rejects with `Error("not implemented: <method>")`.
 */
export type IpcReply = { ok: true; value: unknown } | { ok: false; error: unknown; notImplemented?: true };
