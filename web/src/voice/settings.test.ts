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

  it("one binding per action: push-to-talk defaults to `, the others to none; bindings in the canonical spelling (issue #36)", () => {
    expect(DEFAULT_SETTINGS.hotkeys).toEqual({ push_to_talk: "Backquote", priority: "", toggle_mute: "", toggle_deafen: "" });
    const s = normalizeSettings({ hotkeys: { push_to_talk: "ControlLeft", priority: "KeyV", toggle_mute: "Ctrl+Shift+KeyM", toggle_deafen: "<script>", shutdown: "F1" } });
    expect(s.hotkeys).toEqual({ push_to_talk: "ControlLeft", priority: "KeyV", toggle_mute: "Ctrl+Shift+KeyM", toggle_deafen: "" });
    expect(normalizeSettings({ hotkeys: { toggle_mute: `Ctrl+${"K".repeat(70)}` } }).hotkeys.toggle_mute).toBe("");
    expect(normalizeSettings({ hotkeys: { priority: 5 } }).hotkeys.priority).toBe("");
    // Push-to-talk may be removed (then push-to-talk mode has no key until one is recorded).
    expect(normalizeSettings({ hotkeys: { push_to_talk: "" } }).hotkeys.push_to_talk).toBe("");
    // Older spellings of the Windows/Super key become MetaLeft/MetaRight.
    expect(normalizeSettings({ hotkeys: { push_to_talk: "OSLeft", priority: "Ctrl+OSRight" } }).hotkeys).toMatchObject({ push_to_talk: "MetaLeft", priority: "Ctrl+MetaRight" });
    // Two actions never share a binding: the later one is dropped.
    expect(normalizeSettings({ hotkeys: { push_to_talk: "F13", toggle_mute: "F13" } }).hotkeys).toMatchObject({ push_to_talk: "F13", toggle_mute: "" });
    expect(Object.keys(normalizeSettings({}))).not.toEqual(expect.arrayContaining(["pttKey", "priorityKey", "desktopHotkeys"]));
  });

  it("migrates the keys of the window and the separate global hotkeys into one binding per action (issue #36)", () => {
    // The window's keys are the bindings now; mute and deafen come from the global hotkeys.
    const both = normalizeSettings({ pttKey: "ControlLeft", priorityKey: "KeyV", desktopHotkeys: { push_to_talk: "F13", priority: "F14", toggle_mute: "Ctrl+Shift+KeyM", toggle_deafen: "F12" } });
    expect(both.hotkeys).toEqual({ push_to_talk: "ControlLeft", priority: "KeyV", toggle_mute: "Ctrl+Shift+KeyM", toggle_deafen: "F12" });
    // A global push-to-talk wins over the untouched default key of the window, and fills an empty priority key.
    const global = normalizeSettings({ pttKey: "Backquote", priorityKey: "", desktopHotkeys: { push_to_talk: "F13", priority: "F14", toggle_mute: "", toggle_deafen: "" } });
    expect(global.hotkeys).toEqual({ push_to_talk: "F13", priority: "F14", toggle_mute: "", toggle_deafen: "" });
    // Only the window's keys (the browser): kept as they were.
    expect(normalizeSettings({ pttKey: "KeyB", priorityKey: "" }).hotkeys).toEqual({ push_to_talk: "KeyB", priority: "", toggle_mute: "", toggle_deafen: "" });
    expect(normalizeSettings({ inputMode: "ptt" }).hotkeys).toEqual(DEFAULT_SETTINGS.hotkeys);
    // A migrated conflict (the same key for two actions) keeps the first action's binding.
    expect(normalizeSettings({ pttKey: "F12", desktopHotkeys: { toggle_deafen: "F12" } }).hotkeys).toMatchObject({ push_to_talk: "F12", toggle_deafen: "" });
    // Once migrated, the old fields are gone from what is stored.
    useVoiceSettings.setState({ settings: normalizeSettings({ pttKey: "KeyB", desktopHotkeys: { toggle_mute: "F13" } }) });
    useVoiceSettings.getState().update({ inputMode: "ptt" });
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    expect(stored.hotkeys).toEqual({ push_to_talk: "KeyB", priority: "", toggle_mute: "F13", toggle_deafen: "" });
    expect(stored).not.toHaveProperty("pttKey");
    expect(stored).not.toHaveProperty("desktopHotkeys");
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

describe("keep the screen on during voice calls", () => {
  it("is on by default; stored values are kept, invalid ones fall back to on", () => {
    expect(DEFAULT_SETTINGS.keepScreenOn).toBe(true);
    expect(normalizeSettings({}).keepScreenOn).toBe(true);
    expect(normalizeSettings({ keepScreenOn: false }).keepScreenOn).toBe(false);
    expect(normalizeSettings({ keepScreenOn: "no" }).keepScreenOn).toBe(true);
  });
});
