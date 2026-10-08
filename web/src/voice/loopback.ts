// SPDX-License-Identifier: Apache-2.0
/**
 * "Hear yourself" (issue #18): the microphone test of the voice settings played back live, so users judge
 * device, gain, noise suppression and the voice gate the way others will hear them. It plays the processed
 * track of the settings' `MicPipeline` (the same chain a call publishes) on its own AudioContext:
 *
 *   processed mic track ─▶ MediaStreamSource ─┬─▶ gain (output volume; 0 while feedback is suspected) ─▶ speakers
 *                                             └─▶ analyser (feedback detection, never to the speakers)
 *
 * Feedback protection: the settings tab asks for headphones; the loopback mutes itself while the signal is
 * loud and concentrated in one frequency (the howl of a speaker feeding the microphone) for half a second and
 * stays muted until the user unmutes it; it never runs while the user is in a voice channel (refused at the
 * start and stopped when a join begins). It stops by itself after 60 seconds and when the settings close.
 */
import { dbfs } from "./gate";
import { useVoice } from "./store";

/** The loopback stops by itself after this time. */
export const LOOPBACK_MAX_MS = 60_000;
/** The timer and the feedback detection poll this often. */
export const LOOPBACK_POLL_MS = 100;
/** Feedback: at least this loud (dBFS, RMS) … */
export const FEEDBACK_MIN_DB = -30;
/** … with at least this share of the energy in one peak (a howl or whistle, not a voice) … */
export const FEEDBACK_TONAL_SHARE = 0.5;
/** … for at least this long. */
export const FEEDBACK_HOLD_MS = 500;
const FFT_SIZE = 2048;
/** The band where acoustic feedback builds up (and speech has its harmonics). */
const BAND_HZ: [number, number] = [150, 6000];

export type LoopbackStopReason = "user" | "timeout" | "voice" | "unmount";

export interface LoopbackState {
  running: boolean;
  /** Time since the start (updated about once per second). */
  elapsedMs: number;
  /** Muted because the signal suggests feedback; `resume` unmutes. */
  feedback: boolean;
  /** Why the last run ended (null: never ran or running). */
  stopped: LoopbackStopReason | null;
}

/** What the loopback needs of an AudioContext (mocked in the tests). */
export type LoopbackContext = Pick<AudioContext, "createMediaStreamSource" | "createGain" | "createAnalyser" | "destination" | "close" | "resume" | "state" | "sampleRate"> & {
  setSinkId?: (id: string) => Promise<void>;
};

/**
 * Share (0…1) of the band's energy in its strongest peak (± two bins) of an analyser spectrum in dB. A sine or
 * a feedback howl is close to 1, speech (many harmonics) and noise far below.
 */
export function tonalShare(spectrumDb: Float32Array, sampleRate: number, fftSize: number): number {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(0, Math.ceil(BAND_HZ[0] / binHz));
  const hi = Math.min(spectrumDb.length - 1, Math.floor(BAND_HZ[1] / binHz));
  const power = (i: number) => {
    const v = spectrumDb[i]!;
    return Number.isFinite(v) ? 10 ** (v / 10) : 0;
  };
  let total = 0;
  let peak = lo;
  for (let i = lo; i <= hi; i++) {
    const p = power(i);
    total += p;
    if (p > power(peak)) peak = i;
  }
  if (total <= 0) return 0;
  let around = 0;
  for (let i = Math.max(lo, peak - 2); i <= Math.min(hi, peak + 2); i++) around += power(i);
  return around / total;
}

/** Suspected feedback: loud and tonal without a break for `FEEDBACK_HOLD_MS`. */
export class FeedbackDetector {
  private since: number | null = null;

  push(levelDb: number, share: number, now: number): boolean {
    if (levelDb < FEEDBACK_MIN_DB || share < FEEDBACK_TONAL_SHARE) {
      this.since = null;
      return false;
    }
    this.since ??= now;
    return now - this.since >= FEEDBACK_HOLD_MS;
  }

  reset(): void {
    this.since = null;
  }
}

interface Graph {
  ctx: LoopbackContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  timer: ReturnType<typeof setInterval>;
  offVoice: () => void;
  startedAt: number;
}

const voiceBusy = () => useVoice.getState().status !== "idle";

