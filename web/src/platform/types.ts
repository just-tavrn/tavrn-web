// SPDX-License-Identifier: Apache-2.0
/**
 * The platform the client runs on: a browser tab served by a node, or one of the apps that bundle the client and talk
 * to the node the user picked: the desktop app (Tauri or Electron shell, docs/DESKTOP.md) or the Android app (the
 * Tauri shell on Android, docs/ANDROID.md).
 *
 * The interface is deliberately small. The optional members at the end are extension points of the
 * desktop app: they stay absent in the browser and are filled by the shell's later steps (global
 * hotkeys, OS keychain, native notifications, tray). Code that uses them checks for presence.
 */
import type { AuthResponse, DeviceProof, NodeEndpoints, TavrnApi } from "@tavrn/sdk";
import type { UnlockMaterial } from "../crypto/sealedUnlock";
import type { SaveFile } from "./files";

export type PlatformKind = "browser" | "desktop" | "android";

export interface Platform {
  readonly kind: PlatformKind;
  /**
   * One of the apps (desktop or Android): the client is bundled, its node is the one the user picked, the node's own
   * pages (passkeys, single sign-on, the captcha) open in a window or the browser. Code that is about the screen
   * (a phone or a desktop) asks `kind` instead.
   */
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
  /** Saves a file the user downloads: the browser's download, the desktop app's save dialog (call sites use `saveFile.ts`). */
  readonly saveFile?: SaveFile;
  /** Desktop: the native voice engine of the shell (LiveKit's Rust SDK; `voice/nativeSession.ts`, docs/DESKTOP.md "Voice"). */
  readonly voice?: PlatformVoice;
  /** Android: permissions, the back gesture, app links, the system bars, push without Google (docs/ANDROID.md). */
  readonly android?: PlatformAndroid;
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
/** A sign-in method the node's page starts at once instead of showing its whole form. */
export type NodePageMethod = "passkey" | "sso";

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
  /** Desktop: start this method on the page at once (the user chose it in the app). */
  method?: NodePageMethod;
  /** The account the user named, if any (its device in this client is continued). */
  address?: string;
  /** Desktop: a proof of this app's device of the account (the exchange continues that device). */
  device?: () => Promise<DeviceProof | null>;
  /** Desktop: cancels the wait. */
  signal?: AbortSignal;
  /** Desktop: the page's URL once it is open ("open in the browser instead"). */
  onPage?: (url: string) => void;
}

/** A sign-in on the node's page: the session of the new device and, after a passkey ceremony, what unlocks its keys. */
export interface NodePageResult {
  session: AuthResponse;
  /** The passkey's credential id and PRF output, sealed by the page to this handoff's key (FEDERATION.md §8 step 3). */
  unlock: UnlockMaterial | null;
}

/** Passkey unlock of the signed-in app on the node's page (an unlock session). */
export interface NodePageUnlock {
  /** API client of the home node with the app's session. */
  api: TavrnApi;
  endpoints: NodeEndpoints;
  signal?: AbortSignal;
  onPage?: (url: string) => void;
}

export interface PlatformAuth {
  /**
   * Browser: the connect flow with this origin (FEDERATION.md §8 step 3: redirect to `<web>/connect`, back at
   * `/connect/callback`); the promise never settles because the page leaves. Desktop: an app session (`connect.app`),
   * the page in a window of the shell without any native API, polling and the exchange with the PKCE verifier; the
   * session of the new device (with the sealed unlock material of a passkey sign-in), or null when cancelled.
   */
  signInOnNodePage(req: NodePageSignIn): Promise<NodePageResult | null>;
  /**
   * Desktop: unlock the signed-in app's key store with a passkey on the node's page (FEDERATION.md §8 step 3, unlock
   * sessions). Rejects with `connect.unlock_unsupported` for nodes without it; null when cancelled.
   */
  unlockOnNodePage?(req: NodePageUnlock): Promise<UnlockMaterial | null>;
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

/**
 * What the Android app's voice notification shows besides the tray's texts ("In voice channel X" with Mute or Unmute
 * and Leave); the desktop's tray ignores it.
 */
export interface TrayVoiceExtra {
  /** "In voice channel Lounge (Gaming)", "In a call with Bob". */
  title: string;
  /** The state in words ("Connected", "Muted"). */
  text: string;
  unmute: string;
  /** The camera is on (the service then also holds the camera). */
  camera: boolean;
}

export interface PlatformTray {
  set(state: TrayVoiceState, labels: TrayLabels, extra?: TrayVoiceExtra): Promise<void>;
  /** A voice item of the tray menu was chosen. Returns the unsubscriber. */
  onAction(fn: (action: TrayAction) => void): () => void;
  status(): Promise<TrayStatus>;
  setCloseToTray(on: boolean): Promise<void>;
  /** Ends the app (with close to tray, closing the window does not). */
  quit(): Promise<void>;
}

/** A microphone or speaker of the native voice engine (its own ids, not the browser's). */
export interface NativeDevice {
  id: string;
  label: string;
}

/** The voice settings the native engine applies (resolved from `VoiceSettings` by the client). */
export interface NativeVoiceConfig {
  inputDevice: string | null;
  outputDevice: string | null;
  /** Percent, 0–200. */
  inputVolume: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGain: boolean;
  ptt: boolean;
  /** Gate threshold in dBFS (`gateThreshold`), null: no gate. */
  threshold: number | null;
  holdMs: number;
  pttReleaseMs: number;
}

export interface NativeVoiceJoin {
  url: string;
  token: string;
  /** The frame key of `epoch` (32 bytes, ENCRYPTION.md §5a). */
  key: Uint8Array;
  epoch: number;
  bitrateKbps: number;
  config: NativeVoiceConfig;
  muted: boolean;
  deafened: boolean;
}

export interface NativeParticipant {
  identity: string;
  mic: boolean;
  mic_muted: boolean;
  local: boolean;
}

/** What the native engine reports (the shell's `VoiceEvent`). */
export type NativeVoiceEvent =
  | { kind: "level"; level: number | null; open: boolean }
  | { kind: "ptt"; open: boolean }
  | { kind: "speakers"; levels: Array<[string, number | null]> }
  | { kind: "participants"; participants: NativeParticipant[] }
  | { kind: "permissions"; can_speak: boolean }
  | { kind: "quality"; identity: string; quality: "excellent" | "good" | "poor" | "lost" }
  | { kind: "encryption"; identity: string; state: string }
  | { kind: "reconnecting" }
  | { kind: "reconnected" }
  | { kind: "disconnected"; reason: string }
  | { kind: "error"; code: string };

/**
 * The native voice engine of the desktop app (`src-tauri/src/voice`): the shell joins the LiveKit room, captures and
 * plays the audio; the client keeps the node, the MLS keys, the settings and the UI. Every call may reject with a
 * `voice.*` code.
 */
export interface PlatformVoice {
  /** Whether this build has the engine, and the operating system (`linux`, `windows`, `macos`). */
  info(): Promise<{ available: boolean; os: string }>;
  devices(): Promise<{ inputs: NativeDevice[]; outputs: NativeDevice[] }>;
  join(args: NativeVoiceJoin, onEvent: (event: NativeVoiceEvent) => void): Promise<{ identity: string; can_speak: boolean }>;
  leave(): Promise<void>;
  /** The frame key of a newer epoch; false when the shell already has a newer one. */
  setKey(key: Uint8Array, epoch: number): Promise<boolean>;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): Promise<void>;
  setPtt(pressed: boolean): Promise<void>;
  configure(config: NativeVoiceConfig): Promise<void>;
  /** Playback gains per identity (1 = unchanged). */
  setVolumes(volumes: Record<string, number>): Promise<void>;
}

