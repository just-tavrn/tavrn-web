// SPDX-License-Identifier: Apache-2.0
/**
 * Renders every cue and both ringtones to WAV files for listening (issue #123): a recording stand-in for the
 * AudioContext captures what `scheduleCue` and `scheduleRingLoop` program (frequency, glides, envelopes, start and
 * stop), and a small offline synthesizer turns it into samples. Only when `RENDER_CUES_DIR` is set:
 *   RENDER_CUES_DIR=../test-results/cues pnpm --filter @tavrn/web exec vitest run cues.render
 * Vitest skips it otherwise (nothing is written in the normal run).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUES, RINGTONES, RING_LOOP, cueLength, scheduleCue, scheduleRingLoop, type CueContext } from "./cues";

const RATE = 48_000;
const DIR = process.env.RENDER_CUES_DIR;

interface Ramp {
  at: number;
  value: number;
  kind: "set" | "linear" | "exp";
}
interface Voice {
  type: OscillatorType;
  freq: Ramp[];
  gain: Ramp[];
  start: number;
  stop: number;
}

/** A context that records the automation of every oscillator and its gain. */
function recorder(): { ctx: CueContext; voices: Voice[] } {
  const voices: Voice[] = [];
  const param = (ramps: Ramp[]) => ({
    setValueAtTime: (value: number, at: number) => ramps.push({ at, value, kind: "set" }),
    linearRampToValueAtTime: (value: number, at: number) => ramps.push({ at, value, kind: "linear" }),
    exponentialRampToValueAtTime: (value: number, at: number) => ramps.push({ at, value, kind: "exp" }),
  });
  const ctx = {
    currentTime: 0,
    destination: {},
    createOscillator: () => {
      const v: Voice = { type: "sine", freq: [], gain: [], start: 0, stop: 0 };
      voices.push(v);
      const osc = {
        type: "sine" as OscillatorType,
        frequency: param(v.freq),
        connect: (gain: { ramps?: Ramp[] }) => {
          // The gain node this oscillator feeds: its automation is the envelope.
          if (gain.ramps) v.gain = gain.ramps;
        },
        start: (t: number) => (v.start = t),
        stop: (t: number) => (v.stop = t),
        onended: null,
      };
      Object.defineProperty(osc, "type", { set: (t: OscillatorType) => (v.type = t), get: () => v.type });
      return osc;
    },
    createGain: () => {
      const ramps: Ramp[] = [];
      return { ramps, gain: param(ramps), connect: () => undefined, disconnect: () => undefined };
    },
  };
  return { ctx: ctx as unknown as CueContext, voices };
}

/** The value of an automated parameter at `t` (Web Audio's set, linear and exponential ramps). */
function valueAt(ramps: Ramp[], t: number): number {
  let value = ramps[0]?.value ?? 0;
  let since = ramps[0]?.at ?? 0;
  for (const r of ramps) {
    if (r.at <= t) {
      value = r.value;
      since = r.at;
      continue;
    }
    if (r.kind === "set") return value;
    const x = (t - since) / Math.max(1e-9, r.at - since);
    return r.kind === "linear" ? value + (r.value - value) * x : value * Math.pow(r.value / value, x);
  }
  return value;
}

function wave(type: OscillatorType, phase: number): number {
  const x = phase % 1;
  if (type === "triangle") return 1 - 4 * Math.abs(x - 0.5);
  return Math.sin(2 * Math.PI * x);
}

/** Renders the recorded voices into `seconds` of mono samples. */
function render(voices: Voice[], seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * RATE));
  for (const v of voices) {
    let phase = 0;
    for (let i = Math.floor(v.start * RATE); i < Math.min(out.length, Math.ceil(v.stop * RATE)); i++) {
      const t = i / RATE;
      phase += valueAt(v.freq, t) / RATE;
      out[i]! += wave(v.type, phase) * valueAt(v.gain, t);
    }
  }
  return out;
}

function wav(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return buf;
}

describe.skipIf(!DIR)("rendering the cues to WAV files for listening (RENDER_CUES_DIR)", () => {
  it("writes one file per cue and per ringtone variant", () => {
    mkdirSync(DIR!, { recursive: true });
    const files: string[] = [];
    for (const cue of CUES) {
      const { ctx, voices } = recorder();
      scheduleCue(ctx, cue, 1);
      const samples = render(voices, cueLength(cue) + 0.3);
      expect(Math.max(...samples.map(Math.abs)), cue).toBeGreaterThan(0.05);
      const file = join(DIR!, `cue-${cue}.wav`);
      writeFileSync(file, wav(samples));
      files.push(file);
    }
    for (const variant of ["direct", "group"] as const) {
      const { ctx, voices } = recorder();
      // Two loops, so the rest before the repeat can be heard.
      scheduleRingLoop(ctx, variant, 1, 0.05);
      scheduleRingLoop(ctx, variant, 1, 0.05 + RING_LOOP);
      expect(voices.length).toBe(RINGTONES[variant].length * 4);
      const file = join(DIR!, `ringtone-${variant}.wav`);
      writeFileSync(file, wav(render(voices, 2 * RING_LOOP + 0.3)));
      files.push(file);
    }
    console.log(`rendered:\n${files.join("\n")}`);
  });
});
