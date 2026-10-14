// SPDX-License-Identifier: Apache-2.0
/**
 * The share dialog's sound choice (docs/CLIENT.md "Screen share audio"): the choices follow the platform
 * (`screenAudio.ts`), the note says what the choice means, and the start hands the choice to the session. The tests
 * run in German (`test/setup.ts`).
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform } from "../../platform";
import type { Platform } from "../../platform/types";

vi.mock("../index", () => ({ startScreenShare: vi.fn(async () => undefined), stopScreenShare: vi.fn(async () => undefined) }));

const { ScreenShareDialog } = await import("./VoiceControls");
const { startScreenShare } = await import("../index");

const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

const base: Platform = { kind: "browser", isDesktop: false, nodeBase: () => "", webOrigin: () => "https://t.local", openExternal: async () => {}, appVersion: async () => "0.4.0" };

function browser(ua: string, restrictOwnAudio: boolean) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", { value: { getSupportedConstraints: () => (restrictOwnAudio ? { restrictOwnAudio: true } : {}) }, configurable: true });
}

const open = () => render(<ScreenShareDialog open onClose={() => undefined} maxResolution="1080p" maxFps={30} />);
const radios = () => within(screen.getByTestId("screen-share-audio")).getAllByRole("radio");

beforeEach(() => vi.mocked(startScreenShare).mockClear());
afterEach(() => {
  resetPlatform();
  vi.restoreAllMocks();
});

describe("the sound of a screen share", () => {
  it("Chromium on Windows: No sound or Whole system, the system by default with the call left out; the start carries the choice", async () => {
    browser(CHROME_WINDOWS, true);
    setPlatform(base);
    open();
    const group = screen.getByRole("group", { name: "Ton" });
    expect(radios().map((r) => (r as HTMLInputElement).value)).toEqual(["none", "system"]);
    expect(screen.getByRole("radio", { name: "Ganzes System" })).toBeChecked();
    expect(group).toHaveAccessibleDescription(/der Anruf bleibt draußen/);
    await userEvent.click(screen.getByTestId("screen-share-start"));
    expect(startScreenShare).toHaveBeenCalledWith({ audio: "system", resolution: "1080p", fps: 30 });
  });

  it("an older Chromium includes the call in the system's sound: off by default, the note warns, the choice still works", async () => {
    browser(CHROME_WINDOWS, false);
    setPlatform(base);
    open();
    expect(screen.getByRole("radio", { name: "Kein Ton" })).toBeChecked();
    expect(screen.getByTestId("screen-share-sound-note")).toHaveAttribute("data-note", "included");
    await userEvent.click(screen.getByRole("radio", { name: "Ganzes System" }));
    await userEvent.click(screen.getByTestId("screen-share-start"));
    expect(startScreenShare).toHaveBeenCalledWith(expect.objectContaining({ audio: "system" }));
  });

  it("Firefox shares no sound: only No sound, with the reason", async () => {
    browser(FIREFOX, false);
    setPlatform(base);
    open();
    expect(radios()).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Kein Ton" })).toBeChecked();
    expect(screen.getByTestId("screen-share-sound-note")).toHaveTextContent("Dieser Browser kann zum Bildschirm keinen Ton teilen.");
    await userEvent.click(screen.getByTestId("screen-share-start"));
    expect(startScreenShare).toHaveBeenCalledWith(expect.objectContaining({ audio: "none" }));
  });

  it("the Linux app (Electron) shares no sound; the Windows fallback the whole system with the call in it", () => {
    browser(CHROME_WINDOWS, true);
    setPlatform({ ...base, kind: "desktop", isDesktop: true, shell: { kind: "electron", os: "linux" } });
    const { unmount } = open();
    expect(radios()).toHaveLength(1);
    expect(screen.getByTestId("screen-share-sound-note")).toHaveAttribute("data-note", "none_linux_app");
    unmount();
    setPlatform({ ...base, kind: "desktop", isDesktop: true, shell: { kind: "electron", os: "windows" } });
    open();
    expect(radios()).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Kein Ton" })).toBeChecked();
    expect(screen.getByTestId("screen-share-sound-note")).toHaveAttribute("data-note", "included");
  });

  it("the Windows app (WebView2) is Chromium on Windows: the whole system without the call", () => {
    browser(CHROME_WINDOWS, true);
    setPlatform({ ...base, kind: "desktop", isDesktop: true, shell: { kind: "tauri", os: "windows" } });
    open();
    expect(screen.getByRole("radio", { name: "Ganzes System" })).toBeChecked();
    expect(screen.getByTestId("screen-share-sound-note")).toHaveAttribute("data-note", "excluded");
  });

  it("the Android app: the sound of other apps (Android 10+), on by default; below that only No sound", () => {
    browser("Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile", false);
    const screenShare = { audio: true, start: async () => undefined, setKey: async () => undefined, stop: async () => undefined, onEvent: () => () => undefined };
    const android = (audio: boolean): Platform => ({ ...base, kind: "android", isDesktop: true, shell: { kind: "tauri", os: "android" }, android: { sdk: 36, webauthn: true, passkeys: false, screenShare: { ...screenShare, audio } } as unknown as Platform["android"] });
    setPlatform(android(true));
    const { unmount } = open();
    expect(screen.getByTestId("screen-share-dialog")).toHaveAttribute("data-native", "android");
    expect(screen.getByRole("radio", { name: "Der Ton anderer Apps" })).toBeChecked();
    expect(screen.getByTestId("screen-share-sound-note")).toHaveAttribute("data-note", "other_apps");
    unmount();
    setPlatform(android(false));
    open();
    expect(radios()).toHaveLength(1);
    expect(screen.getByTestId("screen-share-sound-note")).toHaveTextContent("Android 10 oder neuer");
  });
});
