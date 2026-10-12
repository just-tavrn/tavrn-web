// SPDX-License-Identifier: Apache-2.0
/**
 * UI state of the own voice connection (one per device, VOICE.md §1) and the speaking levels of the
 * call. Light: no LiveKit import, the session (`session.ts`) is loaded on the first join and writes
 * here. Speaking levels are batched to at most ~10 updates per second (design note 4.5 item 6); the UI turns
 * them into a CSS `--level` variable, so nothing animates per frame in JavaScript.
 */
import { create } from "zustand";
import type { VoiceLimits } from "@tavrn/sdk";
import type { SlowFrames } from "./frames";

export type VoiceStatus = "idle" | "joining" | "connected" | "reconnecting";
export type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";

export interface VoiceTarget {
  /** Domain of the node hosting the room or the conversation (home node included). */
  domain: string;
  /** The room of a voice channel; empty for calls. */
  roomId: string;
  /** The voice channel, or for calls the conversation (its MLS group keys the call either way). */
  channelId: string;
  /** A call in a DM or group DM (VOICE.md §11) instead of a voice channel. */
  call?: boolean;
}

/** What a participant publishes as LiveKit reports it (identity = `<address>/<device>`). */
export interface ParticipantMedia {
  camera: boolean;
  /** Shares the screen (a remote share counts before this viewer joined it: the stream tile offers joining). */
  screen: boolean;
  /** The screen share's video is here to show: the own share, or a joined stream whose track arrived. */
  screenVideo?: boolean;
  /** Microphone track muted (LiveKit's view; the node's `muted` flag is reported by the client). */
  micMuted: boolean;
  /** The screen share carries audio (its own volume, issue #20). */
  screenAudio?: boolean;
}

export interface VoiceState {
  status: VoiceStatus;
  target: VoiceTarget | null;
  /** This device's LiveKit identity. */
  identity: string | null;
  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  camera: boolean;
  screen: boolean;
  /**
   * The Android app's screen share through the shell (VOICE.md §4b, `nativeScreen.ts`): `starting` from the start
   * until it is live (Android's consent dialog, the connection), then `live`; null otherwise. `screen` stays the
   * webview's own share.
   */
  nativeScreen: "starting" | "live" | null;
  /** May publish the microphone (`speak`, not server-muted). */
  canSpeak: boolean;
  limits: VoiceLimits | null;
  quality: Quality;
  /** LiveKit's connection quality of every participant of the call (own identity included). */
  qualities: Record<string, Quality>;
  /** LiveKit confirmed end-to-end encryption for this device's media. */
  e2ee: boolean;
  /** Media of everybody in the call (own entry included). */
  media: Record<string, ParticipantMedia>;
  /** The own gate lets the voice through (voice activation / push-to-talk indicator). */
  transmitting: boolean;
  /** Last error (translated). */
  error: string | null;
  /** Insertable streams are missing: voice cannot be end-to-end encrypted here (blocking warning). */
  e2eeBlocked: boolean;
  /** Screen share in focus (identity) on the stage. */
  focus: string | null;
  /**
   * The streams (screen shares) this device joined, by identity: only those are received (`streams.ts`); every
   * other share is a placeholder tile with "Join stream".
   */
  streams: Record<string, true>;
  /** The own screen share's preview tile is shown (the sharer can hide it and reopen it from the indicator). */
  selfPreview: boolean;
  /** The background effect was turned off because frames were dropped: what the detector measured. */
  backgroundAutoOff: SlowFrames | null;
  /** This device holds the priority key or toggle (and may: `priority_speaker`, design note 4.13 item 3). */
  prioritySelf: boolean;
  /** Active priority speakers of the call (identities; others only once their permission was verified). */
  priority: Record<string, true>;
}

export const IDLE: VoiceState = {
  status: "idle",
  target: null,
  identity: null,
  muted: false,
  deafened: false,
  serverMuted: false,
  camera: false,
  screen: false,
  nativeScreen: null,
  canSpeak: true,
  limits: null,
  quality: "unknown",
  qualities: {},
  e2ee: false,
  media: {},
  transmitting: false,
  error: null,
  e2eeBlocked: false,
  focus: null,
  streams: {},
  selfPreview: true,
  backgroundAutoOff: null,
  prioritySelf: false,
  priority: {},
};

export const useVoice = create<VoiceState>(() => IDLE);

/**
 * The voice channel of room `roomId` on `domain` this device's voice session is in (joining, connected or
 * reconnecting), or null: `channelPermissions` grants view, read and connect there (a moderator may move a member
 * into a channel they may not view, VOICE.md §7).
 */
export function ownVoiceChannel(s: VoiceState, domain: string, roomId: string): string | null {
  return s.status !== "idle" && s.target && !s.target.call && s.target.domain === domain && s.target.roomId === roomId ? s.target.channelId : null;
}

/** Speaking level (0…1, 0 = silent) per identity of the own call. */
export const useSpeaking = create<{ levels: Record<string, number> }>(() => ({ levels: {} }));

/**
 * The soundboard clip playing per identity of the own call (design note 4.13 item 3): its emoji is shown on
 * the sender's tile for the clip's duration. `key` changes with every clip (restarts the animation).
 */
export const useSoundOverlays = create<{ overlays: Record<string, { emoji: string; key: number }> }>(() => ({ overlays: {} }));

/**
 * Streams (screen shares) on screen, counted per identity (issue #20): a stream tile registers while it is
 * mounted. A watched stream stays audible while the user is deafened (`volume.ts`).
 */
export const useWatchedStreams = create<{ watching: Record<string, number> }>(() => ({ watching: {} }));

export const isWatched = (s: { watching: Record<string, number> }, identity: string): boolean => (s.watching[identity] ?? 0) > 0;

/** Marks the stream of `identity` as watched; the returned function releases it (once). */
export function watchStream(identity: string): () => void {
  const change = (by: number) =>
    useWatchedStreams.setState((s) => {
      const watching = { ...s.watching };
      const n = (watching[identity] ?? 0) + by;
      if (n > 0) watching[identity] = n;
      else delete watching[identity];
      return { watching };
    });
  change(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    change(-1);
  };
}

/** Levels below this count as silence (LiveKit's audio levels are 0…1). */
const SILENT = 0.01;

/**
 * Collects level changes and writes them to the store at most every `intervalMs`, and only when
 * something visibly changed (levels are rounded to 0.05 steps). Leading edge: after a quiet interval a
 * change is written at once (somebody starting to talk lights up without waiting for the batch), later
 * changes within the interval are batched.
 */
export class SpeakingBatcher {
  private pending: Record<string, number> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs = 100) {}

  /** The complete set of current speakers (everybody else is silent). */
  speakers(levels: Record<string, number>): void {
    const next: Record<string, number> = {};
    for (const [identity, level] of Object.entries(levels)) if (level > SILENT) next[identity] = Math.min(1, Math.round(level * 20) / 20 || 0.05);
    this.pending = next;
    if (this.timer) return;
    const wait = this.lastWrite + this.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.pending;
    this.pending = null;
    if (!next) return;
    this.lastWrite = Date.now();
    const current = useSpeaking.getState().levels;
    const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([k, v]) => current[k] === v);
    if (!same) useSpeaking.setState({ levels: next });
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.lastWrite = Number.NEGATIVE_INFINITY;
    useSpeaking.setState({ levels: {} });
  }
}
