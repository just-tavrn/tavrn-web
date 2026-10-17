// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point of the voice client for the rest of the app. Everything heavy (LiveKit, the E2EE worker,
 * RNNoise, background effects) sits behind dynamic imports and is loaded on the first join, so the text
 * client stays light (design note 9e).
 */
import { previewing } from "../stores/rolePreview";
import { toastPreviewRefused } from "../lib/previewGuard";
import { useToasts } from "../stores/toasts";
import { voiceErrorMessage } from "./errors";
import { useVoice, type VoiceTarget } from "./store";
import { currentEngineKind, useVoiceEngine, type EngineKind, type VoiceEngine } from "./engine";
import type { ScreenShareOptions } from "./session";
import { prepareAndroidMedia } from "./androidMedia";
import { beginJoinTimings, finishJoinTimings, vjMark } from "./joinTimings";

/** Both engines export the same functions (`engine.ts`). */
type SessionModule = VoiceEngine;

let loaded: { kind: EngineKind; module: SessionModule } | null = null;
let module: SessionModule | null = null;

const engines: Record<EngineKind, () => Promise<SessionModule>> = {
  browser: () => import("./session"),
  native: () => import("./nativeSession"),
};

/**
 * The engine of the call (`engine.ts`): a running call keeps its engine; otherwise the platform and the settings
 * decide (the browser engine everywhere but the desktop app on Linux, or on Windows with the setting).
 */
export async function loadSession(): Promise<SessionModule> {
  if (loaded && useVoice.getState().status !== "idle") return loaded.module;
  const kind = await currentEngineKind();
  if (loaded?.kind !== kind) {
    const m = await engines[kind]();
    loaded = { kind, module: m };
  }
  module = loaded.module;
  if (useVoiceEngine.getState().kind !== kind) useVoiceEngine.setState({ kind });
  return loaded.module;
}

/** The session module if it is loaded already (video tiles attach through it). */
export function loadedSession(): SessionModule | null {
  return module;
}

const warn = (e: unknown) => useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });

/** Joins a voice channel; failures end up as a toast and in `useVoice().error`. */
export async function joinVoice(target: VoiceTarget, opts: { canCreate: boolean; start?: boolean }): Promise<boolean> {
  // The role preview (docs/CLIENT.md) never joins: that would be the viewer's real participation.
  if (previewing()) {
    toastPreviewRefused();
    return false;
  }
  // Join timings (docs/CLIENT.md "Voice troubleshooting"): only with the debug flag on.
  beginJoinTimings({ channel: target.channelId });
  try {
    // The session module loads while Android asks for the microphone (right before the first use, docs/ANDROID.md
    // "Permissions"); headsets and notifications are asked after it without holding the join (`androidMedia.ts`).
    const loading = loadSession();
    loading.catch(() => undefined);
    await prepareAndroidMedia("microphone");
    vjMark("android_media");
    const session = await loading;
    vjMark("session_module");
    await session.join(target, opts);
    vjMark("join_resolved");
    return true;
  } catch (e) {
    warn(e);
    return false;
  } finally {
    void finishJoinTimings();
  }
}

export async function leaveVoice(): Promise<void> {
  if (!module && useVoice.getState().status === "idle") return;
  await (await loadSession()).leave();
}

export async function toggleMute(): Promise<void> {
  await (await loadSession()).setMuted(!useVoice.getState().muted);
}

export async function toggleDeafen(): Promise<void> {
  await (await loadSession()).setDeafened(!useVoice.getState().deafened);
}

export async function toggleCamera(): Promise<void> {
  const on = !useVoice.getState().camera;
  if (on) await prepareAndroidMedia("camera");
  await (await loadSession()).setCamera(on);
}

export async function startScreenShare(opts: ScreenShareOptions): Promise<void> {
  await (await loadSession()).setScreenShare(true, opts);
}

export async function stopScreenShare(): Promise<void> {
  await (await loadSession()).setScreenShare(false);
}

export async function playSound(sound: import("./session").PlayableSound): Promise<void> {
  try {
    await (await loadSession()).playSound(sound);
  } catch (e) {
    warn(e);
  }
}

/** Joins the stream (screen share) of a participant of the own call (`streams.ts`: screen shares are opt-in). */
export function joinStream(identity: string): void {
  module?.joinStream(identity);
}

/** Leaves that stream again (its tile goes back to "Join stream"). */
export function leaveStream(identity: string): void {
  module?.leaveStream(identity);
}

export function pushToTalk(pressed: boolean): void {
  module?.pushToTalk(pressed);
}

/** Priority speaker on/off (the toggle for touch devices; the key is handled by the session). */
export function setPrioritySpeaker(on: boolean): void {
  void module?.setPriority(on);
}

/** `voice.move` from the room's node (VOICE.md §7); `true` once the call is in the target channel. */
export async function followMove(domain: string, data: { room_id: string; from_channel_id: string; channel_id: string }): Promise<boolean> {
  return module ? module.followMove(domain, data) : false;
}

export type { VoiceTarget, ScreenShareOptions };
