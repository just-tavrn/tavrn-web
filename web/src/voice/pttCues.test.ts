// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { PttCues } from "./pttCues";
import type { Cue } from "./settings";

/** A controller on a fake clock; `allowed` stands for "the server lets the microphone through and it is not muted". */
function controller(opts: { allowed?: () => boolean } = {}) {
  const played: Cue[] = [];
  let now = 1000;
  const c = new PttCues((cue) => played.push(cue), { allowed: opts.allowed ?? (() => true), now: () => now });
  return { c, played, tick: (ms: number) => (now += ms) };
}

describe("push-to-talk cues (issue #37)", () => {
  it("a rising tone when the microphone opens, a falling one when it closes", () => {
    const { c, played, tick } = controller();
    c.mic(true);
    tick(400);
    c.mic(false);
    expect(played).toEqual(["ptt_on", "ptt_off"]);
  });

  it("key repeat and the same key seen twice play nothing more; a quick tap gives exactly one tone each way", () => {
    const { c, played, tick } = controller();
    c.mic(true);
    c.mic(true);
    c.mic(true);
    tick(30);
    c.mic(false);
    c.mic(false);
    expect(played).toEqual(["ptt_on", "ptt_off"]);
  });

  it("taps faster than the cues are debounced: the same tone never plays twice within its gap", () => {
    const { c, played, tick } = controller();
    c.mic(true);
    tick(20);
    c.mic(false);
    tick(20);
    c.mic(true);
    tick(20);
    c.mic(false);
    expect(played).toEqual(["ptt_on", "ptt_off"]);
    tick(500);
    c.mic(true);
    expect(played).toEqual(["ptt_on", "ptt_off", "ptt_on"]);
  });

  it("the priority key has its own tones; the microphone it opens plays no push-to-talk tone", () => {
    const { c, played, tick } = controller();
    c.priority(true);
    c.mic(true);
    tick(500);
    c.priority(false);
    tick(250);
    c.mic(false);
    expect(played).toEqual(["priority_on", "priority_off"]);
  });

  it("push-to-talk held, the priority key pressed and released on top: each key's tones, the microphone closes with push-to-talk", () => {
    const { c, played, tick } = controller();
    c.mic(true);
    tick(300);
    c.priority(true);
    tick(300);
    c.priority(false);
    tick(300);
    c.mic(false);
    expect(played).toEqual(["ptt_on", "priority_on", "priority_off", "ptt_off"]);
  });

  it("never while the server keeps the microphone closed (server mute) or the user is muted", () => {
    let allowed = false;
    const { c, played, tick } = controller({ allowed: () => allowed });
    c.mic(true);
    c.priority(true);
    tick(300);
    c.priority(false);
    c.mic(false);
    expect(played).toEqual([]);
    allowed = true;
    tick(300);
    c.mic(true);
    expect(played).toEqual(["ptt_on"]);
  });
});
