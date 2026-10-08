// SPDX-License-Identifier: Apache-2.0
/**
 * AudioWorklet processor "tavrn-gate": noise gate / voice activation / push-to-talk for the microphone
 * (logic in `gate.ts`). Posts `{ level, open }` about ten times per second; takes
 * `{ threshold, holdMs }`, `{ mode }` and `{ stereo }` messages. Runs on the audio rendering thread.
 * Mono (default): the first input channel, gated, on every output channel. Stereo (music mode with a
 * two-channel capture): both channels with one gain, through the channel guard so a single microphone on a
 * two-input interface is never heard on one side only.
 */
import { ChannelGuard, Gate, LevelMeter, dbfs, routeChannels, type GateMode } from "./gate";

// AudioWorkletGlobalScope (not part of the DOM typings).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class GateProcessor extends AudioWorkletProcessor {
  private readonly gate = new Gate(sampleRate);
  private readonly meter = new LevelMeter(sampleRate);
  private wasOpen = false;
  private stereo = false;
  private guard = new ChannelGuard(sampleRate);
  private scratch = new Float32Array(128);

  constructor() {
    super();
    this.gate.configure({ threshold: null, holdMs: 0 });
    this.port.onmessage = (e: MessageEvent<{ threshold?: number | null; holdMs?: number; mode?: GateMode; stereo?: boolean }>) => {
      const d = e.data;
      if ("threshold" in d) this.gate.configure({ threshold: d.threshold ?? null, holdMs: d.holdMs ?? 250 });
      if (d.mode) this.gate.mode = d.mode;
      if (d.stereo !== undefined) {
        // A new capture (device switch): the guard starts over.
        this.stereo = d.stereo;
        this.guard = new ChannelGuard(sampleRate);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.[0]) return true;
    let level = Number.NEGATIVE_INFINITY;
    const right = inputs[0]?.[1];
    if (this.stereo && input && right && output[1]) {
      if (this.scratch.length !== input.length) this.scratch = new Float32Array(input.length);
      const source = this.guard.push(dbfs(input), dbfs(right), input.length);
      level = this.gate.processChannels(routeChannels(source, input, right, this.scratch), [output[0], output[1]]);
    } else {
      if (input) level = this.gate.process(input, output[0]);
      else output[0].fill(0);
      // Mono microphone: every output channel carries the gated signal.
      for (let c = 1; c < output.length; c++) output[c]!.set(output[0]);
    }
    const report = this.meter.push(level);
    const open = this.gate.open;
    if (report !== null || open !== this.wasOpen) {
      this.wasOpen = open;
      this.port.postMessage({ level: report ?? level, open });
    }
    return true;
  }
}

registerProcessor("tavrn-gate", GateProcessor);
