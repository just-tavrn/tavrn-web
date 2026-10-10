// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app on Linux: the Electron shell (`apps/desktop-electron`, docs/DESKTOP.md "The Linux shell (Electron)").
 * Talks to the shell only through the bridge its preload exposes (`window.tavrnShell`, `electronBridge.ts`), whose
 * methods are the Tauri shell's commands: the same `Platform` as `tauri.ts`, the same flows. The client does not care
 * which shell it runs in (`kind` is "desktop" for both). Voice and video run in Chromium itself, so there is no native
 * voice engine here (`voice` stays absent and the browser engine is used). Loaded only inside the app
 * (platform/index.ts).
 */
import { runAppSession, runAppUnlock } from "./appSession";
import { electronBridge } from "./electronDetect";
import type { BridgeEvent, TavrnShellBridge } from "./electronBridge";
import { createElectronSaveFile } from "./electronFiles";
import { externalUrl, installLinkHandler } from "./links";
import type { AppUpdater, HotkeyAction, HotkeyEvent, Platform, PlatformHotkeys, PlatformKeystore, PlatformNotifications, PlatformTray, TrayAction } from "./types";

const TRAY_ACTIONS: readonly string[] = ["mute", "deafen", "leave"] satisfies TrayAction[];
const HOTKEY_ACTIONS: readonly string[] = ["push_to_talk", "priority", "toggle_mute", "toggle_deafen"] satisfies HotkeyAction[];
/** Only paths of the client (the shell validated them too). */
const isClientPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.startsWith("//");

/** The shell's events, fanned out to the client's listeners by kind (one subscription to the bridge). */
function eventHub(bridge: TavrnShellBridge) {
  const opens = new Set<(path: string) => void>();
  const actions = new Set<(action: TrayAction) => void>();
  const hotkeys = new Set<(event: HotkeyEvent) => void>();
  bridge.events.subscribe((e: BridgeEvent) => {
    if (e?.channel === "shell_events") {
      const ev = e.event;
      if (ev?.kind === "open" && isClientPath(ev.path)) for (const fn of opens) fn(ev.path);
      if (ev?.kind === "tray" && TRAY_ACTIONS.includes(ev.action)) for (const fn of actions) fn(ev.action);
    }
    if (e?.channel === "hotkeys" && HOTKEY_ACTIONS.includes(e.event?.action) && typeof e.event.pressed === "boolean") {
      for (const fn of hotkeys) fn({ action: e.event.action, pressed: e.event.pressed });
    }
  });
  const add =
    <T>(set: Set<T>) =>
    (fn: T): (() => void) => {
      set.add(fn);
      return () => void set.delete(fn);
    };
  return { onOpen: add(opens), onTray: add(actions), onHotkey: add(hotkeys) };
}

/** The desktop platform over the Electron shell's bridge; `doc` receives the link handler (tests pass a detached document). */
export async function createElectronPlatform(bridge: TavrnShellBridge | null = electronBridge(), doc: Document = document): Promise<Platform> {
  if (!bridge) throw new Error("not inside the Electron shell");
  const { shell } = bridge;
  const [config, info] = await Promise.all([shell.getConfig(), shell.appInfo()]);
  let node = config.node;
  let web = config.web ?? null;
  let domain = config.domain ?? null;
  const events = eventHub(bridge);
  const openExternal = async (url: string) => {
    await shell.openExternal(externalUrl(url));
  };
  const updater: AppUpdater = {
    check: async () => {
      const found = await bridge.updater.checkUpdate();
      if (!found) return null;
      return { version: found.version, notes: found.notes ?? null, install: () => bridge.updater.installUpdate() };
    },
  };
  const hotkeys: PlatformHotkeys = {
    register: (action, combo) => bridge.hotkeys.registerHotkey(action, combo),
    unregister: (action) => bridge.hotkeys.unregisterHotkey(action),
    subscribe: events.onHotkey,
    setEnabled: (enabled) => bridge.hotkeys.setHotkeysEnabled(enabled),
  };
  const keystore: PlatformKeystore = {
    status: () => bridge.keychain.keychainStatus(),
    get: (account) => bridge.keychain.keychainGet(account),
    set: (account, secret) => bridge.keychain.keychainSet(account, secret),
    delete: (account) => bridge.keychain.keychainDelete(account),
  };
  const notifications: PlatformNotifications = {
    show: (notice) => bridge.notify.notify(notice),
    onOpen: events.onOpen,
  };
  const tray: PlatformTray = {
    set: (state, labels) => bridge.tray.traySet(state, labels),
    onAction: events.onTray,
    status: async () => {
      const s = await bridge.tray.trayStatus();
      return { state: s.state, tooltip: s.tooltip, available: s.available, closeToTray: s.close_to_tray };
    },
    setCloseToTray: (on) => bridge.tray.setCloseToTray(on),
    quit: () => bridge.tray.quitApp(),
  };
  const platform: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node ?? "",
    // A node serves its web client on the URL the user picked (where links shared with others point to), unless its
    // document names another origin.
    webOrigin: () => web ?? node ?? location.origin,
    openExternal,
    appVersion: async () => info.version,
    node: {
      current: () => node,
      set: async (url, details) => {
        node = await (details ? shell.setNode(url, details.web ?? null, details.domain ?? null) : shell.setNode(url));
        web = details?.web ? new URL(details.web).origin : null;
        domain = details?.domain ?? null;
      },
      domain: () => domain,
      resolve: (name) => shell.resolveNode(name),
    },
    auth: {
      // The node's page in a window of the shell without any bridge (FEDERATION.md §8 step 3, docs/DESKTOP.md).
      signInOnNodePage: (req) =>
        runAppSession({
          api: req.api,
          web: req.endpoints.web,
          domain: req.endpoints.domain,
          deviceName: "Desktop app",
          mode: req.mode,
          method: req.method,
          open: (url) => shell.openConnect(url),
          close: () => shell.closeConnect(),
          onPage: req.onPage,
          device: req.device,
          signal: req.signal,
        }),
      unlockOnNodePage: (req) =>
        runAppUnlock({
          api: req.api,
          web: req.endpoints.web,
          domain: req.endpoints.domain,
          deviceName: "Desktop app",
          open: (url) => shell.openConnect(url),
          close: () => shell.closeConnect(),
          onPage: req.onPage,
          signal: req.signal,
        }),
      reopen: (url) => shell.openConnect(url),
    },
    ...(info.updater ? { updater } : {}),
    hotkeys,
    keystore,
    notifications,
    tray,
    saveFile: createElectronSaveFile(bridge.files),
  };
  installLinkHandler(doc, openExternal, platform.webOrigin);
  return platform;
}