function defaultContext(): LoopbackContext {
  return new AudioContext({ latencyHint: "interactive" });
}

export class Loopback {
  private graph: Graph | null = null;
  private starting = false;
  private volume = 1;
  private current: LoopbackState = { running: false, elapsedMs: 0, feedback: false, stopped: null };
  private readonly detector = new FeedbackDetector();
  private readonly time = new Float32Array(FFT_SIZE);
  private readonly spectrum = new Float32Array(FFT_SIZE / 2);

  constructor(
    private readonly onChange: (s: LoopbackState) => void,
    private readonly deps: { createContext?: () => LoopbackContext; now?: () => number } = {},
  ) {}

  get state(): LoopbackState {
    return { ...this.current };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private emit(patch: Partial<LoopbackState>) {
    this.current = { ...this.current, ...patch };
    this.onChange(this.state);
  }

  /**
   * Plays `track` (the processed microphone track) to the output device at `volume` (1 = 100 %). Refused
   * (false) while the user is in a voice channel.
   */
  async start(track: MediaStreamTrack, opts: { outputDeviceId: string; volume: number }): Promise<boolean> {
    if (this.graph || this.starting) return true;
    if (voiceBusy()) {
      this.emit({ running: false, elapsedMs: 0, feedback: false, stopped: "voice" });
      return false;
    }
    this.starting = true;
    let ctx: LoopbackContext | null = null;
    try {
      ctx = (this.deps.createContext ?? defaultContext)();
      if (opts.outputDeviceId) await ctx.setSinkId?.(opts.outputDeviceId).catch(() => undefined);
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      this.volume = opts.volume;
      gain.gain.value = opts.volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.connect(analyser);
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      // A voice join may have begun meanwhile.
      if (voiceBusy()) {
        source.disconnect();
        gain.disconnect();
        analyser.disconnect();
        await ctx.close().catch(() => undefined);
        this.emit({ running: false, elapsedMs: 0, feedback: false, stopped: "voice" });
        return false;
      }
      this.detector.reset();
      const startedAt = this.now();
      const offVoice = useVoice.subscribe((s) => {
        if (s.status !== "idle") this.stop("voice");
      });
      const timer = setInterval(() => this.poll(), LOOPBACK_POLL_MS);
      this.graph = { ctx, source, gain, analyser, timer, offVoice, startedAt };
      this.emit({ running: true, elapsedMs: 0, feedback: false, stopped: null });
      return true;
    } catch (e) {
      await ctx?.close().catch(() => undefined);
      throw e;
    } finally {
      this.starting = false;
    }
  }

  private poll() {
    const g = this.graph;
    if (!g) return;
    const elapsed = this.now() - g.startedAt;
    if (elapsed >= LOOPBACK_MAX_MS) {
      this.stop("timeout");
      return;
    }
    if (!this.current.feedback) {
      g.analyser.getFloatTimeDomainData(this.time);
      g.analyser.getFloatFrequencyData(this.spectrum);
      if (this.detector.push(dbfs(this.time), tonalShare(this.spectrum, g.ctx.sampleRate, FFT_SIZE), elapsed)) {
        g.gain.gain.value = 0;
        this.emit({ feedback: true, elapsedMs: elapsed });
        return;
      }
    }
    if (Math.floor(elapsed / 1000) !== Math.floor(this.current.elapsedMs / 1000)) this.emit({ elapsedMs: elapsed });
  }

  /** Output volume (1 = 100 %), live; a feedback mute stays until `resume`. */
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.graph && !this.current.feedback) this.graph.gain.gain.value = volume;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.graph?.ctx.setSinkId?.(deviceId).catch(() => undefined);
  }

  /** Unmutes after a suspected feedback (the user put on headphones or turned the speakers down). */
  resume(): void {
    if (!this.graph || !this.current.feedback) return;
    this.detector.reset();
    this.graph.gain.gain.value = this.volume;
    this.emit({ feedback: false });
  }

  stop(reason: LoopbackStopReason): void {
    const g = this.graph;
    if (!g) return;
    this.graph = null;
    clearInterval(g.timer);
    g.offVoice();
    g.source.disconnect();
    g.gain.disconnect();
    g.analyser.disconnect();
    void g.ctx.close().catch(() => undefined);
    this.emit({ running: false, feedback: false, stopped: reason });
  }
}
