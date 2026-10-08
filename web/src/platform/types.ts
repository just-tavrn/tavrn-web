// SPDX-License-Identifier: Apache-2.0
/**
 * The platform the client runs on: a browser tab served by a node, or the desktop app (Tauri shell in
 * `apps/desktop`) that bundles the client and talks to the node the user picked (docs/DESKTOP.md).
 *
 * The interface is deliberately small. The optional members at the end are extension points of the
 * desktop app: they stay absent in the browser and are filled by the shell's later steps (global
 * hotkeys, OS keychain, native notifications, tray). Code that uses them checks for presence.
 */
export type PlatformKind = "browser" | "desktop";

export interface Platform {
  readonly kind: PlatformKind;
  readonly isDesktop: boolean;
  /**
   * Base URL of the node the client belongs to, for the API client (`<base>/api/v1`), the WebSocket and media.
   * `""` in the browser: the node that served the client, same origin.
   */
  nodeBase(): string;
  /** Origin of that node's web client: what links shared with other people point to (invites, message links). */
  webOrigin(): string;
  /** Opens a link outside the client (new browser tab, or the system browser of the desktop app). */
  openExternal(url: string): Promise<void>;
  /** Version of the client (the browser) or of the installed app (desktop). */
  appVersion(): Promise<string>;
  /** Desktop: the home node chosen on the first start (node picker), changeable in the settings. */
  readonly node?: NodeChoice;
  /** Desktop: signed updates of the app (absent while the build has no updater key). */
  readonly updater?: AppUpdater;
  /** Desktop: global hotkeys (push-to-talk, priority speaker, mute, deafen) that work while the app is in the background. */
  readonly hotkeys?: PlatformHotkeys;
  /** Desktop, later: device keys and the local key store in the OS keychain. */
  readonly keystore?: PlatformKeystore;
  /** Desktop, later: native notifications. */
  readonly notifications?: PlatformNotifications;
  /** Desktop, later: the tray icon with the voice state. */
  readonly tray?: PlatformTray;
}

export interface NodeChoice {
  /** The chosen node's URL (an origin such as `https://tavrn.example`), or null before the first choice. */
  current(): string | null;
  /** Validates and persists a new node (the shell refuses invalid URLs); the client reloads afterwards. */
  set(url: string): Promise<void>;
}

export interface AppUpdater {
  /** The newest signed release, or null when this version is current. */
  check(): Promise<AvailableUpdate | null>;
}

export interface AvailableUpdate {
  version: string;
  notes?: string | null;
  /** Downloads, verifies the signature, installs and restarts the app. */
  install(): Promise<void>;
}

/** What a global hotkey does in the voice client (the shell's `hotkeys.rs` uses the same names). */
export type HotkeyAction = "push_to_talk" | "priority" | "toggle_mute" | "toggle_deafen";

/** A press or release of a bound combination, reported by the shell. */
export interface HotkeyEvent {
  action: HotkeyAction;
  pressed: boolean;
}

/**
 * Global hotkeys of the desktop app. The shell validates a combination (`Ctrl+Alt+Shift+Super+<KeyboardEvent.code>`),
 * refuses one that another action uses and grabs it through the OS; the client keeps the bindings in its voice
 * settings and registers them at start.
 */
export interface PlatformHotkeys {
  /** Binds `combo` to `action`; resolves to its canonical spelling, rejects with a `hotkey.*` code. */
  register(action: HotkeyAction, combo: string): Promise<string>;
  /** Removes the binding of `action`. */
  unregister(action: HotkeyAction): Promise<void>;
  /** Presses and releases of the bound combinations; returns the unsubscriber. */
  subscribe(handler: (event: HotkeyEvent) => void): () => void;
}

/* Extension points: their members are defined by the steps that implement them. */
export interface PlatformKeystore {}
export interface PlatformNotifications {}
export interface PlatformTray {}
