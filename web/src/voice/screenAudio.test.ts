// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOs, currentScreenAudioEnv, displayMediaAudio, isChromium, screenAudioSupport, type ScreenAudioEnv } from "./screenAudio";

const browser = (os: ScreenAudioEnv["os"], chromium = true, restrictOwnAudio = true): ScreenAudioEnv => ({ kind: "browser", chromium, os, restrictOwnAudio });
const app = (kind: "tauri" | "electron", os: ScreenAudioEnv["os"], restrictOwnAudio = true): ScreenAudioEnv => ({ kind: "desktop", shell: { kind, os }, chromium: true, os, restrictOwnAudio });

describe("the sound choices of a screen share per platform", () => {
  it("Chromium on Windows and macOS: the whole system, the call left out when the browser knows restrictOwnAudio", () => {
    for (const os of ["windows", "macos"] as const) {
      expect(screenAudioSupport(browser(os))).toEqual({ choices: ["none", "system"], ownExcluded: true, initial: "system", note: "excluded" });
      // An older Chromium includes the call in the system's sound: offered, but off by default and said so.
      expect(screenAudioSupport(browser(os, true, false))).toEqual({ choices: ["none", "system"], ownExcluded: false, initial: "none", note: "included" });
    }
  });

  it("Chromium on Linux shares a tab's sound only; ChromeOS the system without the own-audio filter", () => {
    expect(screenAudioSupport(browser("linux"))).toEqual({ choices: ["none", "system"], ownExcluded: true, initial: "system", note: "tab_only" });
    expect(screenAudioSupport(browser("other", true, false))).toMatchObject({ choices: ["none", "system"], ownExcluded: false, note: "included" });
  });

  it("Firefox and Safari share no sound with a screen", () => {
    for (const os of ["windows", "macos", "linux"] as const) expect(screenAudioSupport(browser(os, false))).toEqual({ choices: ["none"], ownExcluded: false, initial: "none", note: "none_browser" });
  });

  it("the Windows app (WebView2) is Chromium on Windows; the macOS app's WebKit and a Linux development build share no sound", () => {
    expect(screenAudioSupport(app("tauri", "windows"))).toEqual({ choices: ["none", "system"], ownExcluded: true, initial: "system", note: "excluded" });
    expect(screenAudioSupport(app("tauri", "windows", false))).toMatchObject({ ownExcluded: false, initial: "none", note: "included" });
    expect(screenAudioSupport(app("tauri", "macos"))).toEqual({ choices: ["none"], ownExcluded: false, initial: "none", note: "none_app" });
    expect(screenAudioSupport(app("tauri", "linux"))).toMatchObject({ choices: ["none"], note: "none_app" });
  });

  it("the Electron shell: loopback on Windows only, with the call in it; nothing on Linux", () => {
    expect(screenAudioSupport(app("electron", "windows"))).toEqual({ choices: ["none", "system"], ownExcluded: false, initial: "none", note: "included" });
    expect(screenAudioSupport(app("electron", "linux"))).toEqual({ choices: ["none"], ownExcluded: false, initial: "none", note: "none_linux_app" });
  });

  it("the Android app: the sound of other apps from Android 10, never the call", () => {
    const android = (androidAudio: boolean): ScreenAudioEnv => ({ kind: "android", shell: { kind: "tauri", os: "android" }, chromium: true, os: "android", restrictOwnAudio: false, androidAudio });
    expect(screenAudioSupport(android(true))).toEqual({ choices: ["none", "system"], ownExcluded: true, initial: "system", note: "other_apps" });
    expect(screenAudioSupport(android(false))).toEqual({ choices: ["none"], ownExcluded: false, initial: "none", note: "none_android" });
  });

  it("no platform offers one window's sound today (Chromium's windowAudio knows system and exclude only)", () => {
    for (const env of [browser("windows"), browser("macos"), browser("linux"), app("tauri", "windows"), app("electron", "windows")]) expect(screenAudioSupport(env).choices).not.toContain("window");
  });
});

describe("the getDisplayMedia constraints of a choice", () => {
  it("no sound asks for none and keeps the system's sound out of the picker", () => {
    expect(displayMediaAudio("none")).toEqual({ audio: false, systemAudio: "exclude" });
  });
  it("the whole system asks for audio with the own sound restricted and offers the system's sound", () => {
    expect(displayMediaAudio("system")).toEqual({ audio: { restrictOwnAudio: true }, systemAudio: "include" });
  });
  it("this window never lets the system's sound in", () => {
    expect(displayMediaAudio("window")).toEqual({ audio: { restrictOwnAudio: true }, systemAudio: "exclude" });
  });
});

describe("what the browser says about itself", () => {
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  it("Chromium engines: Chrome, Edge, WebView2 and Electron; not Firefox or Safari", () => {
    expect(isChromium(chrome)).toBe(true);
    expect(isChromium(chrome + " Edg/141.0.0.0")).toBe(true);
    expect(isChromium("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) tavrn/0.4.0 Chrome/146.0.0.0 Electron/44.7.0 Safari/537.36")).toBe(true);
    expect(isChromium("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0")).toBe(false);
    expect(isChromium("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe(false);
    // Client hints win over the user agent string.
    expect(isChromium("anything", [{ brand: "Google Chrome" }, { brand: "Chromium" }])).toBe(true);
    expect(isChromium(chrome, [{ brand: "Brave" }])).toBe(false);
  });
  it("the operating system", () => {
    expect(browserOs(chrome)).toBe("windows");
    expect(browserOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15")).toBe("macos");
    expect(browserOs("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0")).toBe("linux");
    expect(browserOs("Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile")).toBe("android");
    expect(browserOs("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/141.0.0.0")).toBe("other");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("the environment of the page reads the platform, the user agent and the supported constraints", () => {
    vi.stubGlobal("navigator", { userAgent: chrome, mediaDevices: { getSupportedConstraints: () => ({ restrictOwnAudio: true }) } });
    expect(currentScreenAudioEnv({ kind: "browser" })).toEqual({ kind: "browser", shell: undefined, chromium: true, os: "windows", restrictOwnAudio: true, androidAudio: undefined });
    vi.stubGlobal("navigator", { userAgent: chrome, mediaDevices: { getSupportedConstraints: () => ({}) } });
    expect(currentScreenAudioEnv({ kind: "desktop", shell: { kind: "electron", os: "linux" } })).toMatchObject({ shell: { kind: "electron", os: "linux" }, restrictOwnAudio: false });
    // A page without media devices (an insecure context) still answers.
    vi.stubGlobal("navigator", { userAgent: chrome });
    expect(currentScreenAudioEnv({ kind: "android", android: { screenShare: { audio: true } } })).toMatchObject({ kind: "android", androidAudio: true, restrictOwnAudio: false });
  });
});
