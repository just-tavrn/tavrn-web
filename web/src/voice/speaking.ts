// SPDX-License-Identifier: Apache-2.0
/**
 * Speaking detection of the own call (design note 4.13 item 3, VOICE.md §9.1). LiveKit's active-speaker
 * events come from the SFU and arrive hundreds of milliseconds after someone starts talking; the client
 * hears the audio long before that. So:
 *
 * - the own ring follows the local gate (`gate.worklet.ts` reports immediately when it opens and the level
 *   about ten times per second), no round trip;
 * - remote rings come from one `AnalyserNode` per subscribed remote microphone track, read by a single
 *   50 ms loop (`RemoteSpeaking` in `session.ts`), with an RMS threshold and a 150 ms hold;
 * - LiveKit's `ActiveSpeakersChanged` stays the fallback when the analysers are not available (no Web
 *   Audio, reduced motion, a weak device).
 *
 * This module holds the pure parts (levels, threshold and hold), so they are unit-tested.
 */
import type { LevelReport } from "./audio";

/** One loop reads every analyser this often. */
export const SPEAKING_POLL_MS = 50;
/** A speaker stays "speaking" this long after the level fell below the threshold (no flicker between words). */
export const SPEAKING_HOLD_MS = 150;
/** RMS level (dBFS) of the decoded remote audio above which someone speaks (Opus DTX sends silence as digital zero). */
export const SPEAKING_THRESHOLD_DB = -50;
/** Analyser window: 1024 samples, about 21 ms at 48 kHz. */
export const ANALYSER_SIZE = 1024;

/** RMS of a block in dBFS (`-Infinity` for digital silence). */
export function rmsDb(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
  if (sum === 0 || block.length === 0) return Number.NEGATIVE_INFINITY;
  return 10 * Math.log10(sum / block.length);
}

/**
 * Display level (0…1) of a speaking participant from a dBFS value: -60 dB and below → 0.05 (still shown
 * as speaking), -10 dB and above → 1.
 */
export function levelOfDb(db: number): number {
  if (!Number.isFinite(db)) return 0.05;
  return Math.min(1, Math.max(0.05, (db + 60) / 50));
}

/** The own speaking level from the gate's report: nothing while muted or while the gate is closed. */
export function localLevel(report: Pick<LevelReport, "level" | "open">, muted: boolean): number {
  if (muted || !report.open) return 0;
  return levelOfDb(report.level);
}

/**
 * Threshold with hold per participant: `push` the measured level at `now`; `levels(now)` returns the
 * speakers (identity → level) whose level was above the threshold within the last `holdMs`.
 */
export class SpeakingDetector {
  private readonly last = new Map<string, { above: number; level: number }>();

  constructor(
    private readonly thresholdDb = SPEAKING_THRESHOLD_DB,
    private readonly holdMs = SPEAKING_HOLD_MS,
  ) {}

  push(identity: string, db: number, now: number): void {
    if (db >= this.thresholdDb) {
      this.last.set(identity, { above: now, level: levelOfDb(db) });
      return;
    }
    const entry = this.last.get(identity);
    // Within the hold the ring stays, fading with the level.
    if (entry && now - entry.above <= this.holdMs) entry.level = Math.max(0.05, Math.min(entry.level, levelOfDb(db)));
  }

  /** Whether `identity` counts as speaking at `now`. */
  speaking(identity: string, now: number): boolean {
    const entry = this.last.get(identity);
    return !!entry && now - entry.above <= this.holdMs;
  }

  levels(now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [identity, entry] of this.last) {
      if (now - entry.above <= this.holdMs) out[identity] = entry.level;
      else this.last.delete(identity);
    }
    return out;
  }

  forget(identity: string): void {
    this.last.delete(identity);
  }

  clear(): void {
    this.last.clear();
  }
}

/** Should the analyser path run? Not without Web Audio, with reduced motion or on a weak device. */
export function analysersAvailable(env: { audioContext: boolean; reducedMotion: boolean; weakDevice: boolean }): boolean {
  return env.audioContext && !env.reducedMotion && !env.weakDevice;
}

/**
 * Combines the own level (from the gate) with the remote levels (analysers or LiveKit) into the complete
 * set of speakers for `SpeakingBatcher.speakers`.
 */
export function combineLevels(local: { identity: string | null; level: number }, remote: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [identity, level] of Object.entries(remote)) if (identity !== local.identity && level > 0) out[identity] = level;
  if (local.identity && local.level > 0) out[local.identity] = local.level;
  return out;
}
