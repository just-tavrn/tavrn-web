// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
/**
 * Notification sounds of voice channels (design note 4.9 "Notification sounds"): short, soft cues synthesized
 * with WebAudio (sine/triangle notes with gentle envelopes, each under 300 ms, no asset files). Played on
 * their own AudioContext on the chosen output device, so they also sound after leaving a call. The ringtone
 * of incoming calls uses the same engine.
 */
import { CUE_NAMES, useVoiceSettings, type Cue, type VoiceSettings } from "./settings";

export const CUES = CUE_NAMES;
export type { Cue };

export interface Note {
  /** Hz. */
  freq: number;
  /** Start offset in seconds. */
  at: number;
  /** Seconds. */
  dur: number;
  type: OscillatorType;
  /** Relative loudness 0…1 (multiplied with the cue volume). */
  gain: number;
  /** Hz at the end of the note: the pitch glides there (a single rising or falling tone). */
  to?: number;
}

const n = (freq: number, at: number, dur: number, gain = 1, type: OscillatorType = "sine"): Note => ({ freq, at, dur, type, gain });
/** One soft sine gliding from `from` to `to` Hz. */
const glide = (from: number, to: number, dur: number, gain: number): Note => ({ ...n(from, 0, dur, gain), to });

/** The notes of every cue (C major, mid register, nothing shrill). */
export const PATTERNS: Record<Cue, Note[]> = {
  // Two rising notes / two falling notes.
  join: [n(523.25, 0, 0.11), n(783.99, 0.1, 0.16)],
  leave: [n(783.99, 0, 0.11), n(523.25, 0.1, 0.16)],
  // A low and a high tick.
  mute: [n(392, 0, 0.07, 0.8, "triangle")],
  unmute: [n(659.25, 0, 0.07, 0.8, "triangle")],
  // Double tick down and up.
  deafen: [n(587.33, 0, 0.06, 0.8, "triangle"), n(440, 0.09, 0.07, 0.8, "triangle")],
  undeafen: [n(440, 0, 0.06, 0.8, "triangle"), n(587.33, 0.09, 0.07, 0.8, "triangle")],
  // A bright short triad and back.
  stream_on: [n(659.25, 0, 0.08, 0.7), n(783.99, 0.07, 0.08, 0.7), n(1046.5, 0.14, 0.12, 0.6)],
  stream_off: [n(1046.5, 0, 0.08, 0.6), n(783.99, 0.07, 0.08, 0.7), n(659.25, 0.14, 0.12, 0.7)],
  // A muted tone, as the plug glyph.
  connection_lost: [n(311.13, 0, 0.24, 0.6, "triangle")],
  connection_restored: [n(392, 0, 0.12, 0.6, "triangle"), n(523.25, 0.11, 0.16, 0.6, "triangle")],
  // Push-to-talk (issue #37): one short, soft tone gliding up when the microphone opens and down when it closes; the
  // priority speaker's sit a fourth higher.
  ptt_on: [glide(440, 587.33, 0.09, 0.5)],
  ptt_off: [glide(587.33, 440, 0.09, 0.45)],
  priority_on: [glide(587.33, 783.99, 0.09, 0.5)],
  priority_off: [glide(783.99, 587.33, 0.09, 0.45)],
};

/** Total length of a cue in seconds. */
export function cueLength(cue: Cue): number {
  return Math.max(...PATTERNS[cue].map((x) => x.at + x.dur));
}

/**
 * Whether a cue plays: not with all cues off or this cue switched off; while deafened only the user's own
 * cues (their own mute, deafen, join, …), nothing about others.
 */
export function cueAllowed(cue: Cue, s: Pick<VoiceSettings, "cuesOff" | "cuesDisabled" | "cueVolume">, opts: { deafened: boolean; own: boolean }): boolean {
  if (s.cuesOff || s.cueVolume <= 0 || s.cuesDisabled.includes(cue)) return false;
  return opts.own || !opts.deafened;
}

