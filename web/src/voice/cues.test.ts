// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUES, CUE_GAP, CueEngine, LEAD, PATTERNS, cueAllowed, cueLength, cueEngine, installCueUnlock, playCue, previewCue, scheduleCue, type CueContext } from "./cues";
import { mockEngineContext } from "../test/audio";
import { DEFAULT_SETTINGS, normalizeSettings, useVoiceSettings } from "./settings";

/** A recording mock of the AudioContext parts the scheduler uses. */
function mockContext(now = 2) {
  const events: Array<{ node: string; op: string; args: number[] | string[] }> = [];
  const param = (node: string, name: string) => ({
    setValueAtTime: (v: number, t: number) => events.push({ node, op: `${name}.set`, args: [v, t] }),
    linearRampToValueAtTime: (v: number, t: number) => events.push({ node, op: `${name}.linear`, args: [v, t] }),
    exponentialRampToValueAtTime: (v: number, t: number) => events.push({ node, op: `${name}.exp`, args: [v, t] }),
  });
  let id = 0;
  const ctx = {
    currentTime: now,
    destination: { name: "destination" },
    createOscillator: () => {
      const name = `osc${id++}`;
      return { type: "sine", frequency: param(name, "frequency"), connect: () => undefined, start: (t: number) => events.push({ node: name, op: "start", args: [t] }), stop: (t: number) => events.push({ node: name, op: "stop", args: [t] }), onended: null };
    },
    createGain: () => {
      const name = `gain${id++}`;
      return { gain: param(name, "gain"), connect: () => undefined, disconnect: () => undefined };
    },
  };
  return { ctx: ctx as unknown as CueContext, events };
}

