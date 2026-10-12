// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The RNNoise package extends AudioWorkletNode at import time (not in jsdom); these tests run without RNNoise.
vi.mock("@sapphi-red/web-noise-suppressor", () => ({ RnnoiseWorkletNode: class {}, loadRnnoise: vi.fn() }));

import { MicPipeline } from "./audio";
import { DEFAULT_SETTINGS } from "./settings";

/** Fakes of the Web Audio graph and getUserMedia: enough to see what the pipeline captures and when it stops. */
function fakes() {
  const captures: Array<{ constraints: MediaTrackConstraints; track: { readyState: string; stop: () => void; getSettings: () => MediaTrackSettings } }> = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } });
  class FakeContext {
    state = "running";
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    createGain = () => node();
    createMediaStreamSource = vi.fn(() => node());
    createMediaStreamDestination = () => {
      const published = { id: "published", stop: vi.fn() };
      return { ...node(), stream: { getAudioTracks: () => [published], getTracks: () => [published] } };
    };
    resume = vi.fn(async () => {
      this.state = "running";
    });
    suspend = vi.fn(async () => {
      this.state = "suspended";
    });
    close = vi.fn(async () => {
      this.state = "closed";
    });
  }
  class FakeWorkletNode {
    port = { postMessage: vi.fn(), onmessage: null as unknown };
    connect = vi.fn();
    disconnect = vi.fn();
  }
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    const track = {
      readyState: "live",
      stop() {
        track.readyState = "ended";
      },
      getSettings: () => ({ channelCount: 1 }),
    };
    captures.push({ constraints: c.audio as MediaTrackConstraints, track });
    return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  return { captures, getUserMedia };
}

describe("MicPipeline: releasing the capture while muted", () => {
  let f: ReturnType<typeof fakes>;
  beforeEach(() => {
    f = fakes();
  });
  afterEach(() => vi.unstubAllGlobals());

  const settings = { ...DEFAULT_SETTINGS, noiseSuppression: "off" as const, echoCancellation: true, inputDeviceId: "mic-2" };

  it("stops the getUserMedia track and re-acquires one with the same constraints and device", async () => {
    const p = await MicPipeline.create(settings);
    expect(f.captures).toHaveLength(1);
    const published = p.track;
    expect(p.capturing).toBe(true);
    p.releaseCapture();
    expect(f.captures[0]!.track.readyState).toBe("ended");
    expect(p.capturing).toBe(false);
    expect(p.inputTrack).toBeNull();
    await p.reacquireCapture();
    expect(f.captures).toHaveLength(2);
    expect(f.captures[1]!.constraints).toEqual(f.captures[0]!.constraints);
    expect(f.captures[1]!.constraints.deviceId).toEqual({ exact: "mic-2" });
    expect(f.captures[1]!.constraints.echoCancellation).toBe(true);
    expect(p.capturing).toBe(true);
    // The published track never changes (nothing to republish).
    expect(p.track).toBe(published);
    // Re-acquiring while capturing does nothing.
    await p.reacquireCapture();
    expect(f.captures).toHaveLength(2);
    await p.close();
  });

  it("does not open the microphone for changed settings while released; the next re-acquire uses them", async () => {
    const p = await MicPipeline.create(settings);
    p.releaseCapture();
    await p.apply({ ...settings, echoCancellation: false });
    expect(f.captures).toHaveLength(1);
    expect(p.capturing).toBe(false);
    await p.reacquireCapture();
    expect(f.captures).toHaveLength(2);
    expect(f.captures[1]!.constraints.echoCancellation).toBe(false);
    await p.close();
  });

  it("a release while a re-acquire is still waiting for getUserMedia wins (no live microphone left behind)", async () => {
    const p = await MicPipeline.create(settings);
    p.releaseCapture();
    const pending = p.reacquireCapture();
    p.releaseCapture();
    await pending;
    expect(p.capturing).toBe(false);
    expect(f.captures.at(-1)!.track.readyState).toBe("ended");
    await p.close();
  });

  it("push-to-talk only closes the gate: the capture stays open between key presses (no getUserMedia per press)", async () => {
    vi.useFakeTimers();
    const p = await MicPipeline.create({ ...settings, inputMode: "ptt", pttReleaseMs: 100 });
    p.setPtt(true);
    p.setPtt(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.capturing).toBe(true);
    expect(f.captures).toHaveLength(1);
    expect(f.captures[0]!.track.readyState).toBe("live");
    vi.useRealTimers();
    await p.close();
  });
});