/** The parts of an AudioContext the scheduler needs (a mock in tests). */
export interface CueContext {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

/** Where scheduled notes go and who keeps their nodes alive until they ended. */
export interface ScheduleTarget {
  /** Start time on the context clock (never earlier than `currentTime + LEAD`). */
  at?: number;
  /** Output node (default: a fresh gain of this cue on the destination). */
  destination?: AudioNode;
  /** Called with every oscillator (to hold a reference until `ended`). */
  keep?: (osc: OscillatorNode) => void;
}

const ATTACK = 0.012;
/** Minimum distance of a note start from "now": a start in the past would be clipped. */
export const LEAD = 0.02;
/** Silence between two queued cues. */
export const CUE_GAP = 0.03;
/** Cues that would start later than this (a long backlog) are dropped instead of played stale. */
export const MAX_BACKLOG = 0.8;

/** Wraps `onended` so `fn` runs before the handler the node already had. */
function onEnded(osc: OscillatorNode, fn: () => void): void {
  const before = osc.onended;
  osc.onended = function (this: AudioScheduledSourceNode, ev: Event) {
    fn();
    if (typeof before === "function") before.call(this, ev);
  };
}

/**
 * Schedules the notes of a cue with soft envelopes at `volume` (0…1). Every cue gets its own gain node
 * (overlapping cues never share an envelope), disconnected when the cue's last note ended. Returns the
 * number of notes.
 */
export function scheduleCue(ctx: CueContext, cue: Cue, volume: number, target: ScheduleTarget = {}): number {
  const t0 = Math.max(target.at ?? 0, ctx.currentTime + LEAD);
  // Moderate even at full volume: cues sit well below voices.
  const peak = Math.max(0, Math.min(1, volume)) * 0.25;
  const bus = target.destination ? null : ctx.createGain();
  bus?.connect(ctx.destination);
  const out = target.destination ?? bus!;
  let open = PATTERNS[cue].length;
  for (const note of PATTERNS[cue]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.type;
    osc.frequency.setValueAtTime(note.freq, t0 + note.at);
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, t0 + note.at + note.dur);
    gain.gain.setValueAtTime(0, t0 + note.at);
    gain.gain.linearRampToValueAtTime(peak * note.gain, t0 + note.at + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.at + note.dur);
    osc.connect(gain);
    gain.connect(out);
    osc.onended = () => {
      gain.disconnect();
      if (--open === 0) bus?.disconnect();
    };
    target.keep?.(osc);
    osc.start(t0 + note.at);
    osc.stop(t0 + note.at + note.dur + 0.02);
  }
  return PATTERNS[cue].length;
}

/** The AudioContext the cue engine drives (a mock in tests). */
export interface EngineContext extends CueContext {
  /** Safari also knows "interrupted" (phone call, another app took the output). */
  readonly state: string;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  setSinkId?: (id: string) => Promise<void>;
}

/** Resolves when the promise settles or after `ms`, whatever comes first (never rejects). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

interface CueLog {
  played: Array<{ cue: Cue | "ringtone"; own: boolean }>;
  /** What actually reached a running context (development builds, for the UI tests). */
  scheduled: Array<{ cue: Cue | "ringtone"; at: number; state: string }>;
}

function cueLog(): CueLog | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const w = window as { __tavrnCues?: Partial<CueLog> };
  const l = (w.__tavrnCues ??= {});
  l.played ??= [];
  l.scheduled ??= [];
  return l as CueLog;
}

/**
 * One AudioContext for every cue and the ringtone (design note 4.9), created lazily on the first sound and resumed
 * on user gestures (`unlock`). Why cues were sometimes silent or cut off before, and what this does about it:
 * - the context could be suspended (autoplay policy, our own idle suspend, a suspend still in flight when the
 *   next cue came) while a cue was scheduled without waiting: `ready()` waits for a pending suspend, awaits
 *   `resume()` and an output device switch (`setSinkId` cut the first cue off mid-note) before anything is
 *   scheduled, and gives up after a short timeout instead of playing a stale cue much later;
 * - notes start at least `LEAD` after the context's `currentTime` as read after the resume (no start in the
 *   past, which would clip the attack);
 * - every cue has its own gain, oscillators are referenced until `ended`, and cues are queued one after the
 *   other (`CUE_GAP` apart), so overlapping cues never clip each other;
 * - between cues the context sleeps (an idle running context costs CPU), never while a ringtone holds it.
 */
export class CueEngine {
  private ctx: EngineContext | null = null;
  private sink = "";
  private suspending: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** We suspended the context ourselves (not the browser). */
  private sleeping = false;
  /** Context time at which the last queued cue ends. */
  private busyUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly live = new Set<OscillatorNode>();
  /** Ringtones holding the context awake. */
  private holds = 0;

  constructor(
    private readonly make: () => EngineContext | null,
    private readonly opts: { idleMs: number; resumeTimeoutMs: number } = { idleMs: 1500, resumeTimeoutMs: 1000 },
  ) {}

  /** The context, created on first use (null without WebAudio). */
  context(): EngineContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = this.make();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Oscillators still playing or scheduled (tests). */
  get liveNodes(): number {
    return this.live.size;
  }

  /**
   * A user gesture: resume the context if the browser suspended it (autoplay policy: created before any
   * gesture, or interrupted), not while it sleeps between cues on purpose unless a ringtone waits. Nothing is
   * created here: pages that never play a cue never get an AudioContext.
   */
  unlock(): Promise<void> {
    const c = this.ctx;
    if (!c || c.state === "running" || this.suspending) return Promise.resolve();
    if (this.sleeping && this.holds === 0) return Promise.resolve();
    return within(c.resume(), this.opts.resumeTimeoutMs).then(() => {
      if (c.state !== "running") return;
      this.sleeping = false;
      this.armIdle();
    });
  }

