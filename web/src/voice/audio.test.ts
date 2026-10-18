// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The RNNoise package extends AudioWorkletNode at import time (not in jsdom); these tests run without RNNoise.
vi.mock("@sapphi-red/web-noise-suppressor", () => ({ RnnoiseWorkletNode: class {}, loadRnnoise: vi.fn() }));

import { MicPipeline } from "./audio";
import { DEFAULT_SETTINGS } from "./settings";

/** Fakes of the Web Audio graph and getUserMedia: enough to see what the pipeline captures and when it stops. */
function fakes() {
  const captures: Array<{ constraints: MediaTrackConstraints; track: { readyState: string; stop: () => void; getSettings: () => MediaTrackSettings } }> = [];
  type GraphNode = { outputs: GraphNode[]; gain?: { value: number } };
  const destinations: GraphNode[] = [];
  const gates: GraphNode[] = [];
  const node = () => {
    const outputs: GraphNode[] = [];
    return { outputs, connect: vi.fn((to: GraphNode) => outputs.push(to)), disconnect: vi.fn(), gain: { value: 1 } };
  };
  class FakeContext {
    state = "running";
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    createGain = () => node();
    createMediaStreamSource = vi.fn(() => node());
    createMediaStreamDestination = () => {
      const published = { id: "published", stop: vi.fn() };
      const dest = { ...node(), stream: { getAudioTracks: () => [published], getTracks: () => [published] } };
      destinations.push(dest);
      return dest;
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
    outputs: GraphNode[] = [];
    constructor() { gates.push(this); }
    connect = vi.fn((to: GraphNode) => this.outputs.push(to));
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
  const routeGain = (from: GraphNode, to: GraphNode): number => {
    if (from === to) return 1;
    return (from.gain?.value ?? 1) * (from.outputs ?? []).reduce((sum, next) => sum + routeGain(next, to), 0);
  };
  return { captures, getUserMedia, routeGain: (destination: number) => routeGain(gates[0]!, destinations[destination]!) };
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

describe("whisper destination", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shares capture but has a separate stable, closable output stopped on cleanup", async () => {
    const f = fakes();
    const p = await MicPipeline.create({ ...DEFAULT_SETTINGS, noiseSuppression: "off" });
    expect(f.captures).toHaveLength(1);
    expect(p.whisperTrack).not.toBe(p.track);
    const track = p.whisperTrack;
    p.setWhisper(true); p.setWhisper(false);
    expect(p.whisperTrack).toBe(track);
    await p.close();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});


it("a whisper-only PTT hold has no release tail into the normal microphone destination", async () => {
  const f = fakes();
  const p = await MicPipeline.create({ ...DEFAULT_SETTINGS, inputMode: "ptt", pttReleaseMs: 2000, noiseSuppression: "off" });
  p.setWhisperHeld(true); p.setWhisper(true);
  expect(f.routeGain(0)).toBe(0); expect(f.routeGain(1)).toBe(1);
  p.setWhisper(false); p.setWhisperHeld(false);
  expect(f.routeGain(0)).toBe(0); expect(f.routeGain(1)).toBe(0);
  p.setPtt(true); expect(f.routeGain(0)).toBe(1);
  await p.close(); vi.unstubAllGlobals();
});

it("closes normal microphone audio during a recipient transition and restores it afterward", async () => {
  const f = fakes();
  const p = await MicPipeline.create({ ...DEFAULT_SETTINGS, noiseSuppression: "off" });
  expect(f.routeGain(0)).toBe(1);
  p.setWhisperTransition(true);
  expect(f.routeGain(0)).toBe(0); expect(f.routeGain(1)).toBe(0);
  p.setWhisperTransition(false); expect(f.routeGain(0)).toBe(1);
  await p.close(); vi.unstubAllGlobals();
});
