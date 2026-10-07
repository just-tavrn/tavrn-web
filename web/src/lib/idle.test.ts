// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_DEFAULT, createIdleDetector, idleTimeoutMs, markActive, normalizeIdleMinutes, throttledActivity, useIdleSettings } from "./idle";

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    visibilityState: "visible" as DocumentVisibilityState,
  };
}

describe("idle detection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes idle after the timeout without input and back on input", () => {
    const target = fakeTarget();
    const doc = fakeTarget();
    const onIdle = vi.fn();
    const onActive = vi.fn();
    const d = createIdleDetector({ timeoutMs: 10_000, onIdle, onActive, target: target as never, doc: doc as never });
    vi.advanceTimersByTime(9_000);
    target.fire("keydown"); // more than a second after arming: re-armed
    vi.advanceTimersByTime(9_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_100);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(d.idle).toBe(true);
    target.fire("pointermove");
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(d.idle).toBe(false);
    // Idle again after another full timeout.
    vi.advanceTimersByTime(10_001);
    expect(onIdle).toHaveBeenCalledTimes(2);
    d.stop();
    expect(target.count() + doc.count()).toBe(0);
  });

  it("a tab becoming visible counts as activity, a hidden one keeps counting", () => {
    const target = fakeTarget();
    const doc = fakeTarget();
    const onIdle = vi.fn();
    const onActive = vi.fn();
    const d = createIdleDetector({ timeoutMs: 1_000, onIdle, onActive, target: target as never, doc: doc as never });
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    vi.advanceTimersByTime(1_500);
    expect(onIdle).toHaveBeenCalledTimes(1);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(onActive).toHaveBeenCalledTimes(1);
    d.stop();
  });

  it("talking in voice counts as activity (markActive), throttled to once per 30 s", () => {
    const target = fakeTarget();
    const doc = fakeTarget();
    const onIdle = vi.fn();
    const onActive = vi.fn();
    const d = createIdleDetector({ timeoutMs: 60_000, onIdle, onActive, target: target as never, doc: doc as never });
    const talking = throttledActivity(30_000);
    // Talking continuously for three minutes without touching anything: never idle.
    for (let t = 0; t < 180_000; t += 1_000) {
      talking();
      vi.advanceTimersByTime(1_000);
    }
    expect(onIdle).not.toHaveBeenCalled();
    // Silence: idle after the timeout; talking again wakes the device.
    vi.advanceTimersByTime(60_001);
    expect(onIdle).toHaveBeenCalledTimes(1);
    markActive();
    expect(onActive).toHaveBeenCalledTimes(1);
    d.stop();
    // Stopped detectors are not reached any more.
    markActive();
    expect(onActive).toHaveBeenCalledTimes(1);
    const mark = vi.fn();
    const throttled = throttledActivity(30_000, mark);
    expect([throttled(0), throttled(10_000), throttled(29_999), throttled(30_000)]).toEqual([true, false, false, true]);
    expect(mark).toHaveBeenCalledTimes(2);
  });

  it("idle timeout setting: 5/10/15/30 minutes or never, default 10, kept per device", () => {
    expect(normalizeIdleMinutes("15")).toBe(15);
    expect(normalizeIdleMinutes(0)).toBe(0);
    expect(normalizeIdleMinutes(7)).toBe(IDLE_DEFAULT);
    expect(normalizeIdleMinutes(null)).toBe(10);
    expect(idleTimeoutMs(5)).toBe(300_000);
    expect(idleTimeoutMs(0)).toBeNull();
    useIdleSettings.getState().setMinutes(30);
    expect(localStorage.getItem("tavrn.idle.minutes")).toBe("30");
    expect(useIdleSettings.getState().minutes).toBe(30);
    useIdleSettings.getState().setMinutes(10);
  });
});