  /** A running context on `deviceId` (empty: default output), or null when audio is unavailable or blocked. */
  async ready(deviceId: string): Promise<EngineContext | null> {
    const c = this.context();
    if (!c) return null;
    this.cancelIdle();
    if (this.suspending) await this.suspending;
    if (deviceId !== this.sink && c.setSinkId) {
      this.sink = deviceId;
      await within(c.setSinkId(deviceId), this.opts.resumeTimeoutMs);
    }
    if (c.state !== "running") await within(c.resume(), this.opts.resumeTimeoutMs);
    if (c.state !== "running") return null;
    this.sleeping = false;
    return c;
  }

  /** Queues a cue; resolves with whether it was scheduled on a running context. */
  play(cue: Cue, volume: number, deviceId: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const c = await this.ready(deviceId);
      if (!c) {
        this.armIdle();
        return false;
      }
      const now = c.currentTime;
      const at = Math.max(now + LEAD, this.busyUntil > 0 ? this.busyUntil + CUE_GAP : 0);
      if (at - now > MAX_BACKLOG) {
        this.armIdle();
        return false;
      }
      scheduleCue(c, cue, volume, { at, keep: (osc) => this.keep(osc) });
      this.busyUntil = at + cueLength(cue);
      cueLog()?.scheduled.push({ cue, at, state: c.state });
      this.armIdle();
      return true;
    };
    const p = this.chain.then(run, run).catch(() => false);
    this.chain = p;
    return p;
  }

  /** Holds a reference to a scheduled oscillator until it ended (no early garbage collection). */
  keep(osc: OscillatorNode): void {
    this.live.add(osc);
    onEnded(osc, () => this.live.delete(osc));
  }

  /** A ringtone keeps the context awake until `release`. */
  hold(): void {
    this.holds += 1;
    this.cancelIdle();
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.armIdle();
  }

  private cancelIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Suspends the context `idleMs` after the last scheduled sound ended. */
  private armIdle(): void {
    this.cancelIdle();
    const c = this.ctx;
    if (!c || this.holds > 0) return;
    const remaining = Math.max(0, this.busyUntil - c.currentTime);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.holds > 0 || c.state !== "running") return;
      this.sleeping = true;
      this.suspending = within(c.suspend(), this.opts.resumeTimeoutMs).finally(() => {
        this.suspending = null;
      });
    }, remaining * 1000 + this.opts.idleMs);
  }
}

/** The engine of the app (one AudioContext on the chosen output device). */
export const cueEngine = new CueEngine(() => (typeof AudioContext === "undefined" ? null : (new AudioContext({ latencyHint: "interactive" }) as unknown as EngineContext)));

let unlockInstalled = false;

/**
 * Resumes the cue context on user gestures (autoplay policies only let a context start or resume with user
 * activation; Safari needs it inside the gesture). Installed once when this module loads.
 */
export function installCueUnlock(target: Pick<Window, "addEventListener"> | undefined = typeof window === "undefined" ? undefined : window, engine: CueEngine = cueEngine): void {
  if (!target) return;
  if (engine === cueEngine) {
    if (unlockInstalled) return;
    unlockInstalled = true;
  }
  const onGesture = () => void engine.unlock();
  for (const type of ["pointerdown", "keydown", "touchend"]) target.addEventListener(type, onGesture, { capture: true, passive: true });
}
installCueUnlock();

/** Plays a cue if the settings allow it (`own`: about the user's own action or connection). */
export function playCue(cue: Cue, opts: { own: boolean; deafened: boolean }): void {
  const s = useVoiceSettings.getState().settings;
  if (!cueAllowed(cue, s, opts)) return;
  cueLog()?.played.push({ cue, own: opts.own });
  void previewCue(cue, s);
}

/** Plays a cue regardless of the on/off switches (settings preview); resolves with whether it sounded. */
export function previewCue(cue: Cue, s: Pick<VoiceSettings, "cueVolume" | "outputDeviceId"> = useVoiceSettings.getState().settings, engine: CueEngine = cueEngine): Promise<boolean> {
  // No audio output: cues are optional.
  return engine.play(cue, s.cueVolume / 100, s.outputDeviceId).catch(() => false);
}

// ---------------------------------------------------------------- ringtone of incoming calls

/** Length of one loop of the ringtone in seconds (two bars of four beats at 100 bpm). */
export const RING_LOOP = 2.4;

/**
 * The ringtone (design note 4.11): a friendly two-bar motif in C major pentatonic (no semitones, nothing
 * shrill), each note a soft sine with a quiet octave on top for a bell-like colour, then a rest before the
 * loop repeats. Group calls get a gentler, lower variant with fewer notes.
 */
