// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { resetPlatform, setPlatform, type Platform, type PlatformVoice } from "../platform";
import { browserPlatform } from "../platform/browser";
import { chooseEngine, currentEngineKind, nativeConfig, nativeInfo, nativeSettingOffered, resetEngineForTests, useVoiceEngine } from "./engine";
import { DEFAULT_SETTINGS, useVoiceSettings } from "./settings";

function desktop(os: string, available = true): Platform {
  const voice = { info: async () => ({ available, os }) } as unknown as PlatformVoice;
  return { ...browserPlatform, kind: "desktop", isDesktop: true, voice };
}

afterEach(() => {
  resetPlatform();
  resetEngineForTests();
  useVoiceSettings.getState().update({ nativeEngine: false });
});

describe("chooseEngine", () => {
  it("uses the native engine on the Linux desktop always and on Windows with the setting", () => {
    const env = { desktop: true, available: true, setting: false };
    expect(chooseEngine({ ...env, os: "linux" })).toBe("native");
    expect(chooseEngine({ ...env, os: "linux", setting: true })).toBe("native");
    expect(chooseEngine({ ...env, os: "windows" })).toBe("browser");
    expect(chooseEngine({ ...env, os: "windows", setting: true })).toBe("native");
    expect(chooseEngine({ ...env, os: "macos", setting: true })).toBe("browser");
  });

  it("keeps the browser engine in browsers and in builds without the native one", () => {
    expect(chooseEngine({ desktop: false, os: "linux", available: true, setting: true })).toBe("browser");
    expect(chooseEngine({ desktop: true, os: "linux", available: false, setting: true })).toBe("browser");
    expect(chooseEngine({ desktop: true, os: null, available: true, setting: true })).toBe("browser");
  });
});

describe("currentEngineKind", () => {
  it("is the browser engine in a browser", async () => {
    expect(await currentEngineKind()).toBe("browser");
  });

  it("asks the shell once and follows the Windows setting", async () => {
    setPlatform(desktop("windows"));
    expect(await currentEngineKind()).toBe("browser");
    useVoiceSettings.getState().update({ nativeEngine: true });
    expect(await currentEngineKind()).toBe("native");
    expect(useVoiceEngine.getState()).toMatchObject({ os: "windows", available: true });
    expect(nativeSettingOffered(useVoiceEngine.getState())).toBe(true);
  });

  it("is native on Linux and offers no setting there", async () => {
    setPlatform(desktop("linux"));
    expect(await currentEngineKind()).toBe("native");
    expect(nativeSettingOffered(useVoiceEngine.getState())).toBe(false);
  });

  it("falls back to the browser engine when the shell does not answer", async () => {
    const voice = { info: () => Promise.reject(new Error("no command")) } as unknown as PlatformVoice;
    setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, voice });
    expect(await nativeInfo()).toEqual({ available: false, os: null });
    expect(await currentEngineKind()).toBe("browser");
  });
});

describe("nativeConfig", () => {
  it("maps the voice settings to the native engine's", () => {
    const s = { ...DEFAULT_SETTINGS, nativeInputDeviceId: "pulseaudio:mic", inputVolume: 150, noiseSuppression: "rnnoise" as const, autoGain: false, vadThreshold: -48 };
    expect(nativeConfig(s)).toEqual({
      inputDevice: "pulseaudio:mic",
      outputDevice: null,
      inputVolume: 150,
      echoCancellation: true,
      noiseSuppression: true,
      autoGain: false,
      ptt: false,
      threshold: -48,
      holdMs: 300,
      pttReleaseMs: 250,
    });
  });

  it("push-to-talk has no hold and the noise gate as its only threshold", () => {
    const c = nativeConfig({ ...DEFAULT_SETTINGS, inputMode: "ptt", noiseGate: true, gateThreshold: -70, pttReleaseMs: 400 });
    expect(c).toMatchObject({ ptt: true, threshold: -70, holdMs: 0, pttReleaseMs: 400 });
    expect(nativeConfig({ ...DEFAULT_SETTINGS, inputMode: "ptt" }).threshold).toBeNull();
  });

  it("music mode captures without processing; noise suppression off stays off", () => {
    expect(nativeConfig(DEFAULT_SETTINGS, true)).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGain: false });
    expect(nativeConfig({ ...DEFAULT_SETTINGS, noiseSuppression: "off" }).noiseSuppression).toBe(false);
  });
});
