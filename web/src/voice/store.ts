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
  screen: boolean;
  /** Microphone track muted (LiveKit's view; the node's `muted` flag is reported by the client). */
  micMuted: boolean;
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
  backgroundAutoOff: null,
  prioritySelf: false,
  priority: {},
};

export const useVoice = create<VoiceState>(() => IDLE);

/** Speaking level (0…1, 0 = silent) per identity of the own call. */
export const useSpeaking = create<{ levels: Record<string, number> }>(() => ({ levels: {} }));

/**
 * The soundboard clip playing per identity of the own call (design note 4.13 item 3): its emoji is shown on
 * the sender's tile for the clip's duration. `key` changes with every clip (restarts the animation).
 */
export const useSoundOverlays = create<{ overlays: Record<string, { emoji: string; key: number }> }>(() => ({ overlays: {} }));

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
