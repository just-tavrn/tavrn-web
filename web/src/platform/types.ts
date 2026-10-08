// SPDX-License-Identifier: Apache-2.0
/**
 * The platform the client runs on: a browser tab served by a node, or the desktop app (Tauri shell in
 * `apps/desktop`) that bundles the client and talks to the node the user picked (docs/DESKTOP.md).
 *
 * The interface is deliberately small. The optional members at the end are extension points of the
 * desktop app: they stay absent in the browser and are filled by the shell's later steps (global
 * hotkeys, OS keychain, native notifications, tray). Code that uses them checks for presence.
 */
import type { AuthResponse, DeviceProof, NodeEndpoints, TavrnApi } from "@tavrn/sdk";

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
  /** Desktop: the key that protects the local key store, in the OS keychain (`crypto/store.ts`). */
  readonly keystore?: PlatformKeystore;
  /** Desktop: native notifications while the window is in the background. */
  readonly notifications?: PlatformNotifications;
  /** Desktop: the tray icon with the voice state. */
  readonly tray?: PlatformTray;
  /** Sign-in on the node's own web client (passkeys, single sign-on, the captcha): connect flow, FEDERATION.md §8. */
  readonly auth?: PlatformAuth;
}

export interface NodeChoice {
  /** The chosen node's URL (an origin such as `https://tavrn.example`), or null before the first choice. */
  current(): string | null;
  /**
   * Validates and persists a new node (the shell refuses invalid URLs); the client reloads afterwards. `details` are
   * the identity domain and the web client's origin from the node's document (delegation: they may differ from `url`).
   */
  set(url: string, details?: NodeDetails): Promise<void>;
  /** The identity domain of the chosen node, when known (`alice@<domain>`). */
  domain?(): string | null;
  /**
   * Finds the node of an identity domain (`alice@home.example` → `home.example`) as FEDERATION.md §1.4 says: the
   * well-known, then the `_tavrn._tcp` SRV record, then `https://<domain>/api/v1`. Runs in the shell (a browser cannot
   * query DNS, and before the first sign-in there is no node to ask). Fails with a {@link ResolveFailure}.
   */
  resolve?(domain: string): Promise<ResolvedNode>;
}

export interface NodeDetails {
  domain?: string | null;
  web?: string | null;
}

/** A node found for an identity domain (the shell's `resolve_node`). */
export interface ResolvedNode {
  domain: string;
  api: string;
  ws: string;
  web: string;
  /** The step that found it. */
  source: "well_known" | "srv" | "domain";
}

/** Why `resolve_node` found no node: the code (`resolve.not_found`, `.invalid`, `.unreachable`, `.domain_invalid`) and the failed step. */
export interface ResolveFailure {
  code: string;
  step: "input" | "well_known" | "srv" | "direct";
  domain: string;
}

export type NodePageMode = "login" | "register";

/** A sign-in on the home node's own web client. */
export interface NodePageSignIn {
  /** API client of the home node (no session). */
  api: TavrnApi;
  /** The home node. */
  endpoints: NodeEndpoints;
  /** App path to continue with (browser: after the redirect back). */
  next: string;
  /** Desktop: open the page's registration. */
  mode?: NodePageMode;
  /** The account the user named, if any (its device in this client is continued). */
  address?: string;
  /** Desktop: a proof of this app's device of the account (the exchange continues that device). */
  device?: () => Promise<DeviceProof | null>;
  /** Desktop: cancels the wait. */
  signal?: AbortSignal;
  /** Desktop: the page's URL once it is open ("open in the browser instead"). */
  onPage?: (url: string) => void;
}

export interface PlatformAuth {
  /**
   * Browser: the connect flow with this origin (FEDERATION.md §8 step 3: redirect to `<web>/connect`, back at
   * `/connect/callback`); the promise never settles because the page leaves. Desktop: an app session (`connect.app`),
   * the page in a window of the shell without any native API, polling and the exchange with the PKCE verifier; the
   * session of the new device, or null when cancelled.
   */
  signInOnNodePage(req: NodePageSignIn): Promise<AuthResponse | null>;
  /** Desktop: shows the page of a running sign-in again (the user closed its window). */
  reopen?(url: string): Promise<void>;
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
 * System-wide hotkeys of the desktop app (issue #36). The shell validates a binding (`Ctrl+Alt+Shift+Super+<code>`,
 * a key alone, a modifier alone), refuses one that another action uses and observes the bound keys with a system-wide
 * key listener (never a grab: other programs still get them); the client keeps the bindings in its voice settings
 * and registers them at start.
 */
export interface PlatformHotkeys {
  /**
   * Binds `combo` to `action`; resolves to its canonical spelling, rejects with a `hotkey.*` code
   * (`hotkey.unavailable`: kept, but this system has no key listener).
   */
  register(action: HotkeyAction, combo: string): Promise<string>;
  /** Removes the binding of `action`. */
  unregister(action: HotkeyAction): Promise<void>;
  /** Presses and releases of the bound actions; returns the unsubscriber. */
  subscribe(handler: (event: HotkeyEvent) => void): () => void;
  /**
   * Signed in or out: the key listener runs only while signed in and bindings exist. Resolves whether it runs now,
   * rejects with `hotkey.unavailable` when it should but cannot.
   */
  setEnabled(enabled: boolean): Promise<boolean>;
}

/* Extension points: their members are defined by the steps that implement them. */
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
