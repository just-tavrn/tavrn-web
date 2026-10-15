// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeakingBatcher, isWatched, keepMedia, useSpeaking, useWatchedStreams, watchStream, type ParticipantMedia } from "./store";

describe("speaking levels (design note 4.5 item 6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSpeaking.setState({ levels: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("writes at most ten updates per second, with the latest speakers", () => {
    const b = new SpeakingBatcher(100);
    const writes: Array<Record<string, number>> = [];
    const off = useSpeaking.subscribe((s) => writes.push(s.levels));
    for (let i = 0; i < 50; i++) {
      b.speakers({ "a@n/1": (i % 10) / 10 + 0.05 });
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(200);
    off();
    // 50 events over 500 ms → at most 6 store writes.
    expect(writes.length).toBeLessThanOrEqual(6);
    expect(writes.length).toBeGreaterThan(0);
  });

  it("writes a change after a quiet interval at once (leading edge), later ones batched", () => {
    const b = new SpeakingBatcher(100);
    b.speakers({ "a@n/1": 0.5 });
    expect(useSpeaking.getState().levels).toEqual({ "a@n/1": 0.5 });
    b.speakers({ "a@n/1": 0.5, "b@n/1": 0.5 });
    expect(useSpeaking.getState().levels).toEqual({ "a@n/1": 0.5 });
    vi.advanceTimersByTime(100);
    expect(useSpeaking.getState().levels).toEqual({ "a@n/1": 0.5, "b@n/1": 0.5 });
    vi.advanceTimersByTime(500);
    b.speakers({});
    expect(useSpeaking.getState().levels).toEqual({});
  });

  it("drops silent participants, rounds levels and skips writes that change nothing", () => {
    const b = new SpeakingBatcher(100);
    b.speakers({ "a@n/1": 0.52, "b@n/1": 0.001 });
    vi.advanceTimersByTime(100);
    expect(useSpeaking.getState().levels).toEqual({ "a@n/1": 0.5 });
    const before = useSpeaking.getState().levels;
    b.speakers({ "a@n/1": 0.51 });
    vi.advanceTimersByTime(100);
    expect(useSpeaking.getState().levels).toBe(before);
    b.speakers({});
    vi.advanceTimersByTime(100);
    expect(useSpeaking.getState().levels).toEqual({});
    // A very quiet speaker still shows as speaking.
    b.speakers({ "c@n/1": 0.02 });
    b.flush();
    expect(useSpeaking.getState().levels).toEqual({ "c@n/1": 0.05 });
    b.clear();
    expect(useSpeaking.getState().levels).toEqual({});
  });
});

describe("watched streams (issue #20)", () => {
  beforeEach(() => useWatchedStreams.setState({ watching: {} }));

  it("counts the tiles showing a stream; released by the last one", () => {
    expect(isWatched(useWatchedStreams.getState(), "bob@n/1")).toBe(false);
    const first = watchStream("bob@n/1");
    const second = watchStream("bob@n/1");
    expect(isWatched(useWatchedStreams.getState(), "bob@n/1")).toBe(true);
    first();
    expect(isWatched(useWatchedStreams.getState(), "bob@n/1")).toBe(true);
    // Releasing twice does not count down twice.
    first();
    expect(isWatched(useWatchedStreams.getState(), "bob@n/1")).toBe(true);
    second();
    expect(isWatched(useWatchedStreams.getState(), "bob@n/1")).toBe(false);
    expect(useWatchedStreams.getState().watching).toEqual({});
  });
});

describe("participant media (the stage re-renders on real changes only)", () => {
  const m = (micMuted: boolean, camera = false): ParticipantMedia => ({ camera, screen: false, screenVideo: false, micMuted, screenAudio: false });

  it("keeps the previous objects when nothing changed, and the map itself", () => {
    const prev = { a: m(false), b: m(true) };
    expect(keepMedia(prev, { a: m(false), b: m(true) })).toBe(prev);
  });

  it("replaces only the participant that changed; joins and leaves change the map", () => {
    const prev = { a: m(false), b: m(true) };
    const next = keepMedia(prev, { a: m(false), b: m(false) });
    expect(next).not.toBe(prev);
    expect(next.a).toBe(prev.a);
    expect(next.b).toEqual(m(false));
    expect(keepMedia(prev, { a: m(false) })).toEqual({ a: m(false) });
    expect(keepMedia(prev, { a: m(false), c: m(true) })).not.toBe(prev);
    // Missing optional flags count as false.
    expect(keepMedia({ a: { camera: false, screen: false, micMuted: true } }, { a: m(true) }).a).toEqual({ camera: false, screen: false, micMuted: true });
  });
});
