// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

// The processor package needs browser APIs (WebGL, VideoFrame) at import time in some versions.
vi.mock("@livekit/track-processors", () => ({ BackgroundTransformer: class {}, ProcessorWrapper: class {}, supportsBackgroundProcessors: () => false }));

const { QUALITY, blurRadius } = await import("./background");

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
});
