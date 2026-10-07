// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ANALYSER_SIZE, SPEAKING_HOLD_MS, SPEAKING_POLL_MS, SpeakingDetector, analysersAvailable, combineLevels, levelOfDb, localLevel, rmsDb } from "./speaking";

const RATE = 48_000;
const WINDOW_MS = (ANALYSER_SIZE / RATE) * 1000;

/**
 * The analyser loop on a simulated microphone: a tone with RMS `toneDb` between `on` and `off` (ms),
 * silence (Opus DTX: digital zero) otherwise. The analyser at tick `t` sees the last 1024 samples; the
 * loop reads it every 50 ms starting at `phase`. Returns when the ring turned on and off.
 */
function simulate(on: number, off: number, phase: number, toneDb = -30): { lit: number; dark: number } {
  const detector = new SpeakingDetector();
  let lit = Number.NaN;
  let dark = Number.NaN;
  for (let t = phase; t < off + 1000; t += SPEAKING_POLL_MS) {
    // Share of the window covered by the tone.
    const start = Math.max(t - WINDOW_MS, on);
    const end = Math.min(t, off);
    const share = Math.max(0, end - start) / WINDOW_MS;
    detector.push("a@n/1", share > 0 ? toneDb + 10 * Math.log10(share) : Number.NEGATIVE_INFINITY, t);
    const speaking = detector.speaking("a@n/1", t);
    if (speaking && Number.isNaN(lit)) lit = t;
    if (!speaking && !Number.isNaN(lit) && t > off && Number.isNaN(dark)) dark = t;
  }
  return { lit: lit - on, dark: dark - off };
}

describe("speaking detection (design note 4.13 item 3)", () => {
  it("computes RMS levels and display levels", () => {
    expect(rmsDb(new Float32Array(128))).toBe(Number.NEGATIVE_INFINITY);
    const full = new Float32Array(128).fill(1);
    expect(rmsDb(full)).toBeCloseTo(0, 5);
    const half = new Float32Array(128).fill(0.1);
    expect(rmsDb(half)).toBeCloseTo(-20, 5);
    expect(levelOfDb(-80)).toBe(0.05);
    expect(levelOfDb(-35)).toBeCloseTo(0.5, 5);
    expect(levelOfDb(0)).toBe(1);
  });

  it("threshold with a 150 ms hold: no flicker between words, off after the hold", () => {
    const d = new SpeakingDetector(-50, 150);
    d.push("a", -60, 0);
    expect(d.speaking("a", 0)).toBe(false);
    d.push("a", -30, 50);
    expect(d.levels(50)).toEqual({ a: levelOfDb(-30) });
    // A pause of 100 ms between two words keeps the ring.
    d.push("a", Number.NEGATIVE_INFINITY, 100);
    d.push("a", Number.NEGATIVE_INFINITY, 150);
    expect(d.speaking("a", 150)).toBe(true);
    d.push("a", -32, 200);
    expect(d.speaking("a", 200)).toBe(true);
    // Silence: still lit at 150 ms after the last loud block, dark right after.
    d.push("a", -70, 300);
    expect(d.speaking("a", 350)).toBe(true);
    expect(d.levels(351)).toEqual({});
    expect(d.speaking("a", 351)).toBe(false);
  });

  it("keeps participants apart and forgets them", () => {
    const d = new SpeakingDetector();
    d.push("a", -20, 0);
    d.push("b", -40, 0);
    d.push("c", -80, 0);
    expect(Object.keys(d.levels(10)).sort()).toEqual(["a", "b"]);
    d.forget("a");
    expect(Object.keys(d.levels(10))).toEqual(["b"]);
    d.clear();
    expect(d.levels(10)).toEqual({});
  });

  it("measured latency: the ring lights within one loop period and goes dark within hold + one period", () => {
    const lits: number[] = [];
    const darks: number[] = [];
    // Every phase of the speech onset relative to the 50 ms loop, 1 ms apart.
    for (let phase = 0; phase < SPEAKING_POLL_MS; phase++) {
      const r = simulate(1000, 2500, phase);
      lits.push(r.lit);
      darks.push(r.dark);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Onset: the next loop tick (the analyser window always overlaps the first syllable).
    expect(Math.max(...lits)).toBeLessThanOrEqual(SPEAKING_POLL_MS);
    expect(mean(lits)).toBeLessThan(SPEAKING_POLL_MS / 2 + 1);
    // Release: the hold plus up to one loop period plus the analyser window.
    expect(Math.min(...darks)).toBeGreaterThanOrEqual(SPEAKING_HOLD_MS);
    expect(Math.max(...darks)).toBeLessThanOrEqual(SPEAKING_HOLD_MS + SPEAKING_POLL_MS + WINDOW_MS);
    // Quiet speech (-45 dBFS) needs a third of the window above the threshold: a few ms more.
    const quiet = Array.from({ length: SPEAKING_POLL_MS }, (_, phase) => simulate(1000, 2500, phase, -45).lit);
    expect(Math.max(...quiet)).toBeLessThanOrEqual(SPEAKING_POLL_MS + WINDOW_MS);
    // For VOICE.md §9.1 (printed with `--reporter=verbose`).
    console.info(
      `speaking ring latency: onset mean ${mean(lits).toFixed(1)} ms / max ${Math.max(...lits)} ms; release mean ${mean(darks).toFixed(1)} ms / max ${Math.max(...darks).toFixed(1)} ms; quiet onset max ${Math.max(...quiet).toFixed(1)} ms`,
    );
  });

  it("the own ring follows the gate: nothing while muted or closed", () => {
    expect(localLevel({ level: -30, open: true }, false)).toBeCloseTo(levelOfDb(-30), 5);
    expect(localLevel({ level: -30, open: false }, false)).toBe(0);
    expect(localLevel({ level: -30, open: true }, true)).toBe(0);
    // Push-to-talk held in silence still shows the own ring faintly (the gate is open, the mic transmits).
    expect(localLevel({ level: Number.NEGATIVE_INFINITY, open: true }, false)).toBe(0.05);
  });

  it("combines the own level with the remote ones (the own identity always from the gate)", () => {
    expect(combineLevels({ identity: "me/1", level: 0.4 }, { "a/1": 0.3, "me/1": 0.9, "b/1": 0 })).toEqual({ "a/1": 0.3, "me/1": 0.4 });
    expect(combineLevels({ identity: "me/1", level: 0 }, { "me/1": 0.9 })).toEqual({});
    expect(combineLevels({ identity: null, level: 0.5 }, { "a/1": 0.2 })).toEqual({ "a/1": 0.2 });
  });

  it("falls back to LiveKit without Web Audio, with reduced motion and on weak devices", () => {
    expect(analysersAvailable({ audioContext: true, reducedMotion: false, weakDevice: false })).toBe(true);
    expect(analysersAvailable({ audioContext: false, reducedMotion: false, weakDevice: false })).toBe(false);
    expect(analysersAvailable({ audioContext: true, reducedMotion: true, weakDevice: false })).toBe(false);
    expect(analysersAvailable({ audioContext: true, reducedMotion: false, weakDevice: true })).toBe(false);
  });
});