export const RINGTONES: Record<"direct" | "group", Note[]> = {
  direct: [
    // Bar 1: rising G–C–E–G, bar 2: falling E–D and a long C.
    n(392.0, 0.0, 0.26, 0.85),
    n(523.25, 0.3, 0.26, 0.9),
    n(659.25, 0.6, 0.26, 0.95),
    n(783.99, 0.9, 0.34, 1),
    n(659.25, 1.2, 0.26, 0.9),
    n(587.33, 1.5, 0.26, 0.85),
    n(523.25, 1.8, 0.46, 0.85),
  ],
  group: [
    n(261.63, 0.0, 0.32, 0.7),
    n(329.63, 0.3, 0.32, 0.7),
    n(392.0, 0.6, 0.42, 0.75),
    n(329.63, 1.2, 0.32, 0.65),
    n(261.63, 1.5, 0.5, 0.65),
  ],
};

/**
 * Schedules one loop of a ringtone at `t0` (seconds on the context's clock) into `destination` (default:
 * the context's destination); returns the number of notes.
 */
export function scheduleRingLoop(
  ctx: CueContext,
  variant: "direct" | "group",
  volume: number,
  t0: number,
  destination: AudioNode = ctx.destination,
  keep?: (osc: OscillatorNode) => void,
): number {
  // Moderate: louder than a cue (it has to be noticed), far from an alarm.
  const peak = Math.max(0, Math.min(1, volume)) * 0.3;
  const notes = RINGTONES[variant];
  for (const note of notes) {
    for (const [mult, share] of [
      [1, 1],
      [2, 0.18],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(note.freq * mult, t0 + note.at);
      gain.gain.setValueAtTime(0, t0 + note.at);
      gain.gain.linearRampToValueAtTime(peak * note.gain * share, t0 + note.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.at + note.dur);
      osc.connect(gain);
      gain.connect(destination);
      osc.onended = () => gain.disconnect();
      keep?.(osc);
      osc.start(t0 + note.at);
      osc.stop(t0 + note.at + note.dur + 0.03);
    }
  }
  return notes.length;
}

let ringing: { stop: () => void } | null = null;

/**
 * Starts the ringtone (looping until stopped; one at a time). Returns the stop function. Uses the cue engine
 * (same context, output device, resume and unlock handling), which stays awake while it rings. With the ring
 * volume at 0 it stays silent.
 */
export function startRingtone(
  variant: "direct" | "group",
  s: Pick<VoiceSettings, "ringVolume" | "outputDeviceId"> = useVoiceSettings.getState().settings,
  engine: CueEngine = cueEngine,
): () => void {
  ringing?.stop();
  cueLog()?.played.push({ cue: "ringtone", own: false });
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let bus: GainNode | null = null;
  let ctx: EngineContext | null = null;
  let next = 0;
  const oscs = new Set<OscillatorNode>();
  const audible = s.ringVolume > 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (ctx && bus) {
      // A short fade instead of a click, then everything scheduled ahead is cancelled.
      const now = ctx.currentTime;
      const out = bus;
      out.gain.setValueAtTime(out.gain.value ?? 1, now);
      out.gain.linearRampToValueAtTime(0, now + 0.05);
      for (const osc of oscs) {
        try {
          osc.stop(now + 0.06);
        } catch {
          /* already stopped */
        }
      }
      setTimeout(() => out.disconnect(), 120);
    }
    oscs.clear();
    if (ringing?.stop === stop) ringing = null;
    if (audible) engine.release();
  };
  ringing = { stop };
  if (!audible) return stop;
  engine.hold();
  const loop = async () => {
    const c = await engine.ready(s.outputDeviceId);
    // Blocked until the next user gesture (autoplay policy): the next tick tries again.
    if (!c || stopped) return;
    if (!bus) {
      ctx = c;
      bus = c.createGain();
      bus.connect(c.destination);
      next = c.currentTime + LEAD;
    }
    // Keep about one loop scheduled ahead; timers in background tabs may be late (never schedule into the past).
    next = Math.max(next, c.currentTime + LEAD);
    while (next < c.currentTime + RING_LOOP) {
      scheduleRingLoop(c, variant, s.ringVolume / 100, next, bus, (osc) => {
        oscs.add(osc);
        engine.keep(osc);
        onEnded(osc, () => oscs.delete(osc));
      });
      cueLog()?.scheduled.push({ cue: "ringtone", at: next, state: c.state });
      next += RING_LOOP;
    }
  };
  void loop();
  timer = setInterval(() => void loop(), 500);
  return stop;
}

/** Stops whatever ringtone plays. */
export function stopRingtone(): void {
  ringing?.stop();
}

/** Whether a ringtone is playing (tests, the call banner). */
export function ringtonePlaying(): boolean {
  return ringing !== null;
}
