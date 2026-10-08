// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_HOLD_MS, FeedbackDetector, LOOPBACK_MAX_MS, LOOPBACK_POLL_MS, Loopback, tonalShare, type LoopbackContext, type LoopbackState } from "./loopback";
import { IDLE, useVoice } from "./store";

const RATE = 48000;
const FFT = 2048;
const binOf = (hz: number) => Math.round((hz * FFT) / RATE);

/** A spectrum in dB: one strong bin (feedback, a whistle) or energy spread over many harmonics (speech). */
function spectrum(kind: "tonal" | "speech" | "silence"): Float32Array {
  const out = new Float32Array(FFT / 2).fill(-120);
  if (kind === "tonal") {
    out[binOf(1200)] = -10;
    out[binOf(1200) - 1] = -25;
    out[binOf(1200) + 1] = -25;
  } else if (kind === "speech") {
    for (let f = 150; f < 4000; f += 150) out[binOf(f)] = -20 - f / 400;
  }
  return out;
}

/** A recording mock of the playback context: nodes remember their connections, the analyser plays back what the test sets. */
function mockContext() {
  const edges: Array<[string, string]> = [];
  const disconnected: string[] = [];
  const signal = { amplitude: 0, spectrum: spectrum("silence") };
  const node = <T extends object>(name: string, extra: T = {} as T) => ({
    name,
    connect(target: { name: string }) {
      edges.push([name, target.name]);
      return target;
    },
    disconnect() {
      disconnected.push(name);
    },
    ...extra,
  });
  const gain = node("gain", { gain: { value: 1 } });
  const analyser = node("analyser", {
    fftSize: FFT,
    frequencyBinCount: FFT / 2,
    smoothingTimeConstant: 0.5,
    getFloatTimeDomainData(buf: Float32Array) {
      for (let i = 0; i < buf.length; i++) buf[i] = signal.amplitude * Math.sin((2 * Math.PI * 1200 * i) / RATE);
    },
    getFloatFrequencyData(buf: Float32Array) {
      buf.set(signal.spectrum.subarray(0, buf.length));
    },
  });
  const streams: MediaStream[] = [];
  const ctx = {
    name: "ctx",
    state: "running",
    sampleRate: RATE,
    destination: { name: "speakers" },
    createMediaStreamSource: (stream: MediaStream) => {
      streams.push(stream);
      return node("source");
    },
    createGain: () => gain,
    createAnalyser: () => analyser,
    setSinkId: vi.fn(async (_id: string) => undefined),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      ctx.state = "closed";
    }),
  };
  return { ctx: ctx as unknown as LoopbackContext, raw: ctx, edges, disconnected, signal, gain, streams };
}

const track = { kind: "audio", id: "processed" } as unknown as MediaStreamTrack;

function setup() {
  const m = mockContext();
  const states: LoopbackState[] = [];
  const created = vi.fn(() => m.ctx);
  const loop = new Loopback((s) => states.push(s), { createContext: created });
  return { ...m, loop, states, created };
}

