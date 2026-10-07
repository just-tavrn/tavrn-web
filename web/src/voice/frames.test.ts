// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SlowFrameDetector, WARMUP_MS, markWeakDevice } from "./frames";

function feed(d: SlowFrameDetector, fps: number, processingMs: number, seconds: number, start = 0): boolean {
  let fired = false;
  const step = 1000 / fps;
  for (let t = start; t < start + seconds * 1000; t += step) fired = !!d.push(processingMs, t) || fired;
  return fired;
}

describe("frame-drop detector", () => {
  it("stays quiet while frames fit into the frame interval", () => {
    expect(feed(new SlowFrameDetector(30), 30, 12, 10)).toBe(false);
  });

  it("fires when frames take longer than the interval for a few seconds, with the numbers for the message", () => {
    const d = new SlowFrameDetector(30);
    expect(feed(d, 30, 45, 1)).toBe(false);
    expect(feed(d, 30, 45, 4, 1000)).toBe(true);
    const fresh = new SlowFrameDetector(30);
    let slow = null;
    for (let t = 0; t < 8000 && !slow; t += 33) slow = fresh.push(45, t);
    expect(slow).toEqual({ averageMs: 45, budgetMs: 33, fps: 30 });
  });

  it("ignores a short spike", () => {
    const d = new SlowFrameDetector(30);
    feed(d, 30, 10, 3);
    expect(feed(d, 30, 80, 0.3, 3000)).toBe(false);
    expect(feed(d, 30, 10, 3, 3300)).toBe(false);
  });

  // Regression ("images were lost", design note 4.11): loading the model and compiling the GPU shaders makes the
  // first frames very slow on every machine; that switched the effect off right after it was turned on.
  it("does not judge the warm-up after a start", () => {
    const d = new SlowFrameDetector(30);
    // Model load: a few frames of 600 ms, then a fast device.
    expect(!!d.push(600, 0) || !!d.push(600, 600) || !!d.push(600, 1200)).toBe(false);
    expect(feed(d, 30, 8, 6, 1800)).toBe(false);
    expect(WARMUP_MS).toBeGreaterThanOrEqual(2000);
  });

  it("starts over after a reset (hidden tab)", () => {
    const d = new SlowFrameDetector(30);
    feed(d, 30, 12, 4);
    // Throttled while hidden: slow frames right after coming back are a warm-up again.
    d.reset(4000);
    expect(feed(d, 30, 200, 2, 4000)).toBe(false);
    expect(feed(d, 30, 10, 4, 6000)).toBe(false);
  });

  it("marks the document for static speaking rings", () => {
    markWeakDevice();
    expect(document.documentElement.dataset.weakDevice).toBe("true");
    delete document.documentElement.dataset.weakDevice;
  });
});
