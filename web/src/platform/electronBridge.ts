// SPDX-License-Identifier: Apache-2.0
/**
 * The bridge the Electron shell (`apps/desktop-electron`, the Linux app) exposes to the bundled client in its main
 * window as `window.tavrnShell` (docs/DESKTOP.md "The Linux shell (Electron)"). Types only: the shell's preload
 * (`apps/desktop-electron/src/preload/`) implements exactly this shape, the client's binding (`electron.ts`) is its only
 * caller. The method names are the Tauri shell's command names in camelCase, their arguments and answers the same
 * values (`apps/desktop/src-tauri/src/commands.rs` and its siblings), so both shells behave alike.
 *
 * Every method answers a promise. A refusal of the shell rejects with the same value the Tauri command rejects with: an
 * error code string such as `node_url.insecure`, or for `resolveNode` a {@link ResolveFailure} object. A method whose
 * part of the shell does not exist yet rejects with `Error("not implemented: <name>")`.
 *
 * Keep this file free of runtime code and of imports: the preload type-checks against it through a path alias, without
 * the rest of the client. The values on the wire are spelled out here (as the Tauri shell's Rust structs are);
 * `electron.ts` hands them to the client's `Platform` types, so the compiler keeps both in step.
 */

export type HotkeyAction = "push_to_talk" | "priority" | "toggle_mute" | "toggle_deafen";
export interface HotkeyEvent {
  action: HotkeyAction;
  pressed: boolean;
}
export interface KeychainStatus {
  backend: "secret-service" | "credential-manager" | "keychain" | "memory" | "none";
  available: boolean;
}
export interface NativeNotice {
  title: string;
  body: string;
  path: string | null;
}
export type TrayVoiceState = "disconnected" | "connected" | "speaking" | "muted" | "deafened";
export type TrayAction = "mute" | "deafen" | "leave";
export interface TrayLabels {
  tooltip: string;
  show: string;
  hide: string;
  mute: string;
  deafen: string;
  leave: string;
  quit: string;
}
/** The shell's `resolveNode` answer. */
export interface ResolvedNode {
  domain: string;
  api: string;
  ws: string;
  web: string;
  source: "well_known" | "srv" | "domain";
}
/** Why `resolveNode` found no node. */
export interface ResolveFailure {
  code: string;
  step: "input" | "well_known" | "srv" | "direct";
  domain: string;
}

/** The settings file of the shell (`config.json` of the Tauri shell, the same schema). */
export interface ShellConfig {
  /** Origin of the home node, or null before the first choice. */
  node: string | null;
  /** Origin of the node's web client, when its document named one. */
  web?: string | null;
  /** Identity domain of the node, when known. */
  domain?: string | null;
  /** Closing the window hides it into the tray; absent: the platform's default. */
  close_to_tray?: boolean;
}

export interface ShellAppInfo {
  /** Version of the installed app (`web/package.json`'s). */
  version: string;
  /** False while the build cannot update itself (no update feed configured, development builds). */
  updater: boolean;
}

/** The update channel (`stable`: releases only, `beta`: pre-releases too). */
export type UpdateChannel = "stable" | "beta";

export interface ShellUpdateInfo {
  version: string;
  notes?: string | null;
}

export type SaveBegin = { status: "ready"; id: string } | { status: "cancelled" };

export interface SaveDone {
  path: string;
  folder: string;
}

/** The tray's answer of `trayStatus` (the Tauri shell's field names). */
export interface ShellTrayStatus {
  state: TrayVoiceState;
  tooltip: string;
  available: boolean;
  close_to_tray: boolean;
}

/**
 * Events of the Tauri shell's `shell_events` channel: a notification click, a tray menu action; `link`: deep links
 * wait for the client (`shell.takeLinks`).
 */
export type ShellEvent = { kind: "open"; path: string } | { kind: "tray"; action: TrayAction } | { kind: "link" };

/**
 * What `events.subscribe` delivers: the Tauri shell's channels in one stream, each with its own payloads
 * (`shell_events`: {@link ShellEvent}; `hotkeys`: the presses and releases `listen_hotkeys` reports).
 */
export type BridgeEvent = { channel: "shell_events"; event: ShellEvent } | { channel: "hotkeys"; event: HotkeyEvent };

export interface TavrnShellBridge {
  readonly kind: "electron";
  /** The window this bridge lives in; only the main window gets a bridge at all (the sign-in window has none). */
  readonly window: "main";
  readonly shell: {
    getConfig(): Promise<ShellConfig>;
    /** Validates and persists the home node; answers its normalized origin. */
    setNode(url: string, web?: string | null, domain?: string | null): Promise<string>;
    appInfo(): Promise<ShellAppInfo>;
    /** Opens an http, https or mailto link in the system browser. */
    openExternal(url: string): Promise<void>;
    /** The node of an identity domain (FEDERATION.md §1.4); rejects with a `ResolveFailure`. */
    resolveNode(domain: string): Promise<ResolvedNode>;
    /** Shows the chosen node's `/connect?session=…` page in the sign-in window. */
    openConnect(url: string): Promise<void>;
    closeConnect(): Promise<void>;
    /** The checked deep links (`tavrn://…`) that opened the app since the last call: a start's and a second start's. */
    takeLinks(): Promise<string[]>;
  };
  readonly updater: {
    checkUpdate(): Promise<ShellUpdateInfo | null>;
    /** Downloads, verifies and installs the newest release, then restarts the app. */
    installUpdate(): Promise<void>;
    /** The update channel in effect (the choice, else the default for this version). */
    getUpdateChannel(): Promise<UpdateChannel>;
    setUpdateChannel(channel: UpdateChannel): Promise<void>;
  };
  readonly files: {
    /** Shows the save dialog; at most 8 saves at once. */
    saveFileBegin(name: string, mime: string, size: number): Promise<SaveBegin>;
    /** Appends at most 4 MiB to the save `id`. */
    saveFileChunk(id: string, bytes: Uint8Array): Promise<void>;
    saveFileEnd(id: string): Promise<SaveDone>;
    saveFileAbort(id: string): Promise<void>;
    saveFileReveal(id: string): Promise<void>;
  };
  readonly keychain: {
    keychainGet(account: string): Promise<Uint8Array | null>;
    /** Exactly 32 bytes. */
    keychainSet(account: string, secret: Uint8Array): Promise<void>;
    keychainDelete(account: string): Promise<void>;
    keychainStatus(): Promise<KeychainStatus>;
  };
  readonly notify: {
    notify(notice: NativeNotice): Promise<void>;
  };
  readonly tray: {
    traySet(state: TrayVoiceState, labels: TrayLabels): Promise<void>;
    trayStatus(): Promise<ShellTrayStatus>;
    setCloseToTray(on: boolean): Promise<void>;
    quitApp(): Promise<void>;
  };
  readonly hotkeys: {
    /** Answers the canonical spelling of the binding; rejects with a `hotkey.*` code. */
    registerHotkey(action: HotkeyAction, combo: string): Promise<string>;
    unregisterHotkey(action: HotkeyAction): Promise<void>;
    /** Answers whether the key listener runs now. */
    setHotkeysEnabled(enabled: boolean): Promise<boolean>;
  };
  readonly events: {
    /** Every event of the shell for this window; returns the unsubscriber. */
    subscribe(handler: (event: BridgeEvent) => void): () => void;
  };
}

/** The namespaces with methods, and their method names: the preload and the shell's IPC registry use this list. */
export type BridgeNamespace = Exclude<keyof TavrnShellBridge, "kind" | "window" | "events">;
export type BridgeMethod<N extends BridgeNamespace> = keyof TavrnShellBridge[N] & string;