describe("hear yourself: live loopback of the microphone test (issue #18)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: MediaStreamTrack[]) {}
      },
    );
    useVoice.setState(IDLE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useVoice.setState(IDLE);
  });

  it("plays the processed track (the one a call publishes) to the chosen output at the output volume", async () => {
    const m = setup();
    expect(await m.loop.start(track, { outputDeviceId: "headset", volume: 0.8 })).toBe(true);
    expect((m.streams[0] as unknown as { tracks: MediaStreamTrack[] }).tracks).toEqual([track]);
    // source → gain → speakers; the analyser listens to the source for feedback.
    expect(m.edges).toEqual(expect.arrayContaining([["source", "gain"], ["gain", "speakers"], ["source", "analyser"]]));
    expect(m.edges).not.toContainEqual(["analyser", "speakers"]);
    expect(m.gain.gain.value).toBeCloseTo(0.8);
    expect(m.raw.setSinkId).toHaveBeenCalledWith("headset");
    expect(m.loop.state).toMatchObject({ running: true, elapsedMs: 0, feedback: false, stopped: null });
    // Volume and output device follow the settings live.
    m.loop.setVolume(1.5);
    expect(m.gain.gain.value).toBeCloseTo(1.5);
    await m.loop.setOutputDevice("");
    expect(m.raw.setSinkId).toHaveBeenLastCalledWith("");
  });

  it("shows the elapsed time and stops by itself after 60 seconds", async () => {
    const m = setup();
    await m.loop.start(track, { outputDeviceId: "", volume: 1 });
    expect(m.raw.setSinkId).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.loop.state.running).toBe(true);
    expect(m.loop.state.elapsedMs).toBeGreaterThanOrEqual(29_000);
    expect(m.loop.state.elapsedMs).toBeLessThanOrEqual(30_000);
    // About one update per second, not one per poll.
    expect(m.states.length).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(LOOPBACK_MAX_MS - 30_000);
    expect(m.loop.state).toMatchObject({ running: false, stopped: "timeout" });
    expect(m.raw.close).toHaveBeenCalledOnce();
    expect(m.disconnected).toEqual(expect.arrayContaining(["source", "gain", "analyser"]));
    const updates = m.states.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.states.length).toBe(updates);
  });

  it("never starts while connected to a voice channel", async () => {
    useVoice.setState({ status: "connected" });
    const m = setup();
    expect(await m.loop.start(track, { outputDeviceId: "", volume: 1 })).toBe(false);
    expect(m.created).not.toHaveBeenCalled();
    expect(m.loop.state).toMatchObject({ running: false, stopped: "voice" });
  });

  it("stops when a voice channel is joined meanwhile", async () => {
    const m = setup();
    await m.loop.start(track, { outputDeviceId: "", volume: 1 });
    useVoice.setState({ status: "joining" });
    expect(m.loop.state).toMatchObject({ running: false, stopped: "voice" });
    expect(m.raw.close).toHaveBeenCalledOnce();
    // Leaving again does not restart it.
    useVoice.setState(IDLE);
    expect(m.loop.state.running).toBe(false);
  });

  it("stops on unmount (leaving the settings); stopping twice is harmless", async () => {
    const m = setup();
    await m.loop.start(track, { outputDeviceId: "", volume: 1 });
    m.loop.stop("unmount");
    m.loop.stop("user");
    expect(m.loop.state).toMatchObject({ running: false, stopped: "unmount" });
    expect(m.raw.close).toHaveBeenCalledOnce();
    // A stopped loopback no longer follows the voice state.
    useVoice.setState({ status: "joining" });
    expect(m.loop.state.stopped).toBe("unmount");
  });

  it("a second start while running keeps the one running", async () => {
    const m = setup();
    await m.loop.start(track, { outputDeviceId: "", volume: 1 });
    expect(await m.loop.start(track, { outputDeviceId: "", volume: 1 })).toBe(true);
    expect(m.created).toHaveBeenCalledOnce();
  });

  it("mutes itself while the level suggests feedback, until the user unmutes", async () => {
    const m = setup();
    await m.loop.start(track, { outputDeviceId: "", volume: 1 });
    // A loud, single-frequency howl for longer than the hold time.
    m.signal.amplitude = 0.7;
    m.signal.spectrum = spectrum("tonal");
    await vi.advanceTimersByTimeAsync(FEEDBACK_HOLD_MS + 2 * LOOPBACK_POLL_MS);
    expect(m.loop.state.feedback).toBe(true);
    expect(m.gain.gain.value).toBe(0);
    // The volume slider does not unmute it; the timer keeps running.
    m.loop.setVolume(1.2);
    expect(m.gain.gain.value).toBe(0);
    expect(m.loop.state.running).toBe(true);
    m.signal.amplitude = 0;
    m.signal.spectrum = spectrum("silence");
    m.loop.resume();
    expect(m.loop.state.feedback).toBe(false);
    expect(m.gain.gain.value).toBeCloseTo(1.2);
  });

  it("does not mistake loud speech or a quiet tone for feedback", async () => {
    const m = setup();
    await m.loop.start(track, { outputDeviceId: "", volume: 1 });
    m.signal.amplitude = 0.7;
    m.signal.spectrum = spectrum("speech");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.loop.state.feedback).toBe(false);
    m.signal.amplitude = 0.005;
    m.signal.spectrum = spectrum("tonal");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.loop.state.feedback).toBe(false);
    expect(m.gain.gain.value).toBe(1);
  });

  it("a failed context start leaves nothing running", async () => {
    const loop = new Loopback(() => undefined, {
      createContext: () => {
        throw new Error("no audio");
      },
    });
    await expect(loop.start(track, { outputDeviceId: "", volume: 1 })).rejects.toThrow("no audio");
    expect(loop.state.running).toBe(false);
    useVoice.setState({ status: "joining" });
    expect(loop.state.stopped).toBeNull();
  });
});

describe("feedback detection", () => {
  it("measures how much of the energy sits in one peak", () => {
    expect(tonalShare(spectrum("tonal"), RATE, FFT)).toBeGreaterThan(0.9);
    expect(tonalShare(spectrum("speech"), RATE, FFT)).toBeLessThan(0.3);
    expect(tonalShare(spectrum("silence"), RATE, FFT)).toBeLessThan(0.5);
    expect(tonalShare(new Float32Array(FFT / 2).fill(-Infinity), RATE, FFT)).toBe(0);
  });

  it("needs a loud tonal signal for the whole hold time; anything else resets it", () => {
    const d = new FeedbackDetector();
    expect(d.push(-10, 0.9, 0)).toBe(false);
    expect(d.push(-10, 0.9, FEEDBACK_HOLD_MS - 1)).toBe(false);
    // Interrupted by a quiet moment: starts over.
    expect(d.push(-60, 0.9, FEEDBACK_HOLD_MS)).toBe(false);
    expect(d.push(-10, 0.9, FEEDBACK_HOLD_MS + 100)).toBe(false);
    expect(d.push(-10, 0.9, 2 * FEEDBACK_HOLD_MS + 100)).toBe(true);
    d.reset();
    expect(d.push(-10, 0.9, 3 * FEEDBACK_HOLD_MS)).toBe(false);
    // Loud but not tonal (speech) never counts.
    const s = new FeedbackDetector();
    for (let t = 0; t < 5_000; t += 100) expect(s.push(-8, 0.2, t)).toBe(false);
  });
});
