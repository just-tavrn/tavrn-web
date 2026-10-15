// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's keychain, native notifications and tray (docs/DESKTOP.md): thin wrappers around the shell's
 * commands (`src-tauri/src/keychain.rs`, `notify.rs`, `tray.rs`). Clicks on notifications and tray menu actions come
 * back through the shell's events (`shellEvents.ts`). Loaded with `tauri.ts`, inside the app only.
 */
import { invoke } from "@tauri-apps/api/core";
import { createShellEvents, type ShellEvents } from "./shellEvents";
import type { KeychainStatus, PlatformKeystore, PlatformNotifications, PlatformTray, TrayAction, TrayStatus } from "./types";
import { withKeyNumbers } from "./keyBytes";

const TRAY_ACTIONS: readonly string[] = ["mute", "deafen", "leave"] satisfies TrayAction[];

/** Only paths of the client (the shell validated them too). */
export const isClientPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.startsWith("//");

/** Notification clicks of the shell (desktop and Android). */
export function notificationOpens(events: ShellEvents, fn: (path: string) => void): () => void {
  return events.on((event) => {
    if (event.kind === "open" && isClientPath(event.path)) fn(event.path);
  });
}

/** Voice actions of the tray menu (Android: the voice notification's buttons). */
export function trayActions(events: ShellEvents, fn: (action: TrayAction) => void): () => void {
  return events.on((event) => {
    if (event.kind === "tray" && TRAY_ACTIONS.includes(event.action)) fn(event.action);
  });
}

export function shellMembers(events: ShellEvents = createShellEvents()): { keystore: PlatformKeystore; notifications: PlatformNotifications; tray: PlatformTray } {
  const keystore: PlatformKeystore = {
    status: () => invoke<KeychainStatus>("keychain_status"),
    get: async (account) => {
      const secret = await invoke<number[] | null>("keychain_get", { account });
      if (!secret) return null;
      const bytes = Uint8Array.from(secret);
      // The number array of the IPC answer is a second copy of the key: wiped at once.
      secret.fill(0);
      return bytes;
    },
    set: (account, secret) => withKeyNumbers(secret, (numbers) => invoke<void>("keychain_set", { account, secret: numbers })),
    delete: (account) => invoke<void>("keychain_delete", { account }),
  };

  const notifications: PlatformNotifications = {
    show: (notice) => invoke<void>("notify", { notice }),
    onOpen: (fn) => notificationOpens(events, fn),
  };

  const tray: PlatformTray = {
    set: (state, labels) => invoke<void>("tray_set", { state, labels }),
    onAction: (fn) => trayActions(events, fn),
    status: async () => {
      const s = await invoke<{ state: TrayStatus["state"]; tooltip: string; available: boolean; close_to_tray: boolean }>("tray_status");
      return { state: s.state, tooltip: s.tooltip, available: s.available, closeToTray: s.close_to_tray };
    },
    setCloseToTray: (on) => invoke<void>("set_close_to_tray", { on }),
    quit: () => invoke<void>("quit_app"),
  };

  return { keystore, notifications, tray };
}