describe("notification sounds (design note 4.9)", () => {
  beforeEach(() => {
    localStorage.clear();
    useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
    delete (window as { __tavrnCues?: unknown }).__tavrnCues;
  });

  it("keeps every cue short (< 300 ms) and in a gentle register", () => {
    for (const cue of CUES) {
      expect(cueLength(cue), cue).toBeLessThan(0.3);
      for (const note of PATTERNS[cue]) {
        expect(note.freq, cue).toBeGreaterThan(200);
        expect(note.freq, cue).toBeLessThan(1200);
        expect(["sine", "triangle"]).toContain(note.type);
      }
    }
    // Join rises, leave falls.
    expect(PATTERNS.join[1]!.freq).toBeGreaterThan(PATTERNS.join[0]!.freq);
    expect(PATTERNS.leave[1]!.freq).toBeLessThan(PATTERNS.leave[0]!.freq);
  });

  it("push-to-talk and priority speaker: one soft tone each, rising when the microphone opens, falling when it closes (issue #37)", () => {
    for (const [on, off] of [
      ["ptt_on", "ptt_off"],
      ["priority_on", "priority_off"],
    ] as const) {
      for (const cue of [on, off]) {
        expect(PATTERNS[cue], cue).toHaveLength(1);
        expect(PATTERNS[cue][0]!.gain, cue).toBeLessThanOrEqual(0.6);
        expect(cueLength(cue), cue).toBeLessThan(0.15);
      }
      const [up, down] = [PATTERNS[on][0]!, PATTERNS[off][0]!];
      expect(up.to!).toBeGreaterThan(up.freq);
      expect(down.to!).toBeLessThan(down.freq);
    }
    // The priority speaker's tones sit higher, so the two keys sound apart.
    expect(PATTERNS.priority_on[0]!.freq).toBeGreaterThan(PATTERNS.ptt_on[0]!.freq);
    // The glide is scheduled on the oscillator's frequency.
    const { ctx, events } = mockContext(1);
    scheduleCue(ctx, "ptt_on", 0.5);
    const glide = events.find((e) => e.op === "frequency.exp" || e.op === "frequency.linear");
    expect(glide?.args[0]).toBeCloseTo(PATTERNS.ptt_on[0]!.to!, 3);
    // On by default, switched off one by one like the others.
    expect(DEFAULT_SETTINGS.cuesDisabled).toEqual([]);
    expect(normalizeSettings({ cuesDisabled: ["ptt_on", "priority_off", "nope"] }).cuesDisabled).toEqual(["ptt_on", "priority_off"]);
  });

  it("schedules each note with a soft envelope scaled by the volume", () => {
    const { ctx, events } = mockContext(2);
    expect(scheduleCue(ctx, "join", 0.5)).toBe(2);
    const starts = events.filter((e) => e.op === "start").map((e) => e.args[0] as number);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBeGreaterThanOrEqual(2);
    expect(starts[1]).toBeGreaterThan(starts[0]!);
    // Envelope: from silence, short attack to the peak, exponential release towards zero.
    const gains = events.filter((e) => e.op.startsWith("gain."));
    expect(gains[0]).toMatchObject({ op: "gain.set", args: [0, starts[0]] });
    const peak = gains.find((g) => g.op === "gain.linear")!.args[0] as number;
    expect(peak).toBeCloseTo(0.5 * 0.25, 5);
    expect(gains.some((g) => g.op === "gain.exp")).toBe(true);
    // Louder at full volume, but still moderate.
    const loud = mockContext(0);
    scheduleCue(loud.ctx, "join", 1);
    expect(loud.events.find((g) => g.op === "gain.linear")!.args[0]).toBeLessThanOrEqual(0.25);
  });

  it("gates cues by the switches; while deafened only the user's own cues play", () => {
    const s = DEFAULT_SETTINGS;
    expect(cueAllowed("join", s, { deafened: false, own: false })).toBe(true);
    expect(cueAllowed("join", s, { deafened: true, own: false })).toBe(false);
    expect(cueAllowed("undeafen", s, { deafened: true, own: true })).toBe(true);
    expect(cueAllowed("join", { ...s, cuesOff: true }, { deafened: false, own: true })).toBe(false);
    expect(cueAllowed("mute", { ...s, cuesDisabled: ["mute"] }, { deafened: false, own: true })).toBe(false);
    expect(cueAllowed("unmute", { ...s, cuesDisabled: ["mute"] }, { deafened: false, own: true })).toBe(true);
    expect(cueAllowed("join", { ...s, cueVolume: 0 }, { deafened: false, own: true })).toBe(false);
  });

  it("validates stored cue settings", () => {
    const n = normalizeSettings({ cueVolume: 500, cuesOff: "yes", cuesDisabled: ["join", "bogus", "leave"] });
    expect(n.cueVolume).toBe(100);
    expect(n.cuesOff).toBe(false);
    expect(n.cuesDisabled).toEqual(["join", "leave"]);
    expect(normalizeSettings({}).cueVolume).toBe(40);
  });

  it("records played cues for the tests and plays nothing with all cues off", () => {
    playCue("join", { own: false, deafened: false });
    expect((window as { __tavrnCues?: { played: unknown[] } }).__tavrnCues?.played).toEqual([{ cue: "join", own: false }]);
    useVoiceSettings.getState().update({ cuesOff: true });
    playCue("leave", { own: true, deafened: false });
    expect((window as { __tavrnCues?: { played: unknown[] } }).__tavrnCues?.played).toHaveLength(1);
  });

  it("hands only allowed cues to the engine (deafened: own cues only)", () => {
    const play = vi.spyOn(cueEngine, "play").mockResolvedValue(true);
    playCue("join", { own: false, deafened: true });
    expect(play).not.toHaveBeenCalled();
    playCue("deafen", { own: true, deafened: true });
    expect(play).toHaveBeenCalledWith("deafen", 0.4, "");
    useVoiceSettings.getState().update({ cuesDisabled: ["mute"] });
    playCue("mute", { own: true, deafened: false });
    expect(play).toHaveBeenCalledTimes(1);
    play.mockRestore();
  });
});

