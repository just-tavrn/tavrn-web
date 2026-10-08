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
    for (let i = 0; i < input.length; i++) output[i] = input[i]! * this.step();
    this.history?.push(this.gain);
    return level;
  }

  /**
   * Gates one block of one or more channels with one gain (a stereo image stays balanced); the louder
   * channel decides. Returns its level in dBFS.
   */
  processChannels(inputs: Float32Array[], outputs: Float32Array[]): number {
    let level = Number.NEGATIVE_INFINITY;
    for (const input of inputs) level = Math.max(level, dbfs(input));
    const samples = inputs[0]!.length;
    this.decide(level, samples);
    for (let i = 0; i < samples; i++) {
      const gain = this.step();
      for (let c = 0; c < inputs.length; c++) outputs[c]![i] = inputs[c]![i]! * gain;
    }
    this.history?.push(this.gain);
    return level;
  }

  /** One sample of the gain ramp towards the target. */
  private step(): number {
    if (this.gain < this.target) this.gain = Math.min(1, this.gain + this.attack);
    else if (this.gain > this.target) this.gain = Math.max(0, this.gain - this.release);
    return this.gain;
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

/**
 * Where the two output channels of a two-channel microphone capture come from (music mode, VOICE.md §4a):
 * `mix` both carry the average (before the guard knows more), `stereo` left and right as captured, `left` /
 * `right` the live channel on both sides.
 */
export type ChannelSource = "mix" | "stereo" | "left" | "right";

/** A channel at or above this level carries signal. */
const LIVE_DB = -60;
/** A channel below this level is silent (an unused input of an audio interface). */
const SILENT_DB = -70;
/** Evidence needed to leave the start or a one-sided state. */
const DECIDE_MS = 250;
/** A stereo capture folds to its live channel only after one side was silent this long. */
const FOLD_MS = 2000;

/**
 * A mono microphone is never heard on one side only: a two-channel capture whose one channel stays silent
 * while the other carries signal (a single microphone on a two-input interface) goes to both sides from the
 * live channel; it becomes stereo once both channels carry signal. Silence and quiet-but-not-silent channels
 * are no evidence either way. Runs in the gate worklet, one call per block.
 */
export class ChannelGuard {
  source: ChannelSource = "mix";
  private both = 0;
  private left = 0;
  private right = 0;
  private readonly decideSamples: number;
  private readonly foldSamples: number;

  constructor(sampleRate: number) {
    this.decideSamples = (DECIDE_MS / 1000) * sampleRate;
    this.foldSamples = (FOLD_MS / 1000) * sampleRate;
  }

  /** Feeds the levels (dBFS) of one block of both channels; returns the source for this block. */
  push(left: number, right: number, samples: number): ChannelSource {
    const liveL = left >= LIVE_DB;
    const liveR = right >= LIVE_DB;
    if (liveL && liveR) {
      this.both += samples;
      this.left = 0;
      this.right = 0;
    } else if (liveL && right < SILENT_DB) {
      this.left += samples;
      this.right = 0;
      this.both = 0;
    } else if (liveR && left < SILENT_DB) {
      this.right += samples;
      this.left = 0;
      this.both = 0;
    }
    const oneSided = this.source === "stereo" ? this.foldSamples : this.decideSamples;
    if (this.both >= this.decideSamples) this.source = "stereo";
    else if (this.left >= oneSided) this.source = "left";
    else if (this.right >= oneSided) this.source = "right";
    return this.source;
  }
}

/** The two channels to send for `source`; `scratch` (block length) receives the average for `mix`. */
export function routeChannels(source: ChannelSource, left: Float32Array, right: Float32Array, scratch: Float32Array): [Float32Array, Float32Array] {
  if (source === "stereo") return [left, right];
  if (source === "left") return [left, left];
  if (source === "right") return [right, right];
  for (let i = 0; i < left.length; i++) scratch[i] = (left[i]! + right[i]!) / 2;
  return [scratch, scratch];
}
