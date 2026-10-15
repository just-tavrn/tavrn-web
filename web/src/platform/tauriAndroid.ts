// SPDX-License-Identifier: Apache-2.0
/**
 * The Android app (docs/ANDROID.md): the Tauri shell on Android with its Kotlin side, reached through the shell's
 * `android_*` commands (`src-tauri/src/android.rs`). Its members: the Android pieces (permissions, the back gesture,
 * app links, the system bars, push through UnifiedPush, the connection service), native notifications, and the voice
 * notification behind the tray interface (the voice store drives it like the desktop's tray). Loaded with `tauri.ts`
 * when the shell reports `android`; nothing here runs in a browser or on the desktop.
 */
import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { asBlob, type SaveFile } from "./files";
import { withKeyNumbers } from "./keyBytes";
import type { ShellEvents } from "./shellEvents";
import { updateFailure } from "./updateErrors";
import { notificationOpens, trayActions } from "./tauriShell";
import { nativePasskeys } from "./tauriPasskeys";
import { createAndroidUnlock } from "./unlock";
import type {
  AppUpdater,
  AndroidInsets,
  AndroidScreenEvent,
  AndroidScreenShare,
  AndroidScreenStopReason,
  AndroidStatus,
  AudioRoutes,
  PlatformAndroid,
  PlatformNotifications,
  PlatformPasskeys,
  PlatformTray,
  PlatformUnlock,
  PushEndpointKeys,
  TrayVoiceExtra,
  TrayLabels,
  TrayVoiceState,
} from "./types";

/** The shell's `android_info` (snake case). */
interface RawStatus {
  sdk: number;
  webauthn: boolean;
  /** Older shells send nothing. */
  passkeys?: boolean;
  origin?: string | null;
  distributors: string[];
  distributor: string | null;
  notifications: AndroidStatus["notifications"];
  battery_exempt: boolean;
  keep_connection: boolean;
  insets: AndroidInsets;
}

const NO_INSETS: AndroidInsets = { top: 0, right: 0, bottom: 0, left: 0, keyboard: 0 };

function status(raw: RawStatus): AndroidStatus {
  return {
    sdk: raw.sdk,
    webauthn: raw.webauthn,
    passkeys: raw.passkeys ?? false,
    origin: raw.origin ?? null,
    distributors: raw.distributors ?? [],
    distributor: raw.distributor ?? null,
    notifications: raw.notifications,
    batteryExempt: raw.battery_exempt,
    keepConnection: raw.keep_connection,
    insets: raw.insets ?? NO_INSETS,
  };
}

/** The voice notification: what the tray shows on the desktop, as a notice for the Android voice service. */
export function voiceNotice(state: TrayVoiceState, labels: TrayLabels, extra: TrayVoiceExtra | undefined) {
  return {
    // Speaking flickers many times a second: the notification shows "connected" for it.
    state: state === "speaking" ? "connected" : state,
    title: extra?.title ?? labels.tooltip,
    text: extra?.text ?? labels.tooltip,
    mute: labels.mute,
    unmute: extra?.unmute ?? labels.mute,
    leave: labels.leave,
    camera: extra?.camera ?? false,
  };
}

/** A newer release with an APK (`src-tauri/src/release.rs`). */
interface Release {
  version: string;
  notes: string | null;
  url: string;
}

/** The shell's IPC (tests pass a fake). */
export type ShellCall = (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;

/**
 * Downloads (docs/ANDROID.md "Downloads"): Android's document picker instead of the desktop's save dialog, the same
 * streaming in chunks (`android_save_*`), base64 in pieces of 1 MiB (Android's IPC carries JSON only); the picker
 * names no folder, so the outcome carries none and no "show in folder".
 */
export const ANDROID_SAVE_CHUNK_BYTES = 1024 * 1024;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function createAndroidSaveFile(call: ShellCall = invoke): SaveFile {
  return async (file) => {
    const blob = asBlob(file);
    const mime = file.mime || blob.type || "application/octet-stream";
    const begin = (await call("android_save_begin", { name: file.name, mime, size: blob.size })) as { status: "ready"; id: string } | { status: "cancelled" };
    if (begin.status !== "ready") return { status: "cancelled" };
    const { id } = begin;
    try {
      for (let offset = 0; offset < blob.size; offset += ANDROID_SAVE_CHUNK_BYTES) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + ANDROID_SAVE_CHUNK_BYTES).arrayBuffer());
        await call("android_save_chunk", { id, data: base64(bytes) });
      }
      const saved = (await call("android_save_end", { id })) as { name: string };
      return { status: "saved", name: saved.name || file.name, path: "", folder: "" };
    } catch (e) {
      await call("android_save_abort", { id }).catch(() => {});
      throw e;
    }
  };
}

const STOP_REASONS: readonly AndroidScreenStopReason[] = ["stopped", "notification", "revoked", "failed"];

/**
 * Screen sharing through the shell (docs/ANDROID.md "Screen sharing", `ScreenShare.kt`): the screen publisher's token
 * and this device's frame key go to the native side, which asks Android's consent and publishes the screen. The key
 * crosses the local bridge only (as 32 numbers, checked by the shell); the shell's answers are error codes.
 */