describe("cue engine: one context, resumed before every cue, queued (design note 4.9)", () => {
  afterEach(() => vi.useRealTimers());

  it("awaits resume() of a suspended context and schedules after the clock it reads afterwards", async () => {
    const m = mockEngineContext({ state: "suspended", now: 3 });
    const engine = new CueEngine(() => m.ctx);
    expect(await engine.play("join", 0.5, "")).toBe(true);
    expect(m.calls).toEqual(["resume"]);
    // The clock moved on while resuming (3 → 3.05): no note starts in the past.
    expect(Math.min(...m.starts.map((s) => s.at))).toBeGreaterThanOrEqual(3.05 + LEAD - 1e-9);
  });

  it("drops a cue when the context cannot be resumed (no user activation yet) instead of playing it stale", async () => {
    vi.useFakeTimers();
    const m = mockEngineContext({ state: "suspended", resumeWorks: false });
    const engine = new CueEngine(() => m.ctx, { idleMs: 1500, resumeTimeoutMs: 200 });
    const played = engine.play("mute", 1, "");
    await vi.advanceTimersByTimeAsync(250);
    expect(await played).toBe(false);
    expect(m.starts).toHaveLength(0);
    // Once the page has user activation, a gesture resumes the context and the next cue sounds.
    const works = mockEngineContext({ state: "suspended" });
    const engine2 = new CueEngine(() => works.ctx);
    engine2.context();
    await engine2.unlock();
    expect(works.ctx.state).toBe("running");
    expect(await engine2.play("unmute", 1, "")).toBe(true);
  });

  it("queues back-to-back cues so they never overlap, each with its own gain", async () => {
    const m = mockEngineContext({ now: 5 });
    const engine = new CueEngine(() => m.ctx);
    const [a, b, c] = await Promise.all([engine.play("mute", 1, ""), engine.play("unmute", 1, ""), engine.play("deafen", 1, "")]);
    expect([a, b, c]).toEqual([true, true, true]);
    const mute = m.starts[0]!.at;
    const unmute = m.starts[1]!.at;
    const deafen = m.starts[2]!.at;
    expect(unmute).toBeGreaterThanOrEqual(mute + cueLength("mute") + CUE_GAP - 1e-9);
    expect(deafen).toBeGreaterThanOrEqual(unmute + cueLength("unmute") + CUE_GAP - 1e-9);
    // Nodes stay referenced until they ended; every cue's own gain is released with its last note.
    expect(engine.liveNodes).toBe(PATTERNS.mute.length + PATTERNS.unmute.length + PATTERNS.deafen.length);
    m.endAll();
    expect(engine.liveNodes).toBe(0);
    // Per note one gain, per cue one bus: all disconnected.
    expect(m.disconnects()).toBe(PATTERNS.mute.length + PATTERNS.unmute.length + PATTERNS.deafen.length + 3);
  });

  it("drops cues once the backlog gets too long (a burst of events)", async () => {
    const m = mockEngineContext({ now: 1 });
    const engine = new CueEngine(() => m.ctx);
    const results = await Promise.all(Array.from({ length: 8 }, () => engine.play("join", 1, "")));
    expect(results.filter(Boolean).length).toBeGreaterThan(1);
    expect(results.at(-1)).toBe(false);
  });

  it("waits for its own idle suspend still in flight and switches the output device before scheduling", async () => {
    vi.useFakeTimers();
    const m = mockEngineContext({ now: 1 });
    const engine = new CueEngine(() => m.ctx, { idleMs: 1000, resumeTimeoutMs: 500 });
    expect(await engine.play("join", 1, "")).toBe(true);
    // Idle: the context goes to sleep after the cue …
    await vi.advanceTimersByTimeAsync(1000 + (LEAD + cueLength("join")) * 1000 + 10);
    expect(m.calls).toContain("suspend");
    expect(m.ctx.state).toBe("suspended");
    // … and the next cue (on another output) resumes it first.
    const next = engine.play("leave", 1, "speaker-2");
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toBe(true);
    expect(m.calls.slice(-2)).toEqual(["sink:speaker-2", "resume"]);
    expect(m.ctx.state).toBe("running");
  });

  it("does not let a suspend that is still settling swallow the next cue", async () => {
    vi.useFakeTimers();
    const m = mockEngineContext({ now: 1 });
    const engine = new CueEngine(() => m.ctx, { idleMs: 1000, resumeTimeoutMs: 500 });
    await engine.play("mute", 1, "");
    // The idle timer fires and calls suspend(); the state is still "running" until it settles.
    vi.advanceTimersByTime(1000 + (LEAD + cueLength("mute")) * 1000 + 5);
    expect(m.ctx.state).toBe("running");
    const next = engine.play("unmute", 1, "");
    await vi.advanceTimersByTimeAsync(5);
    expect(await next).toBe(true);
    expect(m.ctx.state).toBe("running");
    expect(m.calls).toEqual(["suspend", "resume"]);
  });

  it("previews through the engine and resumes on user gestures", async () => {
    const m = mockEngineContext({ state: "suspended" });
    const engine = new CueEngine(() => m.ctx);
    const target = new EventTarget();
    installCueUnlock(target as unknown as Window, engine);
    // No context yet: a gesture creates nothing.
    target.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(m.calls).toEqual([]);
    // A context the browser left suspended (created before any gesture) is resumed by the next gesture.
    engine.context();
    target.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    await Promise.resolve();
    expect(m.calls).toEqual(["resume"]);
    expect(m.ctx.state).toBe("running");
    expect(await previewCue("stream_on", { cueVolume: 100, outputDeviceId: "" }, engine)).toBe(true);
    expect(Math.max(...m.peaks)).toBeLessThanOrEqual(0.25);
  });
});
