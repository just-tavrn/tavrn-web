// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CueEngine, RINGTONES, RING_LOOP, RING_VIBRATION, ringtonePlaying, scheduleRingLoop, startRingtone, stopRingtone } from "./cues";
import { mockEngineContext } from "../test/audio";

const PENTATONIC = ["C", "D", "E", "G", "A"];
const noteName = (f: number) => ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12];

/** The ringtone on the shared cue engine (same context, resume and output handling as the cues). */
function setup(opts: { state?: string } = {}) {
  const m = mockEngineContext({ now: 0, ...opts });
  return { ...m, engine: new CueEngine(() => m.ctx, { idleMs: 1000, resumeTimeoutMs: 200 }) };
}

describe("ringtone (design note 4.11)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopRingtone();
    vi.useRealTimers();
  });

  it("is a gentle two-bar pentatonic motif that fits its loop", () => {
    for (const [variant, notes] of Object.entries(RINGTONES)) {
      const end = Math.max(...notes.map((n) => n.at + n.dur));
      expect(end, variant).toBeLessThan(RING_LOOP - 0.1);
      expect(end, variant).toBeGreaterThan(RING_LOOP / 2);
      for (const n of notes) {
        expect(PENTATONIC, `${variant} ${n.freq}`).toContain(noteName(n.freq));
        expect(n.freq).toBeGreaterThan(200);
        expect(n.freq).toBeLessThan(900);
      }
    }
    expect(RING_LOOP).toBeCloseTo(2.4);
    // The group variant is softer and calmer.
    const loudness = (v: "direct" | "group") => Math.max(...RINGTONES[v].map((n) => n.gain));
    expect(loudness("group")).toBeLessThan(loudness("direct"));
    expect(RINGTONES.group.length).toBeLessThan(RINGTONES.direct.length);
  });

  it("schedules each note with a quiet octave at a moderate level", () => {
    const m = mockEngineContext({ now: 0 });
    expect(scheduleRingLoop(m.ctx, "direct", 1, 5)).toBe(RINGTONES.direct.length);
    expect(m.starts.length).toBe(RINGTONES.direct.length * 2);
    expect(m.starts[0]!.at).toBe(5);
    expect(Math.max(...m.peaks)).toBeLessThanOrEqual(0.3);
    expect(m.freqs).toContain(RINGTONES.direct[0]!.freq * 2);
  });

  it("loops on the cue engine until it is stopped and records the hook for the UI tests", async () => {
    const m = setup();
    const stop = startRingtone("group", { ringVolume: 50, outputDeviceId: "" }, m.engine);
    expect(ringtonePlaying()).toBe(true);
    expect((window as { __tavrnCues?: { played: { cue: string }[] } }).__tavrnCues?.played.at(-1)?.cue).toBe("ringtone");
    await vi.advanceTimersByTimeAsync(0);
    const first = m.starts.length;
    expect(first).toBeGreaterThan(0);
    // The context clock moves on: the next loop gets scheduled ahead of time.
    m.ctx.currentTime = 2.5;
    await vi.advanceTimersByTimeAsync(600);
    expect(m.starts.length).toBeGreaterThan(first);
    expect(Math.min(...m.starts.slice(first).map((s) => s.at))).toBeGreaterThanOrEqual(RING_LOOP);
    // The engine stays awake while it rings (no idle suspend).
    m.ctx.currentTime = 4;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.calls).not.toContain("suspend");
    stop();
    expect(ringtonePlaying()).toBe(false);
    // Everything scheduled ahead is stopped; nothing new is scheduled.
    expect(m.stops.filter((s) => s.at <= m.ctx.currentTime + 0.1).length).toBeGreaterThan(0);
    const after = m.starts.length;
    m.ctx.currentTime = 10;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.starts.length).toBe(after);
    // Released: the shared context may sleep again.
    expect(m.calls).toContain("suspend");
  });

  it("never schedules into the past when timers were late (background tab)", async () => {
    const m = setup();
    startRingtone("direct", { ringVolume: 60, outputDeviceId: "" }, m.engine);
    await vi.advanceTimersByTimeAsync(0);
    const first = m.starts.length;
    m.ctx.currentTime = 30;
    await vi.advanceTimersByTimeAsync(500);
    expect(Math.min(...m.starts.slice(first).map((s) => s.at))).toBeGreaterThanOrEqual(30);
  });

  it("waits for a suspended (autoplay-blocked) context and starts once it runs", async () => {
    const m = setup({ state: "suspended" });
    startRingtone("direct", { ringVolume: 60, outputDeviceId: "" }, m.engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.calls[0]).toBe("resume");
    expect(m.starts.length).toBeGreaterThan(0);
    expect(Math.min(...m.starts.map((s) => s.at))).toBeGreaterThanOrEqual(0.05);
  });

  it("plays one ringtone at a time and stays silent at volume 0", async () => {
    const a = setup();
    const b = setup();
    startRingtone("direct", { ringVolume: 60, outputDeviceId: "" }, a.engine);
    await vi.advanceTimersByTimeAsync(0);
    startRingtone("direct", { ringVolume: 60, outputDeviceId: "" }, b.engine);
    await vi.advanceTimersByTimeAsync(0);
    // The first one was stopped (its scheduled notes cancelled).
    expect(a.stops.some((s) => s.at < 1)).toBe(true);
    const aStarts = a.starts.length;
    a.ctx.currentTime = 3;
    await vi.advanceTimersByTimeAsync(600);
    expect(a.starts.length).toBe(aStarts);
    stopRingtone();
    const silent = setup();
    startRingtone("direct", { ringVolume: 0, outputDeviceId: "" }, silent.engine);
    await vi.advanceTimersByTimeAsync(600);
    expect(silent.starts.length).toBe(0);
  });

  it("tells whether it can be heard: blocked by the autoplay policy until a gesture unlocks the context", async () => {
    const opts = { state: "suspended", now: 0, resumeWorks: false };
    const m = mockEngineContext(opts);
    const engine = new CueEngine(() => m.ctx, { idleMs: 1000, resumeTimeoutMs: 200 });
    const audible: boolean[] = [];
    startRingtone("direct", { ringVolume: 60, outputDeviceId: "" }, engine, { onAudible: (a) => audible.push(a), vibrate: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(audible).toEqual([false]);
    // Still blocked on the next tick: reported once, not on every tick.
    await vi.advanceTimersByTimeAsync(500);
    expect(audible).toEqual([false]);
    expect(m.starts).toHaveLength(0);
    // The user taps: the context runs and the next tick rings.
    opts.resumeWorks = true;
    await engine.unlock();
    await vi.advanceTimersByTimeAsync(500);
    expect(audible).toEqual([false, true]);
    expect(m.starts.length).toBeGreaterThan(0);
  });

  it("vibrates on phones once per loop while it rings and stops the vibration with it", async () => {
    const m = setup();
    const vibrate = vi.fn((_: number | number[]) => true);
    const stop = startRingtone("direct", { ringVolume: 60, outputDeviceId: "" }, m.engine, { vibrate });
    expect(vibrate).toHaveBeenCalledWith(RING_VIBRATION);
    await vi.advanceTimersByTimeAsync(RING_LOOP * 1000);
    expect(vibrate.mock.calls.filter(([p]) => p === RING_VIBRATION)).toHaveLength(2);
    stop();
    expect(vibrate).toHaveBeenLastCalledWith(0);
    await vi.advanceTimersByTimeAsync(RING_LOOP * 3000);
    expect(vibrate.mock.calls.filter(([p]) => p === RING_VIBRATION)).toHaveLength(2);
    // The vibration fits into one loop; a silent ring (volume 0) does not vibrate either.
    expect((RING_VIBRATION as number[]).reduce((a, b) => a + b, 0)).toBeLessThan(RING_LOOP * 1000);
    const quiet = vi.fn(() => true);
    startRingtone("direct", { ringVolume: 0, outputDeviceId: "" }, setup().engine, { vibrate: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });
});
