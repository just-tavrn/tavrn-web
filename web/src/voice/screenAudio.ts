// SPDX-License-Identifier: Apache-2.0
/**
 * The sound of a screen share (docs/CLIENT.md "Screen share audio"): one choice in the share dialog, "No sound",
 * "This window" or "Whole system", offered only where the platform can capture it, and the `getDisplayMedia`
 * constraints that choice becomes. Everything here is a pure mapping of what the platform reports; the dialog
 * (`ui/VoiceControls.tsx`) shows the choices and the note, the session (`session.ts`) applies the constraints.
 *
 * What the platforms can do (verified against Chromium's and Electron's documentation, October 2026):
 *
 * - Chromium (the browser, the Windows app's WebView2, the Linux app's Electron) captures the **whole system's** sound
 *   with a shared screen on Windows and ChromeOS, since Chrome 141 on macOS as well; on Linux only a browser tab's
 *   sound. No Chromium captures **one window's** sound: the `windowAudio` option knows `"system"` and `"exclude"`
 *   only, so a window shared "with audio" carries the system's sound. "This window" is therefore not offered today;
 *   the mapping keeps the choice for a platform that gains it.
 * - `restrictOwnAudio: true` (Chrome 141, Windows and macOS) leaves the capturing page's own sound out of the
 *   system audio: the call's playback, so nobody hears themselves. Whether a browser knows the constraint is read
 *   from `getSupportedConstraints()`; without it the system audio includes the call and the dialog says so.
 * - The Electron shell decides the audio in its own picker handler (`apps/desktop-electron/src/main/capture.ts`):
 *   Electron's loopback capture exists on Windows only and has no way to leave the app's own sound out; on Linux
 *   neither X11 nor the PipeWire portal gives Electron any audio.
 * - The Android app shares the sound of other apps through Android's playback capture (Android 10+), which by
 *   Android's rules takes media, game and unknown usages only: the call plays as voice communication and is never
 *   part of it.
 * - WebKit (the macOS app's webview) captures no sound with a screen.
 */
import type { PlatformKind, ShellInfo, ShellOs } from "../platform/types";

/** What the user picked: no sound, the shared window's own sound, or everything the system plays. */
export type ScreenAudio = "none" | "window" | "system";

/** The one-line explanation under the choice (`voice.screen.sound_<note>`). */
export type ScreenAudioNote = "excluded" | "included" | "tab_only" | "other_apps" | "none_browser" | "none_linux_app" | "none_app" | "none_android";

export interface ScreenAudioSupport {
  /** The choices to offer, `none` always first. */
  choices: readonly ScreenAudio[];
  /** With `system`: the call's own playback is left out (nobody hears themselves). */
  ownExcluded: boolean;
  /** The choice the dialog starts with: the system's sound where it is offered and clean, else none. */
  initial: ScreenAudio;
  note: ScreenAudioNote;
}

/** What the mapping needs to know about where the client runs. */
export interface ScreenAudioEnv {
  kind: PlatformKind;
  /** The apps' shell; absent in a browser. */
  shell?: ShellInfo;
  /** A Chromium-based browser or webview (the only engines that capture sound with a screen). */
  chromium: boolean;
  /** The operating system of a browser (from its user agent); the apps use `shell.os`. */
  os: ShellOs;
  /** The browser knows `restrictOwnAudio` (`getSupportedConstraints()`). */
  restrictOwnAudio: boolean;
  /** The Android app can share the sound of other apps (`AndroidScreenShare.audio`, Android 10+). */
  androidAudio?: boolean;
}

const none = (note: ScreenAudioNote): ScreenAudioSupport => ({ choices: ["none"], ownExcluded: false, initial: "none", note });
const system = (ownExcluded: boolean, note: ScreenAudioNote): ScreenAudioSupport => ({ choices: ["none", "system"], ownExcluded, initial: ownExcluded ? "system" : "none", note });

/** The choices for the platform the client runs on (the rules in the module comment). */
export function screenAudioSupport(env: ScreenAudioEnv): ScreenAudioSupport {
  if (env.kind === "android") return env.androidAudio ? system(true, "other_apps") : none("none_android");
  if (env.shell?.kind === "electron") return env.shell.os === "windows" ? system(false, "included") : none("none_linux_app");
  const os = env.shell ? env.shell.os : env.os;
  if (env.shell?.kind === "tauri") {
    // Windows: WebView2 (Chromium) with its own picker; macOS: WebKit, which captures no sound with a screen.
    return os === "windows" ? system(env.restrictOwnAudio, env.restrictOwnAudio ? "excluded" : "included") : none("none_app");
  }
  if (!env.chromium) return none("none_browser");
  if (os === "linux") return system(true, "tab_only");
  return system(env.restrictOwnAudio, env.restrictOwnAudio ? "excluded" : "included");
}

/** `getDisplayMedia`'s audio part for a choice (livekit-client passes `audio` and `systemAudio` through). */
export function displayMediaAudio(choice: ScreenAudio): { audio: false | { restrictOwnAudio: true }; systemAudio: "include" | "exclude" } {
  switch (choice) {
    case "none":
      return { audio: false, systemAudio: "exclude" };
    case "window":
      // Chromium offers no per-window sound (module comment); keep the system's out so the label stays true.
      return { audio: { restrictOwnAudio: true }, systemAudio: "exclude" };
    case "system":
      return { audio: { restrictOwnAudio: true }, systemAudio: "include" };
  }
}

/** A Chromium-based engine (Chrome, Edge, WebView2, Electron and the like), never Firefox or Safari. */
export function isChromium(ua: string, brands?: ReadonlyArray<{ brand: string }>): boolean {
  if (brands?.length) return brands.some((b) => /chrom/i.test(b.brand));
  // Edge, WebView2 and Electron all carry "Chrome/"; Firefox never does.
  return /Chrom(e|ium)\//.test(ua) && !/Firefox\//.test(ua);
}

/** The operating system of a browser from its user agent. */
export function browserOs(ua: string): ShellOs {
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/CrOS/.test(ua)) return "other";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

/** The environment of this page: the platform and what the browser says about itself. */
export function currentScreenAudioEnv(p: { kind: PlatformKind; shell?: ShellInfo; android?: { screenShare?: { audio: boolean } } }): ScreenAudioEnv {
  const nav = navigator as Navigator & { userAgentData?: { brands?: ReadonlyArray<{ brand: string }> } };
  const supported = (navigator.mediaDevices?.getSupportedConstraints?.() ?? {}) as { restrictOwnAudio?: boolean };
  return {
    kind: p.kind,
    shell: p.shell,
    chromium: isChromium(navigator.userAgent, nav.userAgentData?.brands),
    os: browserOs(navigator.userAgent),
    restrictOwnAudio: supported.restrictOwnAudio === true,
    androidAudio: p.android?.screenShare?.audio,
  };
}
