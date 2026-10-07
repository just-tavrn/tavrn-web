// SPDX-License-Identifier: Apache-2.0
/**
 * Noise gate and voice activation for the microphone (design note 4.9). Pure DSP, run inside an
 * AudioWorklet (`gate.worklet.ts`), so the main thread does no per-frame work; only the level is
 * reported about ten times per second for meters and the "transmitting" indicator.
 */

export type GateMode = "auto" | "open" | "closed";

/** RMS level of a block in dBFS (`-Infinity` for digital silence). */
export function dbfs(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
  if (sum === 0) return -Infinity;
  return 10 * Math.log10(sum / block.length);
}

/** The gate closes this far below the open threshold (no fluttering around the threshold). */
const HYSTERESIS_DB = 6;
/** Gain ramps (per sample, linear): fast attack so syllables are not cut, slower release. */
const ATTACK_MS = 5;
const RELEASE_MS = 40;

export class Gate {
  mode: GateMode = "auto";
  private threshold: number | null = null;
  private holdSamples = 0;
  private since = Number.POSITIVE_INFINITY;
  private target = 0;
  private gain = 0;
  private readonly attack: number;
  private readonly release: number;
  private history: number[] | null = null;

  constructor(private readonly sampleRate: number) {
    this.attack = 1 / ((ATTACK_MS / 1000) * sampleRate);
    this.release = 1 / ((RELEASE_MS / 1000) * sampleRate);
  }

  configure({ threshold, holdMs }: { threshold: number | null; holdMs: number }): void {
    this.threshold = threshold;
    this.holdSamples = Math.max(0, (holdMs / 1000) * this.sampleRate);
  }

  /** Whether the gate is (being) opened. */
  get open(): boolean {
    return this.target === 1;
  }

  /** Gates one block from `input` into `output`; returns the input level in dBFS. */
  process(input: Float32Array, output: Float32Array): number {
    const level = dbfs(input);
    this.decide(level, input.length);
    for (let i = 0; i < input.length; i++) {
      if (this.gain < this.target) this.gain = Math.min(1, this.gain + this.attack);
      else if (this.gain > this.target) this.gain = Math.max(0, this.gain - this.release);
      output[i] = input[i]! * this.gain;
    }
    this.history?.push(this.gain);
    return level;
  }

  private decide(level: number, samples: number): void {
    if (this.mode !== "auto" || this.threshold === null) {
      this.target = this.mode === "closed" ? 0 : 1;
      this.since = 0;
      return;
    }
    if (level >= this.threshold || (this.target === 1 && level >= this.threshold - HYSTERESIS_DB)) {
      this.target = 1;
      this.since = 0;
      return;
    }
    this.since += samples;
    if (this.since > this.holdSamples) this.target = 0;
  }

  /** Test hook: records the gain after every block from now on. */
  gainHistoryForTest(): number[] {
    this.history ??= [];
    return this.history;
  }
}

/** Keeps the loudest block level of a ~100 ms window and hands it out once per window. */
export class LevelMeter {
  readonly every: number;
  private count = 0;
  private max = Number.NEGATIVE_INFINITY;

  constructor(sampleRate: number, blockSize = 128) {
    this.every = Math.max(1, Math.round((sampleRate * 0.1) / blockSize));
  }

  push(level: number): number | null {
    if (level > this.max) this.max = level;
    if (++this.count < this.every) return null;
    const out = this.max;
    this.count = 0;
    this.max = Number.NEGATIVE_INFINITY;
    return out;
  }
}

/** Maps dBFS (-100…0) to 0…1 for meters. */
export function levelToUnit(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 100) / 100));
}
