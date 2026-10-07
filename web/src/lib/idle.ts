// SPDX-License-Identifier: Apache-2.0
/**
 * Idle detection (design note 4.9): after `timeoutMs` without input (pointer, keys, wheel, touch) the device
 * counts as idle; any input, or the tab becoming visible again, makes it active. A hidden tab keeps
 * counting down, so a forgotten background tab goes idle too. Talking in a voice channel counts as
 * activity as well (`markActive`, called by the voice session, design note 4.13 item 3). The timeout is a
 * per-device setting (5/10/15/30 minutes or never, default 10).
 */
import { create } from "zustand";

export const IDLE_AFTER_MS = 10 * 60_000;

/** Choices of the idle timeout in minutes; 0 = never. */
export const IDLE_CHOICES = [5, 10, 15, 30, 0] as const;
export type IdleMinutes = (typeof IDLE_CHOICES)[number];
export const IDLE_DEFAULT: IdleMinutes = 10;
export const IDLE_KEY = "tavrn.idle.minutes";

/** A stored value, or the default for anything unknown. */
export function normalizeIdleMinutes(raw: unknown): IdleMinutes {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return IDLE_CHOICES.includes(n as IdleMinutes) ? (n as IdleMinutes) : IDLE_DEFAULT;
}

/** The detector timeout for a setting; null = never idle. */
export function idleTimeoutMs(minutes: IdleMinutes): number | null {
  return minutes === 0 ? null : minutes * 60_000;
}

function loadMinutes(): IdleMinutes {
  try {
    return normalizeIdleMinutes(localStorage.getItem(IDLE_KEY));
  } catch {
    return IDLE_DEFAULT;
  }
}

export const useIdleSettings = create<{ minutes: IdleMinutes; setMinutes: (m: IdleMinutes) => void }>((set) => ({
  minutes: loadMinutes(),
  setMinutes: (m) => {
    const minutes = normalizeIdleMinutes(m);
    try {
      localStorage.setItem(IDLE_KEY, String(minutes));
    } catch {
      /* storage disabled: the setting holds for this session */
    }
    set({ minutes });
  },
}));

/** Running detectors (one per signed-in client); `markActive` reaches them. */
const detectors = new Set<() => void>();

/** Activity that is not input (talking in voice): resets the idle timer, wakes an idle device. */
export function markActive(): void {
  for (const activity of detectors) activity();
}

/** Calls `markActive` at most once per `intervalMs` (the voice session reports talking continuously). */
export function throttledActivity(intervalMs = 30_000, mark: () => void = markActive): (now?: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (now = Date.now()) => {
    if (now - last < intervalMs) return false;
    last = now;
    mark();
    return true;
  };
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export interface IdleDetector {
  /** `true` while idle. */
  readonly idle: boolean;
  stop: () => void;
}

export interface IdleOptions {
  timeoutMs?: number;
  onIdle: () => void;
  onActive: () => void;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

export function createIdleDetector({ timeoutMs = IDLE_AFTER_MS, onIdle, onActive, target = window, doc = document }: IdleOptions): IdleDetector {
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Input events come in bursts: re-arm the timer at most once per second.
  let lastArm = 0;
  const arm = () => {
    if (timer) clearTimeout(timer);
    lastArm = Date.now();
    timer = setTimeout(() => {
      idle = true;
      onIdle();
    }, timeoutMs);
  };
  const activity = () => {
    if (idle) {
      idle = false;
      onActive();
      arm();
      return;
    }
    if (Date.now() - lastArm >= 1000) arm();
  };
  const visibility = () => {
    if (doc.visibilityState === "visible") activity();
  };
  for (const e of INPUT_EVENTS) target.addEventListener(e, activity, { passive: true });
  doc.addEventListener("visibilitychange", visibility);
  detectors.add(activity);
  arm();
  return {
    get idle() {
      return idle;
    },
    stop: () => {
      detectors.delete(activity);
      if (timer) clearTimeout(timer);
      for (const e of INPUT_EVENTS) target.removeEventListener(e, activity);
      doc.removeEventListener("visibilitychange", visibility);
    },
  };
}
