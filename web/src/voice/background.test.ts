// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

// The processor package needs browser APIs (WebGL, VideoFrame) at import time in some versions.
vi.mock("@livekit/track-processors", () => ({ BackgroundTransformer: class {}, ProcessorWrapper: class {}, supportsBackgroundProcessors: () => false }));

const { QUALITY, blurRadius, guardSegmenter } = await import("./background");

describe("background effects (design note 4.11)", () => {
  it("maps the blur strength onto the processor's whole radius range", () => {
    expect(blurRadius(0)).toBe(2);
    expect(blurRadius(100)).toBe(64);
    expect(blurRadius(50)).toBe(33);
    expect(blurRadius(-10)).toBe(2);
    expect(blurRadius(500)).toBe(64);
    // Monotonic: a stronger setting never blurs less.
    for (let s = 1; s <= 100; s++) expect(blurRadius(s)).toBeGreaterThanOrEqual(blurRadius(s - 1));
  });

  it("offers a lighter model for weak machines and smoothing for the better levels", () => {
    expect(QUALITY.fast.model).toContain("selfie_segmenter_landscape");
    expect(QUALITY.fast.alpha).toBe(1);
    expect(QUALITY.balanced.model).toContain("selfie_segmenter.tflite");
    expect(QUALITY.high.alpha).toBeLessThan(QUALITY.balanced.alpha);
    expect(QUALITY.high.feather).toBeGreaterThan(QUALITY.balanced.feather);
    // Models come from the node, never from a CDN.
    for (const q of Object.values(QUALITY)) expect(q.model.startsWith("/mediapipe/")).toBe(true);
  });

  it("keeps late frames away from a closed segmenter (MediaPipe's closed graph spins forever and freezes the page)", async () => {
    const real = { segmentForVideo: vi.fn(), close: vi.fn() };
    let release!: () => void;
    const firstFrameShown = new Promise<void>((r) => (release = r));
    // The processor's shape: a frame waits for its first render, then segments; destroy closes the segmenter.
    const transformer = {
      imageSegmenter: real as { segmentForVideo: (...a: unknown[]) => void; close: () => void } | undefined,
      async transform() {
        await firstFrameShown;
        this.imageSegmenter?.segmentForVideo("frame", 0, () => undefined);
      },
      async destroy() {
        await Promise.resolve();
        this.imageSegmenter?.close();
      },
    };
    guardSegmenter(transformer as never);
    const inFlight = transformer.transform();
    await transformer.destroy();
    expect(real.close).toHaveBeenCalledTimes(1);
    release();
    await expect(inFlight).rejects.toThrow("closed");
    expect(real.segmentForVideo).not.toHaveBeenCalled();
    // A second destroy (stopProcessor after the slow-frame switch-off) closes nothing twice.
    await transformer.destroy();
    expect(real.close).toHaveBeenCalledTimes(1);
  });

  it("leaves a running segmenter alone", () => {
    const real = { segmentForVideo: vi.fn(), close: vi.fn() };
    const transformer = { imageSegmenter: real, async destroy() {} };
    guardSegmenter(transformer as never);
    transformer.imageSegmenter.segmentForVideo("frame", 0, () => undefined);
    expect(real.segmentForVideo).toHaveBeenCalledTimes(1);
  });
});
