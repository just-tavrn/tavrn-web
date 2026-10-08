// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY, captureConstraints, cameraOptions, gateThreshold, limitResolution, normalizeSettings, resolutionSize, useVoiceSettings } from "./settings";

describe("voice & video settings (design note 4.9)", () => {
  beforeEach(() => {
    localStorage.clear();
    useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
  });

  it("falls back to defaults for missing or invalid values", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    const s = normalizeSettings({ inputVolume: 999, vadThreshold: -500, noiseSuppression: "krisp", inputMode: "ptt", pttReleaseMs: "x", mirror: false, userVolumes: { "a@n": 50, "b@n": -3, "c@n": "x" } });
    expect(s.inputVolume).toBe(200);
    expect(s.vadThreshold).toBe(-100);
    expect(s.noiseSuppression).toBe(DEFAULT_SETTINGS.noiseSuppression);
    expect(s.inputMode).toBe("ptt");
    expect(s.pttReleaseMs).toBe(DEFAULT_SETTINGS.pttReleaseMs);
    expect(s.mirror).toBe(false);
    expect(s.userVolumes).toEqual({ "a@n": 50, "b@n": 0 });
  });

  it("the priority speaker key defaults to none and keeps a key code (design note 4.13 item 3)", () => {
    expect(DEFAULT_SETTINGS.priorityKey).toBe("");
    expect(normalizeSettings({ priorityKey: "KeyV" }).priorityKey).toBe("KeyV");
    expect(normalizeSettings({ priorityKey: 5 }).priorityKey).toBe("");
    expect(normalizeSettings({ priorityKey: "x".repeat(65) }).priorityKey).toBe("");
  });

  it("only keeps a background image that is a data: URL of an image", () => {
    expect(normalizeSettings({ backgroundImage: "data:image/jpeg;base64,AAAA" }).backgroundImage).toBe("data:image/jpeg;base64,AAAA");
    expect(normalizeSettings({ backgroundImage: "https://evil.example/x.png" }).backgroundImage).toBeNull();
    expect(normalizeSettings({ backgroundImage: "javascript:alert(1)" }).backgroundImage).toBeNull();
    expect(normalizeSettings({ background: "image", backgroundImage: null }).background).toBe("none");
  });

  it("keeps blur strength and segmentation quality within their range", () => {
    expect(normalizeSettings({}).blurStrength).toBe(60);
    expect(normalizeSettings({}).backgroundQuality).toBe("balanced");
    expect(normalizeSettings({ blurStrength: 140, backgroundQuality: "high" })).toMatchObject({ blurStrength: 100, backgroundQuality: "high" });
    expect(normalizeSettings({ blurStrength: -5, backgroundQuality: "ultra" })).toMatchObject({ blurStrength: 0, backgroundQuality: "balanced" });
  });

  it("persists per device and survives a reload", () => {
    useVoiceSettings.getState().update({ noiseSuppression: "rnnoise", vadThreshold: -42 });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).noiseSuppression).toBe("rnnoise");
    useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
    useVoiceSettings.getState().reload();
    expect(useVoiceSettings.getState().settings.vadThreshold).toBe(-42);
    useVoiceSettings.getState().setUserVolume("bob@n", 150);
    expect(useVoiceSettings.getState().settings.userVolumes["bob@n"]).toBe(150);
    useVoiceSettings.getState().setUserVolume("bob@n", 100);
    expect(useVoiceSettings.getState().settings.userVolumes["bob@n"]).toBeUndefined();
  });

  it("derives the gate threshold from voice activation and the noise gate", () => {
    const base = { ...DEFAULT_SETTINGS, vadThreshold: -50, gateThreshold: -60 };
    expect(gateThreshold({ ...base, inputMode: "vad", noiseGate: false })).toBe(-50);
    // The higher of the two wins: the gate never lets through what voice activation would cut.
    expect(gateThreshold({ ...base, inputMode: "vad", noiseGate: true, gateThreshold: -40 })).toBe(-40);
    expect(gateThreshold({ ...base, inputMode: "ptt", noiseGate: false })).toBeNull();
    expect(gateThreshold({ ...base, inputMode: "ptt", noiseGate: true })).toBe(-60);
  });

  it("builds microphone constraints for the three noise suppression levels", () => {
    const off = captureConstraints({ ...DEFAULT_SETTINGS, noiseSuppression: "off", echoCancellation: true, autoGain: false, inputDeviceId: "mic1" });
    expect(off).toMatchObject({ noiseSuppression: false, echoCancellation: true, autoGainControl: false, deviceId: { exact: "mic1" }, channelCount: 1 });
    expect(captureConstraints({ ...DEFAULT_SETTINGS, noiseSuppression: "browser" }).noiseSuppression).toBe(true);
    // RNNoise replaces the browser's suppression (both at once only cost CPU and muffle the voice).
    expect(captureConstraints({ ...DEFAULT_SETTINGS, noiseSuppression: "rnnoise" }).noiseSuppression).toBe(false);
    expect(captureConstraints({ ...DEFAULT_SETTINGS, inputDeviceId: "" }).deviceId).toBeUndefined();
  });

  it("keeps camera resolution and frame rate within the node's limits", () => {
    expect(limitResolution("1080p", "720p")).toBe("720p");
    expect(limitResolution("360p", "720p")).toBe("360p");
    expect(limitResolution("720p", "bogus")).toBe("720p");
    expect(resolutionSize("720p")).toEqual({ width: 1280, height: 720 });
    expect(resolutionSize("1440p")).toEqual({ width: 2560, height: 1440 });
    const opts = cameraOptions({ ...DEFAULT_SETTINGS, cameraResolution: "1080p", cameraFps: 60, cameraDeviceId: "cam" }, { max_resolution: "720p", max_fps: 30 });
    expect(opts).toEqual({ deviceId: "cam", width: 1280, height: 720, frameRate: 30 });
  });

  it("keeps a stream volume per streamer apart from the voice volume (issue #20)", () => {
    expect(DEFAULT_SETTINGS.streamVolumes).toEqual({});
    const store = useVoiceSettings.getState();
    store.setStreamVolume("bob@n", 40);
    store.setUserVolume("bob@n", 150);
    expect(useVoiceSettings.getState().settings.streamVolumes).toEqual({ "bob@n": 40 });
    expect(useVoiceSettings.getState().settings.userVolumes).toEqual({ "bob@n": 150 });
    // Persisted per device like the voice volumes; 100 % removes the entry.
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).streamVolumes).toEqual({ "bob@n": 40 });
    useVoiceSettings.getState().setStreamVolume("bob@n", 100);
    expect(useVoiceSettings.getState().settings.streamVolumes).toEqual({});
    expect(useVoiceSettings.getState().settings.userVolumes).toEqual({ "bob@n": 150 });
    // Validated like the voice volumes: 0–200 %, numbers only, bounded addresses.
    const s = normalizeSettings({ streamVolumes: { "a@n": 250, "b@n": -1, "c@n": "x", ["x".repeat(321)]: 50 } });
    expect(s.streamVolumes).toEqual({ "a@n": 200, "b@n": 0 });
  });

  it("streams stay audible while deafened unless switched off (issue #20)", () => {
    expect(DEFAULT_SETTINGS.streamWhileDeafened).toBe(true);
    expect(normalizeSettings({ streamWhileDeafened: false }).streamWhileDeafened).toBe(false);
    expect(normalizeSettings({ streamWhileDeafened: "no" }).streamWhileDeafened).toBe(true);
  });
});