/** The system bars and the on-screen keyboard of the Android app in CSS pixels. */
export interface AndroidInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** The keyboard's height (0 when hidden); the app already shortened the page by it. */
  keyboard: number;
}

/** What the Android side reports about itself (the shell's `android_info`). */
export interface AndroidStatus {
  /** The Android API level. */
  sdk: number;
  /** The webview runs WebAuthn for the app (Android 14+). */
  webauthn: boolean;
  /** Installed UnifiedPush distributors (package names). */
  distributors: string[];
  /** The distributor in use, once one was chosen. */
  distributor: string | null;
  notifications: "granted" | "denied" | "prompt";
  batteryExempt: boolean;
  keepConnection: boolean;
  insets: AndroidInsets;
}

export type AndroidPermission = "notifications" | "bluetooth" | "microphone" | "camera";
/** `blocked`: Android no longer asks; only the system settings can grant it. */
export type PermissionAnswer = "granted" | "denied" | "blocked";
export type AndroidSettingsPage = "app" | "notifications" | "battery";

/** A UnifiedPush endpoint with its RFC 8291 keys: what the node's push API takes (PROTOCOL.md §6d). */
export interface PushEndpointKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Push without Google: UnifiedPush with WebPush (docs/ANDROID.md "Notifications without Google"). */
export interface AndroidPush {
  /** Registers at the distributor with the node's VAPID key; rejects with `push.no_distributor`, `push.timeout`, … */
  register(vapid: string, distributor?: string | null): Promise<PushEndpointKeys>;
  unregister(): Promise<void>;
  /** The texts of the native receiver (`push.sw.*`) and the account's home node. */
  configure(strings: Record<string, string>, homeNode: string | null): Promise<void>;
  /** The distributor handed a new endpoint (it must be registered at the node again). */
  onEndpoint(fn: (endpoint: PushEndpointKeys) => void): () => void;
  /** The distributor dropped the registration. */
  onUnregistered(fn: () => void): () => void;
}

/** The Android app's own pieces (`platform/tauriAndroid.ts`). */
export interface PlatformAndroid {
  /** The Android API level at start. */
  readonly sdk: number;
  /** The webview runs WebAuthn for the app (Android 14+ and a webview that supports it). */
  readonly webauthn: boolean;
  status(): Promise<AndroidStatus>;
  /** Asks for a runtime permission right before its first use. */
  requestPermission(permission: AndroidPermission): Promise<PermissionAnswer>;
  openSettings(page: AndroidSettingsPage): Promise<void>;
  /** The system dialog of the battery-optimisation exemption; whether the app is exempt afterwards. */
  requestBatteryExemption(): Promise<boolean>;
  /** Sends the app to the background (the back gesture on the first page). */
  background(): Promise<void>;
  /** The system back gesture. Returns the unsubscriber. */
  onBack(fn: () => void): () => void;
  /** An app link (`https://app.tavrn.org/invite/…`) or a `tavrn://` link opened the app; checked by the shell. */
  onLink(fn: (url: string) => void): () => void;
  /** The system bars or the keyboard changed. */
  onInsets(fn: (insets: AndroidInsets) => void): () => void;
  /** The latest insets. */
  insets(): AndroidInsets;
  push: AndroidPush;
  /** Without a distributor: keeps the app running in the background for notifications (a foreground service). */
  keepConnection(on: boolean, texts: { title: string; text: string }): Promise<void>;
}
