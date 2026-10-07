// SPDX-License-Identifier: Apache-2.0
/**
 * Frame-drop detector (design note 4.9, §4.5 item 6): a background effect whose frames take longer than the
 * camera's frame interval drops frames. When that holds on average over a few seconds the machine is
 * "weak": the effect is turned off and speaking indicators fall back to a static ring.
 *
 * The first seconds after the effect starts are not judged: loading the segmentation model and compiling
 * its GPU shaders makes the first frames take hundreds of milliseconds on any machine, which used to switch
 * the effect off right after it was turned on ("the device dropped frames"). The caller resets the detector
 * while the tab is hidden (throttled timers and GPU say nothing about the device).
 */

/** What the detector measured when it fired (for the message). */
export interface SlowFrames {
  /** Average processing time per frame (ms). */
  averageMs: number;
  /** The frame interval at the camera's frame rate (ms). */
  budgetMs: number;
  fps: number;
}

/** Frames of the first 2.5 seconds after a start or reset are not judged. */
export const WARMUP_MS = 2500;

export class SlowFrameDetector {
  private samples: Array<{ at: number; ms: number }> = [];
  private readonly budgetMs: number;
  private readonly fps: number;
  private since: number | null = null;

  constructor(
    fps: number,
    private readonly windowMs = 3000,
    private readonly minFrames = 20,
  ) {
    this.fps = Math.max(1, Math.min(60, fps || 30));
    this.budgetMs = 1000 / this.fps;
  }

  /** Starts over (the tab was hidden, the effect restarted): the next frames are a warm-up again. */
  reset(now: number): void {
    this.samples = [];
    this.since = now;
  }

  /** Adds one processed frame; returns the measurement when the recent frames were too slow on average. */
  push(processingMs: number, now: number): SlowFrames | null {
    this.since ??= now;
    if (now - this.since < WARMUP_MS) return null;
    this.samples.push({ at: now, ms: processingMs });
    while (this.samples.length && this.samples[0]!.at < now - this.windowMs) this.samples.shift();
    if (this.samples.length < this.minFrames) return null;
    // Only judge a window that is (almost) full, so the first slow frames after start-up do not count.
    if (now - this.samples[0]!.at < this.windowMs * 0.6) return null;
    const avg = this.samples.reduce((sum, s) => sum + s.ms, 0) / this.samples.length;
    if (avg <= this.budgetMs * 0.9) return null;
    return { averageMs: Math.round(avg), budgetMs: Math.round(this.budgetMs), fps: this.fps };
  }
}

/** Marks this device as weak: CSS shows static speaking rings (see styles.css `[data-weak-device]`). */
export function markWeakDevice(): void {
  document.documentElement.dataset.weakDevice = "true";
}
