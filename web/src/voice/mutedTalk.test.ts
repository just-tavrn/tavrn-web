// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MUTED_TALK_GAP_MS, MUTED_TALK_HOLD_MS, MUTED_TALK_RATE_MS, MutedTalkDetector } from "./mutedTalk";

/** Feeds `db` every 100 ms (the gate's report rate) from `from` for `ms`; returns the times the detector fired. */
function feed(d: MutedTalkDetector, db: number, from: number, ms: number): number[] {
  const fired: number[] = [];
  for (let t = from; t < from + ms; t += 100) if (d.push(db, t)) fired.push(t);
  return fired;
}

describe("talking while muted (issue #125)", () => {
  const threshold = -55;

  it("fires once the level stayed above the speaking threshold for the hold time", () => {
    const d = new MutedTalkDetector(() => threshold);
    expect(feed(d, -40, 0, MUTED_TALK_HOLD_MS - 100)).toEqual([]);
    expect(feed(d, -40, MUTED_TALK_HOLD_MS - 100, 200)).toEqual([MUTED_TALK_HOLD_MS]);
  });

  it("ignores levels below the threshold, silence and short noises", () => {
    const d = new MutedTalkDetector(() => threshold);
    expect(feed(d, -70, 0, 5_000)).toEqual([]);
    expect(feed(d, Number.NEGATIVE_INFINITY, 5_000, 5_000)).toEqual([]);
    // A cough: 300 ms above, then quiet.
    expect(feed(d, -30, 10_000, 300)).toEqual([]);
    expect(feed(d, -80, 10_300, 2_000)).toEqual([]);
  });

  it("tolerates the dips between words, but a longer pause starts over", () => {
    const d = new MutedTalkDetector(() => threshold);
    // 400 ms of speech, a 200 ms dip, speech again: the dip is within the gap, the hold continues.
    expect(feed(d, -40, 0, 400)).toEqual([]);
    expect(feed(d, -80, 400, MUTED_TALK_GAP_MS - 50)).toEqual([]);
    expect(feed(d, -40, 600, 400)).toEqual([MUTED_TALK_HOLD_MS]);
    // After a long pause the hold starts over.
    const e = new MutedTalkDetector(() => threshold);
    feed(e, -40, 0, 400);
    feed(e, -80, 400, MUTED_TALK_GAP_MS + 200);
    expect(feed(e, -40, 1_000, MUTED_TALK_HOLD_MS - 100)).toEqual([]);
    expect(feed(e, -40, 1_000 + MUTED_TALK_HOLD_MS - 100, 200)).toEqual([1_000 + MUTED_TALK_HOLD_MS]);
  });

  it("rate-limits the hint to one per ten seconds while the talking goes on, and resets on unmute", () => {
    const d = new MutedTalkDetector(() => threshold);
    const fired = feed(d, -40, 0, 25_000);
    expect(fired).toEqual([MUTED_TALK_HOLD_MS, MUTED_TALK_HOLD_MS + MUTED_TALK_RATE_MS, MUTED_TALK_HOLD_MS + 2 * MUTED_TALK_RATE_MS]);
    expect(MUTED_TALK_RATE_MS).toBe(10_000);
    // Unmuted and muted again: the next hint needs the hold again, but not the rate window.
    d.reset();
    expect(feed(d, -40, 25_000, MUTED_TALK_HOLD_MS - 100)).toEqual([]);
    expect(feed(d, -40, 25_000 + MUTED_TALK_HOLD_MS - 100, 200)).toEqual([25_000 + MUTED_TALK_HOLD_MS]);
  });

  it("follows the current speaking threshold", () => {
    let threshold = -55;
    const d = new MutedTalkDetector(() => threshold);
    expect(feed(d, -50, 0, 2_000)).toHaveLength(1);
    threshold = -40;
    d.reset();
    expect(feed(d, -50, 2_000, 5_000)).toEqual([]);
  });
});
