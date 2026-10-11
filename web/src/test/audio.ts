// SPDX-License-Identifier: Apache-2.0
import type { EngineContext } from "../voice/cues";

/**
 * A recording mock of the AudioContext the cue engine drives: a controllable clock and state, resume and
 * suspend that settle asynchronously (like the browser's), and oscillators whose `ended` the test fires.
 */
export function mockEngineContext(opts: { state?: string; now?: number; resumeWorks?: boolean } = {}) {
  const starts: Array<{ osc: number; at: number }> = [];
  const stops: Array<{ osc: number; at: number }> = [];
  const freqs: number[] = [];
  const peaks: number[] = [];
  const pending: Array<{ id: number; onended: ((ev: Event) => void) | null }> = [];
  const calls: string[] = [];
  let disconnects = 0;
  const param = (onSet?: (v: number) => void, onRamp?: (v: number) => void) => ({
    setValueAtTime: (v: number) => onSet?.(v),
    linearRampToValueAtTime: (v: number) => onRamp?.(v),
    exponentialRampToValueAtTime: () => undefined,
  });
  // Like the browser: the state changes when the promise resolves, not when the call is made.
  const settle = (fn: () => void) => new Promise<void>((resolve) => queueMicrotask(() => (fn(), resolve())));
  let id = 0;
  const ctx = {
    state: opts.state ?? "running",
    currentTime: opts.now ?? 1,
    destination: {},
    createOscillator: () => {
      const o = { id: id++, onended: null as ((ev: Event) => void) | null };
      pending.push(o);
      return Object.assign(o, {
        type: "sine",
        frequency: param((v) => freqs.push(v)),
        connect: () => undefined,
        start: (t: number) => starts.push({ osc: o.id, at: t }),
        stop: (t: number) => stops.push({ osc: o.id, at: t }),
      });
    },
    createGain: () => ({
      gain: param(undefined, (v) => peaks.push(v)),
      connect: () => undefined,
      disconnect: () => {
        disconnects += 1;
      },
    }),
    resume: () => {
      calls.push("resume");
      return settle(() => {
        if (opts.resumeWorks === false) return;
        ctx.state = "running";
        // The clock moves on while the context wakes up.
        ctx.currentTime += 0.05;
      });
    },
    suspend: () => {
      calls.push("suspend");
      return settle(() => {
        ctx.state = "suspended";
      });
    },
    sampleRate: 48000,
    createBuffer: (channels: number, length: number, rate: number) => {
      calls.push(`buffer:${channels}x${length}@${rate}`);
      return {};
    },
    createBufferSource: () => ({
      buffer: null as unknown,
      connect: () => undefined,
      start: () => {
        calls.push("silent");
      },
    }),
    setSinkId: (sink: string) => {
      calls.push(`sink:${sink}`);
      return settle(() => undefined);
    },
  };
  /** Fires `ended` on every oscillator created so far. */
  const endAll = () => {
    for (const o of pending.splice(0)) o.onended?.(new Event("ended"));
  };
  return { ctx: ctx as unknown as EngineContext & { state: string; currentTime: number }, starts, stops, freqs, peaks, calls, endAll, disconnects: () => disconnects };
}
