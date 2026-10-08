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
  /** Desktop, later: global hotkeys (push-to-talk, mute, deafen) that work while the app is in the background. */
  readonly hotkeys?: PlatformHotkeys;
  /** Desktop: the key that protects the local key store, in the OS keychain (`crypto/store.ts`). */
  readonly keystore?: PlatformKeystore;
  /** Desktop: native notifications while the window is in the background. */
  readonly notifications?: PlatformNotifications;
  /** Desktop: the tray icon with the voice state. */
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

/* Extension points: their members are defined by the steps that implement them. */
export interface PlatformHotkeys {}
/** Which keychain holds the secrets (`none`: no keychain could be opened) and whether it answers right now. */
export interface KeychainStatus {
  backend: "secret-service" | "credential-manager" | "keychain" | "memory" | "none";
  available: boolean;
}

/**
 * The OS keychain of the desktop app, scoped by the shell to the home node: one 32-byte secret per account (the
 * local storage key). Every call may reject (`keychain.unavailable` when no keychain answers).
 */
export interface PlatformKeystore {
  status(): Promise<KeychainStatus>;
  get(account: string): Promise<Uint8Array | null>;
  set(account: string, secret: Uint8Array): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface NativeNotice {
  title: string;
  body: string;
  /** Path of the client a click opens. */
  path: string | null;
}

export interface PlatformNotifications {
  /** Shows a native notification (the caller decides when: the window is not focused). */
  show(notice: NativeNotice): Promise<void>;
  /** A notification was clicked: the shell focused the window, the client opens `path`. Returns the unsubscriber. */
  onOpen(fn: (path: string) => void): () => void;
}

/** Not in a voice channel, in one, speaking (the own voice goes through), microphone muted, deafened (wins over muted). */
export type TrayVoiceState = "disconnected" | "connected" | "speaking" | "muted" | "deafened";
export type TrayAction = "mute" | "deafen" | "leave";

/** The texts of the tray in the client's language. */
export interface TrayLabels {
  /** The channel and the state. */
  tooltip: string;
  show: string;
  hide: string;
  mute: string;
  deafen: string;
  leave: string;
  quit: string;
}

export interface TrayStatus {
  state: TrayVoiceState;
  tooltip: string;
  /** The desktop shows a tray icon. */
  available: boolean;
  /** Closing the window hides it into the tray. */
  closeToTray: boolean;
}

export interface PlatformTray {
  set(state: TrayVoiceState, labels: TrayLabels): Promise<void>;
  /** A voice item of the tray menu was chosen. Returns the unsubscriber. */
  onAction(fn: (action: TrayAction) => void): () => void;
  status(): Promise<TrayStatus>;
  setCloseToTray(on: boolean): Promise<void>;
  /** Ends the app (with close to tray, closing the window does not). */
  quit(): Promise<void>;
}
