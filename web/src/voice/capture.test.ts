// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_GRACE_MS, CaptureRelease } from "./capture";

/** A microphone that records what the release logic asks of it. */
function mic() {
  const calls: string[] = [];
  let capturing = true;
  return {
    calls,
    get capturing() {
      return capturing;
    },
    releaseCapture: () => {
      calls.push("release");
      capturing = false;
    },
    reacquireCapture: async () => {
      calls.push("reacquire");
      capturing = true;
    },
  };
}

describe("microphone capture while muted (Android call audio mode)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases the capture after the grace period of a mute and re-acquires it on unmute", async () => {
    const m = mic();
    const c = new CaptureRelease(m);
    await c.setMuted(true);
    expect(m.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS - 1);
    expect(m.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls).toEqual(["release"]);
    expect(m.capturing).toBe(false);
    await c.setMuted(false);
    expect(m.calls).toEqual(["release", "reacquire"]);
    expect(m.capturing).toBe(true);
  });

  it("the Android app keeps the capture while muted (its notification unmutes in the background)", async () => {
    const m = mic();
    const c = new CaptureRelease(m, CAPTURE_GRACE_MS, true);
    await c.setMuted(true);
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS * 10);
    await c.setMuted(false);
    expect(m.calls).toEqual([]);
    expect(m.capturing).toBe(true);
  });

  it("keeps the capture for a quick mute and unmute (instant, no new getUserMedia)", async () => {
    const m = mic();
    const c = new CaptureRelease(m);
    await c.setMuted(true);
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS / 2);
    await c.setMuted(false);
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS * 2);
    expect(m.calls).toEqual([]);
  });

  it("a second mute does not restart the grace period, and nothing runs after close", async () => {
    const m = mic();
    const c = new CaptureRelease(m);
    await c.setMuted(true);
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS - 500);
    await c.setMuted(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(m.calls).toEqual(["release"]);
    const n = mic();
    const d = new CaptureRelease(n);
    await d.setMuted(true);
    d.close();
    await vi.advanceTimersByTimeAsync(CAPTURE_GRACE_MS * 2);
    expect(n.calls).toEqual([]);
  });

  it("the grace period is about two seconds", () => {
    expect(CAPTURE_GRACE_MS).toBeGreaterThanOrEqual(1500);
    expect(CAPTURE_GRACE_MS).toBeLessThanOrEqual(3000);
  });
});
