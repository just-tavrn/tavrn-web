// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point of the voice client for the rest of the app. Everything heavy (LiveKit, the E2EE worker,
 * RNNoise, background effects) sits behind dynamic imports and is loaded on the first join, so the text
 * client stays light (design note 9e).
 */
import { useToasts } from "../stores/toasts";
import { voiceErrorMessage } from "./errors";
import { useVoice, type VoiceTarget } from "./store";
import type { ScreenShareOptions } from "./session";

type SessionModule = typeof import("./session");

let module: SessionModule | null = null;
let loading: Promise<SessionModule> | null = null;

export function loadSession(): Promise<SessionModule> {
  loading ??= import("./session").then((m) => (module = m));
  return loading;
}

/** The session module if it is loaded already (video tiles attach through it). */
export function loadedSession(): SessionModule | null {
  return module;
}

const warn = (e: unknown) => useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });

/** Joins a voice channel; failures end up as a toast and in `useVoice().error`. */
export async function joinVoice(target: VoiceTarget, opts: { canCreate: boolean; start?: boolean }): Promise<boolean> {
  try {
    await (await loadSession()).join(target, opts);
    return true;
  } catch (e) {
    warn(e);
    return false;
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
  await (await loadSession()).setCamera(!useVoice.getState().camera);
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

export function pushToTalk(pressed: boolean): void {
  module?.pushToTalk(pressed);
}

/** Priority speaker on/off (the toggle for touch devices; the key is handled by the session). */
export function setPrioritySpeaker(on: boolean): void {
  void module?.setPriority(on);
}

/** `voice.move` from the room's node (VOICE.md §7). */
export function followMove(domain: string, data: { room_id: string; from_channel_id: string; channel_id: string }): void {
  if (module) void module.followMove(domain, data);
}

export type { VoiceTarget, ScreenShareOptions };
