// SPDX-License-Identifier: Apache-2.0
/**
 * AudioWorklet processor "tavrn-gate": noise gate / voice activation / push-to-talk for the microphone
 * (logic in `gate.ts`). Posts `{ level, open }` about ten times per second; takes
 * `{ threshold, holdMs }` and `{ mode }` messages. Runs on the audio rendering thread.
 */
import { Gate, LevelMeter, type GateMode } from "./gate";

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

  constructor() {
    super();
    this.gate.configure({ threshold: null, holdMs: 0 });
    this.port.onmessage = (e: MessageEvent<{ threshold?: number | null; holdMs?: number; mode?: GateMode }>) => {
      const d = e.data;
      if ("threshold" in d) this.gate.configure({ threshold: d.threshold ?? null, holdMs: d.holdMs ?? 250 });
      if (d.mode) this.gate.mode = d.mode;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.[0]) return true;
    let level = Number.NEGATIVE_INFINITY;
    if (input) level = this.gate.process(input, output[0]);
    else output[0].fill(0);
    // Mono microphone: every output channel carries the gated signal.
    for (let c = 1; c < output.length; c++) output[c]!.set(output[0]);
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
