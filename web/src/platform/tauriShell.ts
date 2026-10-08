// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's keychain, native notifications and tray (docs/DESKTOP.md): thin wrappers around the shell's
 * commands (`src-tauri/src/keychain.rs`, `notify.rs`, `tray.rs`). Clicks on notifications and tray menu actions come
 * back through one IPC channel (`shell_events`), subscribed on the first listener. Loaded with `tauri.ts`, inside the
 * app only.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { KeychainStatus, PlatformKeystore, PlatformNotifications, PlatformTray, TrayAction, TrayStatus } from "./types";

type ShellEvent = { kind: "open"; path: string } | { kind: "tray"; action: TrayAction };

const TRAY_ACTIONS: readonly string[] = ["mute", "deafen", "leave"] satisfies TrayAction[];

/** Only paths of the client (the shell validated them too). */
const isClientPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.startsWith("//");

export function shellMembers(): { keystore: PlatformKeystore; notifications: PlatformNotifications; tray: PlatformTray } {
  const opens = new Set<(path: string) => void>();
  const actions = new Set<(action: TrayAction) => void>();
  let subscribed = false;

  const dispatch = (event: ShellEvent) => {
    if (event?.kind === "open" && isClientPath(event.path)) for (const fn of opens) fn(event.path);
    if (event?.kind === "tray" && TRAY_ACTIONS.includes(event.action)) for (const fn of actions) fn(event.action);
  };

  const subscribe = <T>(set: Set<T>, fn: T): (() => void) => {
    set.add(fn);
    if (!subscribed) {
      subscribed = true;
      const onEvent = new Channel<ShellEvent>(dispatch);
      invoke("shell_events", { onEvent }).catch(() => {
        subscribed = false;
      });
    }
    return () => void set.delete(fn);
  };

  const keystore: PlatformKeystore = {
    status: () => invoke<KeychainStatus>("keychain_status"),
    get: async (account) => {
      const secret = await invoke<number[] | null>("keychain_get", { account });
      return secret ? Uint8Array.from(secret) : null;
    },
    set: (account, secret) => invoke<void>("keychain_set", { account, secret: Array.from(secret) }),
    delete: (account) => invoke<void>("keychain_delete", { account }),
  };

  const notifications: PlatformNotifications = {
    show: (notice) => invoke<void>("notify", { notice }),
    onOpen: (fn) => subscribe(opens, fn),
  };

  const tray: PlatformTray = {
    set: (state, labels) => invoke<void>("tray_set", { state, labels }),
    onAction: (fn) => subscribe(actions, fn),
    status: async () => {
      const s = await invoke<{ state: TrayStatus["state"]; tooltip: string; available: boolean; close_to_tray: boolean }>("tray_status");
      return { state: s.state, tooltip: s.tooltip, available: s.available, closeToTray: s.close_to_tray };
    },
    setCloseToTray: (on) => invoke<void>("set_close_to_tray", { on }),
    quit: () => invoke<void>("quit_app"),
  };

  return { keystore, notifications, tray };
}
