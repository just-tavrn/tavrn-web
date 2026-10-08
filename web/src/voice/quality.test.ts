// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { MUSIC_KBPS, PRESETS, captureFor, clampCustom, isMusic, micPublishOptions, presetChoices, presetOf, stereoCapture, trafficMbPerHour } from "./quality";

describe("quality presets (VOICE.md §4a)", () => {
  it("are Saver 8, Standard 32, High 64, Studio 128 and Music 192 (stereo)", () => {
    expect(PRESETS.map((p) => [p.id, p.kbps, p.stereo])).toEqual([
      ["saver", 8, false],
      ["standard", 32, false],
      ["high", 64, false],
      ["studio", 128, false],
      ["music", 192, true],
    ]);
    expect(MUSIC_KBPS).toBe(192);
  });

  it("maps a bitrate to its preset, any other value to custom", () => {
    expect(presetOf(8)).toBe("saver");
    expect(presetOf(32)).toBe("standard");
    expect(presetOf(64)).toBe("high");
    expect(presetOf(128)).toBe("studio");
    expect(presetOf(192)).toBe("music");
    expect(presetOf(96)).toBe("custom");
    expect(presetOf(256)).toBe("custom");
  });

  it("music mode starts at 192 kbps (the preset and larger custom values)", () => {
    expect(isMusic(191)).toBe(false);
    expect(isMusic(128)).toBe(false);
    expect(isMusic(192)).toBe(true);
    expect(isMusic(320)).toBe(true);
  });

  it("marks presets above the node's cap as limited by the node", () => {
    expect(presetChoices(192).filter((c) => c.limited)).toEqual([]);
    expect(presetChoices(128).filter((c) => c.limited).map((c) => c.id)).toEqual(["music"]);
    expect(presetChoices(96).filter((c) => c.limited).map((c) => c.id)).toEqual(["studio", "music"]);
    expect(presetChoices(8).filter((c) => !c.limited).map((c) => c.id)).toEqual(["saver"]);
    // Unknown cap (node info not loaded): nothing is limited, the node still refuses too much.
    expect(presetChoices(null).some((c) => c.limited)).toBe(false);
  });

  it("keeps custom values inside 8 … cap (512 without a known cap)", () => {
    expect(clampCustom(4, 192)).toBe(8);
    expect(clampCustom(150, 192)).toBe(150);
    expect(clampCustom(300, 192)).toBe(192);
    expect(clampCustom(600, null)).toBe(512);
    expect(clampCustom(Number.NaN, 192)).toBe(64);
    expect(clampCustom(99.6, 192)).toBe(100);
  });

  it("estimates the traffic per hour, speaker and listener", () => {
    expect(trafficMbPerHour(192)).toBe(86);
    expect(trafficMbPerHour(64)).toBe(29);
    expect(trafficMbPerHour(8)).toBe(4);
  });
});

describe("capture and publishing (mono/stereo rule)", () => {
  const user = { ...DEFAULT_SETTINGS, inputDeviceId: "mic1", echoCancellation: true, autoGain: true, noiseSuppression: "browser" as const };

  it("speech keeps the user's processing and a mono capture", () => {
    const c = captureFor(user, false);
    expect(c).toMatchObject({ deviceId: { exact: "mic1" }, echoCancellation: true, autoGainControl: true, noiseSuppression: true, channelCount: 1, sampleRate: 48000 });
  });

  it("music turns the microphone processing off and asks for two channels without insisting", () => {
    const c = captureFor(user, true);
    expect(c).toMatchObject({ deviceId: { exact: "mic1" }, echoCancellation: false, autoGainControl: false, noiseSuppression: false, channelCount: { ideal: 2 }, sampleRate: 48000 });
  });

  it("is stereo only in music mode and only when the device really delivers two channels", () => {
    expect(stereoCapture(true, { channelCount: 2 })).toBe(true);
    expect(stereoCapture(true, { channelCount: 1 })).toBe(false);
    expect(stereoCapture(true, {})).toBe(false);
    expect(stereoCapture(true, undefined)).toBe(false);
    expect(stereoCapture(false, { channelCount: 2 })).toBe(false);
  });

  it("publishes speech mono with DTX, RED off and the channel bitrate", () => {
    expect(micPublishOptions(64, { music: false, stereo: false })).toEqual({ audioPreset: { maxBitrate: 64_000 }, dtx: true, red: false, forceStereo: false, stopMicTrackOnMute: false });
  });

  it("publishes music without DTX, stereo only for a stereo capture (a mono microphone stays in the middle)", () => {
    expect(micPublishOptions(192, { music: true, stereo: true })).toEqual({ audioPreset: { maxBitrate: 192_000 }, dtx: false, red: false, forceStereo: true, stopMicTrackOnMute: false });
    expect(micPublishOptions(192, { music: true, stereo: false })).toMatchObject({ dtx: false, forceStereo: false });
    // A stereo flag without music mode never publishes stereo.
    expect(micPublishOptions(64, { music: false, stereo: true })).toMatchObject({ dtx: true, forceStereo: false });
  });
});
