// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
/**
 * Microphone pipeline (design note 4.9, VOICE.md §8), WebAudio at 48 kHz:
 *
 *   mic ─▶ input volume ─▶ [RNNoise worklet] ─▶ gate worklet ─▶ mix ─▶ track (published)
 *                                         soundboard clips ─┘    └─▶ (clips also to the own speakers)
 *
 * The published track never changes during a call: switching the input device or the noise suppression
 * only rewires the nodes in front of the gate. Voice activation, noise gate and push-to-talk are the gate
 * (an AudioWorklet, `gate.worklet.ts`); RNNoise is the WASM worklet of `@sapphi-red/web-noise-suppressor`.
 * The worklet reports the level about ten times per second; nothing runs per frame on the main thread.
 * Loaded lazily (voice session and settings tab only).
 */
import gateWorkletUrl from "./gate.worklet.ts?worker&url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import { captureConstraints, gateThreshold, type VoiceSettings } from "./settings";

export interface LevelReport {
  /** dBFS of the loudest block of the last ~100 ms (before the gate). */
  level: number;
  /** The gate lets the voice through (transmitting). */
  open: boolean;
}

let rnnoiseBinary: Promise<ArrayBuffer> | null = null;

const sameConstraints = (a: MediaTrackConstraints, b: MediaTrackConstraints) => JSON.stringify(a) === JSON.stringify(b);

export class MicPipeline {
  readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly input: GainNode;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private readonly gate: AudioWorkletNode;
  private readonly mix: GainNode;
  private readonly monitor: GainNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private constraints: MediaTrackConstraints | null = null;
  private settings: VoiceSettings;
  private pttTimer: ReturnType<typeof setTimeout> | null = null;
  /** Push-to-talk holds the gate open (key down or within the release delay). */
  private pttOpen = false;
  private closed = false;

  private constructor(ctx: AudioContext, gate: AudioWorkletNode, settings: VoiceSettings, onLevel: (r: LevelReport) => void) {
    this.ctx = ctx;
    this.settings = settings;
    this.input = ctx.createGain();
    this.gate = gate;
    this.mix = ctx.createGain();
    this.monitor = ctx.createGain();
    this.dest = ctx.createMediaStreamDestination();
    this.gate.port.onmessage = (e: MessageEvent<LevelReport>) => onLevel(e.data);
    this.input.connect(this.gate);
    this.gate.connect(this.mix);
    this.mix.connect(this.dest);
    this.monitor.connect(ctx.destination);
  }

  /** Opens the microphone with the settings (asks for permission). */
  static async create(settings: VoiceSettings, onLevel: (r: LevelReport) => void = () => undefined): Promise<MicPipeline> {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    try {
      await ctx.audioWorklet.addModule(gateWorkletUrl);
      const gate = new AudioWorkletNode(ctx, "tavrn-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const pipeline = new MicPipeline(ctx, gate, settings, onLevel);
      await pipeline.apply(settings);
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      return pipeline;
    } catch (e) {
      await ctx.close().catch(() => undefined);
      throw e;
    }
  }

  /** The processed microphone track to publish (stays the same for the pipeline's life). */
  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0]!;
  }

  /** The raw input track (device label, settings). */
  get inputTrack(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  /** Applies changed settings live: device and constraints, RNNoise, gate, input volume. */
  async apply(settings: VoiceSettings): Promise<void> {
    this.settings = settings;
    const constraints = captureConstraints(settings);
    if (!this.constraints || !sameConstraints(constraints, this.constraints)) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      if (this.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = stream;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.constraints = constraints;
      this.rnnoise?.disconnect();
      this.rnnoise?.destroy();
      this.rnnoise = null;
    }
    await this.wire(settings.noiseSuppression === "rnnoise");
    this.input.gain.value = settings.inputVolume / 100;
    this.gate.port.postMessage({ threshold: gateThreshold(settings), holdMs: settings.inputMode === "ptt" ? 0 : 300 });
    if (settings.inputMode !== "ptt") this.pttOpen = false;
    this.gate.port.postMessage({ mode: settings.inputMode === "ptt" ? (this.pttOpen ? "open" : "closed") : "auto" });
  }

  private async wire(rnnoise: boolean): Promise<void> {
    if (!this.source) return;
    if (rnnoise && !this.rnnoise) {
      rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((e: unknown) => {
        rnnoiseBinary = null;
        throw e;
      });
      const wasmBinary = await rnnoiseBinary;
      await this.ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
      this.rnnoise = new RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary });
    } else if (!rnnoise && this.rnnoise) {
      this.rnnoise.disconnect();
      this.rnnoise.destroy();
      this.rnnoise = null;
    }
    this.source.disconnect();
    if (this.rnnoise) {
      this.rnnoise.disconnect();
      this.source.connect(this.rnnoise);
      this.rnnoise.connect(this.input);
    } else {
      this.source.connect(this.input);
    }
  }

  /**
   * Push-to-talk: the key opens the gate; after release it stays open for the release delay. Ignored in
   * voice activation mode.
   */
  setPtt(pressed: boolean): void {
    if (this.settings.inputMode !== "ptt") return;
    if (this.pttTimer) clearTimeout(this.pttTimer);
    this.pttTimer = null;
    if (pressed) {
      this.pttOpen = true;
      this.gate.port.postMessage({ mode: "open" });
      return;
    }
    this.pttTimer = setTimeout(() => {
      this.pttTimer = null;
      this.pttOpen = false;
      this.gate.port.postMessage({ mode: "closed" });
    }, this.settings.pttReleaseMs);
  }

  /**
   * Pauses the whole graph while the microphone is muted (no audio rendering, saves CPU); a muted track
   * sends nothing anyway.
   */
  async setPaused(paused: boolean): Promise<void> {
    if (this.closed) return;
    if (paused && this.ctx.state === "running") await this.ctx.suspend().catch(() => undefined);
    if (!paused && this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
  }

  /** Decodes an audio file (soundboard clip, test recording). */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  /**
   * Plays a clip into the published track (everybody in the call hears it, end-to-end encrypted like the
   * voice) and on the own speakers. Resolves when it ends.
   */
  playClip(buffer: AudioBuffer, volume = 1): Promise<void> {
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    node.connect(gain);
    gain.connect(this.mix);
    gain.connect(this.monitor);
    return new Promise((resolve) => {
      node.onended = () => {
        gain.disconnect();
        resolve();
      };
      node.start();
    });
  }

  /** Output device of the own clip playback (Chromium: `AudioContext.setSinkId`). */
  async setOutputDevice(deviceId: string): Promise<void> {
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    await ctx.setSinkId?.(deviceId).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pttTimer) clearTimeout(this.pttTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.dest.stream.getTracks().forEach((t) => t.stop());
    this.rnnoise?.destroy();
    this.gate.port.onmessage = null;
    await this.ctx.close().catch(() => undefined);
  }
}
