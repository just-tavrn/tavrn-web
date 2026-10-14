// SPDX-License-Identifier: Apache-2.0
/**
 * Talking while muted (issue #125): the user forgot to unmute and talks into a muted microphone. While muted (the
 * toggle, not a released push-to-talk key) the session keeps the capture open and the gate's level reports running
 * (`audio.ts`, `capture.ts`); the gate itself is closed and the published track muted, so nothing is sent. This
 * detector takes the pre-gate level about ten times per second: once it stayed above the speaking threshold (the
 * voice activation threshold of the settings) for `MUTED_TALK_HOLD_MS`, allowing the short dips between words
 * (`MUTED_TALK_GAP_MS`), it fires, and then at most once per `MUTED_TALK_RATE_MS` while the talking goes on. The
 * session plays the `muted_talk` cue, pulses the microphone button and says it once (`docs/CLIENT.md`).
 * Pure, so it is unit-tested; `reset` on unmute.
 */

/** The level has to stay above the threshold this long (a cough or a bump does not count). */
export const MUTED_TALK_HOLD_MS = 700;
/** A dip below the threshold shorter than this (between words) does not restart the hold. */
export const MUTED_TALK_GAP_MS = 250;
/** One hint per this while the talking goes on. */
export const MUTED_TALK_RATE_MS = 10_000;

export class MutedTalkDetector {
  /** When the level first went above the threshold (null: below it). */
  private above: number | null = null;
  private lastAbove = 0;
  private lastHint = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly thresholdDb: () => number,
    private readonly opts: { holdMs: number; gapMs: number; rateMs: number } = { holdMs: MUTED_TALK_HOLD_MS, gapMs: MUTED_TALK_GAP_MS, rateMs: MUTED_TALK_RATE_MS },
  ) {}

  /** A level report (dBFS before the gate) at `now` (ms); true when the hint should fire. */
  push(db: number, now: number): boolean {
    if (db >= this.thresholdDb()) {
      this.above ??= now;
      this.lastAbove = now;
      if (now - this.above >= this.opts.holdMs && now - this.lastHint >= this.opts.rateMs) {
        this.lastHint = now;
        return true;
      }
      return false;
    }
    if (this.above !== null && now - this.lastAbove > this.opts.gapMs) this.above = null;
    return false;
  }

  /** Unmuted (or the hint is off): the next hint needs the full hold again and is not rate-limited by the last one. */
  reset(): void {
    this.above = null;
    this.lastHint = Number.NEGATIVE_INFINITY;
  }
}
