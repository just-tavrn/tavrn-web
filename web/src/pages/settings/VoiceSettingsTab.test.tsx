// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSettingsTab } from "./VoiceSettingsTab";
import { SETTINGS_KEY, useVoiceSettings } from "../../voice/settings";
import { mockFetch, renderWithProviders } from "../../test/render";

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function renderTab(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  useVoiceSettings.getState().reload();
  mockFetch({ "/node": { body: { voice: { enabled: true } } } });
  renderWithProviders(<VoiceSettingsTab />);
  return screen.getByTestId("muted-talk-hint");
}

describe("VoiceSettingsTab: the talking-while-muted hint's default (issue #147)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    useVoiceSettings.getState().reload();
  });

  it("shows the hint on by default outside Android", () => {
    expect(renderTab(DESKTOP_UA)).toBeChecked();
  });

  it("shows the hint off by default on Android; turning it on is stored as the user's choice", async () => {
    const toggle = renderTab(ANDROID_UA);
    expect(toggle).not.toBeChecked();
    await userEvent.setup().click(toggle);
    expect(toggle).toBeChecked();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).mutedTalkHint).toBe(true);
  });

  it("shows a stored choice on Android", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mutedTalkHint: true }));
    expect(renderTab(ANDROID_UA)).toBeChecked();
  });
});

describe("VoiceSettingsTab: log join timings (docs/CLIENT.md \"Voice troubleshooting\")", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("is off by default and switches the debug flag in this browser", async () => {
    renderTab(DESKTOP_UA);
    const toggle = screen.getByTestId("log-join-timings");
    expect(toggle).not.toBeChecked();
    await userEvent.setup().click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("tavrn.debug.voice")).toBe("1");
    await userEvent.setup().click(toggle);
    expect(localStorage.getItem("tavrn.debug.voice")).toBeNull();
  });

  it("shows the flag set by hand", () => {
    localStorage.setItem("tavrn.debug.voice", "1");
    renderTab(DESKTOP_UA);
    expect(screen.getByTestId("log-join-timings")).toBeChecked();
  });
});