export function androidScreenShare(events: ShellEvents, sdk: number, call: ShellCall = invoke): AndroidScreenShare {
  return {
    // AudioPlaybackCapture: Android 10 and newer.
    audio: sdk >= 29,
    start: async (a) => {
      await withKeyNumbers(a.key, (key) =>
        call("android_screen_share_start", {
          share: { url: a.url, token: a.token, key, epoch: a.epoch, max_side: a.maxSide, fps: a.fps, max_bitrate: a.maxBitrate, audio: a.audio, title: a.notice.title, text: a.notice.text, stop: a.notice.stop },
        }),
      );
    },
    setKey: async (key, epoch) => {
      await withKeyNumbers(key, (numbers) => call("android_screen_share_key", { key: numbers, epoch }));
    },
    stop: async () => {
      await call("android_screen_share_stop");
    },
    onEvent: (fn) =>
      events.on((e) => {
        if (e.kind !== "screen_share") return;
        const event: AndroidScreenEvent | null = e.state === "live" ? { state: "live" } : e.state === "stopped" ? { state: "stopped", reason: e.reason && STOP_REASONS.includes(e.reason) ? e.reason : "stopped" } : null;
        if (event) fn(event);
      }),
  };
}

export interface AndroidMembers {
  saveFile: SaveFile;
  updater: AppUpdater;
  android: PlatformAndroid;
  notifications: PlatformNotifications;
  tray: PlatformTray;
  /** Passkeys through Android's Credential Manager (Android 14+), the same commands as the Windows app's. */
  passkeys?: PlatformPasskeys;
  /** Unlock with fingerprint, face or PIN (Android 11+; older systems answer `unsupported`). */
  unlock: PlatformUnlock;
}

/** The Android members; `initial` is the shell's `android_info` at start. */
export function androidMembers(events: ShellEvents, initial: AndroidStatus): AndroidMembers {
  let insets = initial.insets;
  const on = <T>(pick: (event: Parameters<Parameters<ShellEvents["on"]>[0]>[0]) => T | undefined, fn: (value: T) => void) =>
    events.on((event) => {
      const value = pick(event);
      if (value !== undefined) fn(value);
    });
  // The latest insets, also without a listener.
  on((e) => (e.kind === "insets" ? e : undefined), (e) => (insets = { top: e.top, right: e.right, bottom: e.bottom, left: e.left, keyboard: e.keyboard }));

  const android: PlatformAndroid = {
    sdk: initial.sdk,
    webauthn: initial.webauthn,
    passkeys: initial.passkeys,
    origin: initial.origin,
    status: async () => status(await invoke<RawStatus>("android_info")),
    requestPermission: (permission) => invoke("android_permission", { permission }),
    openSettings: (page) => invoke<void>("android_open_settings", { page }),
    requestBatteryExemption: () => invoke<boolean>("android_battery_exemption"),
    background: () => invoke<void>("android_background"),
    onBack: (fn) => on((e) => (e.kind === "back" ? true : undefined), () => fn()),
    onInsets: (fn) => on((e) => (e.kind === "insets" ? insets : undefined), fn),
    insets: () => insets,
    push: {
      register: (vapid, distributor) => invoke<PushEndpointKeys>("android_push_register", { vapid, distributor: distributor ?? null }),
      unregister: () => invoke<void>("android_push_unregister"),
      configure: (strings, homeNode) => invoke<void>("android_push_config", { config: { strings, home_node: homeNode } }),
      onEndpoint: (fn) => on((e) => (e.kind === "push_endpoint" ? { endpoint: e.endpoint, p256dh: e.p256dh, auth: e.auth } : undefined), fn),
      onUnregistered: (fn) => on((e) => (e.kind === "push_unregistered" ? true : undefined), () => fn()),
    },
    keepConnection: (on, texts) => invoke<void>("android_keep_connection", { on, title: texts.title, text: texts.text }),
    audio: {
      routes: () => invoke<AudioRoutes>("android_audio_routes"),
      setRoute: (route) => invoke<AudioRoutes>("android_audio_route", { route }),
      onRoutes: (fn) => on((e) => (e.kind === "audio_routes" ? { available: e.available ?? [], current: e.current ?? null } : undefined), fn),
    },
    lockOrientation: (orientation) => invoke<void>("android_orientation", { lock: orientation }),
    screenShare: androidScreenShare(events, initial.sdk),
  };

  const notifications: PlatformNotifications = {
    show: (notice) => invoke<void>("notify", { notice }),
    onOpen: (fn) => notificationOpens(events, fn),
  };

  // The voice notification follows the tray's state; only real changes reach the shell (speaking does not).
  let last = "";
  const tray: PlatformTray = {
    set: async (state, labels, extra) => {
      const notice = voiceNotice(state, labels, extra);
      const key = JSON.stringify(notice);
      if (key === last) return;
      last = key;
      await invoke<void>("android_voice", { notice });
    },
    onAction: (fn) => trayActions(events, fn),
    status: async () => ({ state: "disconnected", tooltip: "", available: false, closeToTray: false }),
    setCloseToTray: async () => undefined,
    quit: () => invoke<void>("android_background"),
  };

  // Tauri's updater has no Android support: the shell reads the release list, the browser downloads the APK and
  // Android installs it over the app (the same signing key).
  const updater: AppUpdater = {
    check: async () => {
      const found = await invoke<Release | null>("android_check_update").catch(updateFailure);
      if (!found) return null;
      return { version: found.version, notes: found.notes, install: () => invoke<void>("open_external", { url: found.url }) };
    },
    // The same setting as the desktop's (`get_update_channel`, `set_update_channel`): beta offers pre-releases too.
    channel: {
      get: () => invoke<"stable" | "beta">("get_update_channel").catch(updateFailure),
      set: (channel) => invoke<void>("set_update_channel", { channel }).catch(updateFailure),
    },
  };

  return { saveFile: createAndroidSaveFile(), updater, android, notifications, tray, unlock: createAndroidUnlock(), ...(initial.passkeys ? { passkeys: nativePasskeys() } : {}) };
}

/** The shell's `android_info` at start. */
export async function androidStatus(): Promise<AndroidStatus> {
  return status(await invoke<RawStatus>("android_info"));
}
