// SPDX-License-Identifier: Apache-2.0
/**
 * The soundboard signal (design note 4.13 item 3, VOICE.md §8): when a clip starts, the player's client sends
 * `soundboard.play { sound_id, emoji?, duration_ms }` over LiveKit's data channel (reliable, end-to-end
 * encrypted like the media); receivers show the clip's emoji on the sender's tile while it plays. The audio
 * itself still travels in the microphone track. Everything received is untrusted: size-capped, validated,
 * rate-limited per sender. Light module: no LiveKit import.
 */

export const SOUND_TOPIC = "tavrn.soundboard";
/** Clip limits of the node (VOICE.md §8): 1–5000 ms. */
export const MAX_CLIP_MS = 5000;
/** Larger packets are dropped unread. */
export const MAX_SIGNAL_BYTES = 512;
/** At most this many signals per sender and window (a clip button mashed or a hostile client). */
export const SIGNAL_LIMIT = { max: 5, windowMs: 10_000 };

export interface SoundSignal {
  type: "soundboard.play";
  sound_id: string;
  /** The node hosting the clip when it is not the voice channel's (design note 4.13): fetched through `?host=`. */
  host?: string;
  emoji?: string;
  duration_ms: number;
}

/** A node domain in a signal (lowercase labels, optional port). */
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

const clampDuration = (ms: number) => Math.min(MAX_CLIP_MS, Math.max(1, Math.round(ms)));

export function encodeSoundSignal(sound: { id: string; emoji?: string | null; host?: string | null }, durationMs: number): Uint8Array<ArrayBuffer> {
  const signal: SoundSignal = { type: "soundboard.play", sound_id: sound.id, duration_ms: clampDuration(durationMs) };
  if (sound.host && HOST.test(sound.host) && sound.host.length <= 259) signal.host = sound.host;
  if (sound.emoji && parseClipEmoji(sound.emoji)) signal.emoji = sound.emoji;
  return new TextEncoder().encode(JSON.stringify(signal));
}

/** A received packet, or null if it is not a valid `soundboard.play`. */
export function parseSoundSignal(data: Uint8Array): SoundSignal | null {
  if (data.byteLength === 0 || data.byteLength > MAX_SIGNAL_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "soundboard.play") return null;
  if (typeof r.sound_id !== "string" || !/^[0-9A-Za-z]{1,64}$/.test(r.sound_id)) return null;
  if (typeof r.duration_ms !== "number" || !Number.isFinite(r.duration_ms)) return null;
  const out: SoundSignal = { type: "soundboard.play", sound_id: r.sound_id, duration_ms: clampDuration(r.duration_ms) };
  if (typeof r.host === "string" && r.host.length <= 259 && HOST.test(r.host)) out.host = r.host;
  if (typeof r.emoji === "string" && parseClipEmoji(r.emoji)) out.emoji = r.emoji;
  return out;
}

export type ClipEmoji = { kind: "unicode"; text: string } | { kind: "custom"; name: string; id: string | null; node: string | null };

const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const UNICODE_EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]+$/u;
/** `<:name:id>`, `<a:name:id>` or `<:name:id@node>` (PROTOCOL.md custom emoji token), or `:name:`. */
const CUSTOM_TOKEN = /^<a?:([A-Za-z0-9_-]{1,32}):([0-9A-Za-z]{1,64})(?:@([a-z0-9.-]{1,253}(?::\d{1,5})?))?>$/;
const CUSTOM_NAME = /^:([A-Za-z0-9_-]{1,32}):$/;

/** The clip's `emoji`: a Unicode emoji (one grapheme cluster, short) or a custom emoji token; else null. */
export function parseClipEmoji(s: string): ClipEmoji | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 300) return null;
  const token = CUSTOM_TOKEN.exec(s);
  if (token) return { kind: "custom", name: token[1]!, id: token[2]!, node: token[3] ?? null };
  const name = CUSTOM_NAME.exec(s);
  if (name) return { kind: "custom", name: name[1]!, id: null, node: null };
  if (s.length <= 32 && UNICODE_EMOJI.test(s) && PICTOGRAPH.test(s)) return { kind: "unicode", text: s };
  return null;
}

/** Sliding-window limit per key (sender identity, or the own device). */
export class SignalLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly max = SIGNAL_LIMIT.max,
    private readonly windowMs = SIGNAL_LIMIT.windowMs,
  ) {}

  allow(key: string, now: number): boolean {
    const list = (this.seen.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.seen.set(key, list);
      return false;
    }
    list.push(now);
    this.seen.set(key, list);
    return true;
  }

  forget(key: string): void {
    this.seen.delete(key);
  }
}
