// SPDX-License-Identifier: Apache-2.0
/**
 * The two voice engines behind one interface (docs/DESKTOP.md "Voice"):
 *
 * - the browser engine (`session.ts`): livekit-client in the page, end-to-end encrypted with insertable streams;
 *   browsers, and the desktop app on Windows (WebView2) by default;
 * - the native engine (`nativeSession.ts`): the desktop app's shell joins the room with LiveKit's Rust SDK
 *   (`platform().voice`); always on Linux, where the webview has no WebRTC, and on Windows with the setting "Native
 *   voice engine (experimental)".
 *
 * Both run the same session logic around the media (MLS group and frame keys, node routes, mute and deafen, volumes,
 * cues, rejoin) and expose the same functions, so `index.ts` picks one per call. No LiveKit import here.
 */
import { create } from "zustand";
import { platform, type NativeVoiceConfig } from "../platform";
import { gateThreshold, useVoiceSettings, type VoiceSettings } from "./settings";
import type { VoiceTarget } from "./store";
import type { PlayableSound, ScreenShareOptions } from "./session";

export type EngineKind = "browser" | "native";

/** What `index.ts` calls on the engine of a call (the exports of `session.ts` and `nativeSession.ts`). */
export interface VoiceEngine {
  join(target: VoiceTarget, opts: { canCreate: boolean; start?: boolean }): Promise<void>;
  leave(): Promise<void>;
  followMove(domain: string, data: { room_id: string; from_channel_id: string; channel_id: string }): Promise<boolean>;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  setScreenShare(on: boolean, opts?: ScreenShareOptions): Promise<void>;
  playSound(sound: PlayableSound): Promise<void>;
  setPriority(on: boolean): Promise<void>;
  pushToTalk(pressed: boolean): void;
  /** Browser-only selective whisper; invoked synchronously at hold intent. */
  setWhisper?(recipients: string[]): Promise<void>;
  attachVideo(identity: string, source: "camera" | "screen", el: HTMLVideoElement): () => void;
  /** Joins the stream (screen share) of `identity`: only joined streams are received (`streams.ts`). */
  joinStream(identity: string): void;
  /** Leaves it again. */
  leaveStream(identity: string): void;
}

export interface EngineEnv {
  /** The desktop app (not a browser). */
  desktop: boolean;
  /** The shell's operating system (`linux`, `windows`, `macos`), null when unknown. */
  os: string | null;
  /** This build of the app has the native engine. */
  available: boolean;
  /** The setting "Native voice engine (experimental)" (Windows). */
  setting: boolean;
}

/** Which engine a call uses: Linux desktop always native, Windows with the setting, everything else the browser's. */
export function chooseEngine(env: EngineEnv): EngineKind {
  if (!env.desktop || !env.available) return "browser";
  if (env.os === "linux") return "native";
  if (env.os === "windows" && env.setting) return "native";
  return "browser";
}

/** The engine choice for the UI: the kind of the current (or next) call, and whether the Windows setting applies. */
export interface EngineState {
  kind: EngineKind;
  os: string | null;
  available: boolean;
}

export const useVoiceEngine = create<EngineState>(() => ({ kind: "browser", os: null, available: false }));

let info: Promise<{ available: boolean; os: string | null }> | null = null;

/** The shell's answer about the native engine (once; the browser has none). */
export function nativeInfo(): Promise<{ available: boolean; os: string | null }> {
  const voice = platform().voice;
  if (!voice) return Promise.resolve({ available: false, os: null });
  info ??= voice.info().then(
    (i) => {
      useVoiceEngine.setState({ os: i.os, available: i.available });
      return { available: i.available, os: i.os };
    },
    () => ({ available: false, os: null }),
  );
  return info;
}

/** The engine for the next call on this platform with the current settings. */
export async function currentEngineKind(): Promise<EngineKind> {
  const p = platform();
  if (!p.isDesktop || !p.voice) return "browser";
  const i = await nativeInfo();
  return chooseEngine({ desktop: true, os: i.os, available: i.available, setting: useVoiceSettings.getState().settings.nativeEngine });
}

/** Whether the Windows setting is offered: the desktop app on Windows with the engine in its build. */
export function nativeSettingOffered(s: Pick<EngineState, "os" | "available">): boolean {
  return s.available && s.os === "windows";
}

/**
 * The voice settings for the native engine: its own devices, the browser's processing switches mapped to WebRTC's
 * audio processing (RNNoise is the browser engine's; the native one uses WebRTC's noise suppression), the gate as
 * `gateThreshold` decides it. Music mode (VOICE.md §4a) captures without processing, as in the browser engine.
 */
export function nativeConfig(s: VoiceSettings, music = false): NativeVoiceConfig {
  return {
    inputDevice: s.nativeInputDeviceId || null,
    outputDevice: s.nativeOutputDeviceId || null,
    inputVolume: s.inputVolume,
    echoCancellation: !music && s.echoCancellation,
    noiseSuppression: !music && s.noiseSuppression !== "off",
    autoGain: !music && s.autoGain,
    ptt: s.inputMode === "ptt",
    threshold: gateThreshold(s),
    holdMs: s.inputMode === "ptt" ? 0 : 300,
    pttReleaseMs: s.pttReleaseMs,
  };
}

/** Tests: forget the shell's answer. */
export function resetEngineForTests(): void {
  info = null;
  useVoiceEngine.setState({ kind: "browser", os: null, available: false });
}
