// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopHotkeysSection } from "./DesktopHotkeysSection";
import { resetPlatform, setPlatform, type HotkeyAction, type PlatformHotkeys } from "../../platform";
import { browserPlatform } from "../../platform/browser";
import { DEFAULT_SETTINGS, useVoiceSettings } from "../../voice/settings";
import { renderWithProviders } from "../../test/render";

function desktop(refuse: Record<string, string> = {}): PlatformHotkeys {
  const hotkeys: PlatformHotkeys = {
    register: vi.fn(async (_action: HotkeyAction, combo: string) => {
      if (refuse[combo]) throw refuse[combo];
      return combo;
    }),
    unregister: vi.fn(async () => {}),
    subscribe: () => () => undefined,
  };
  setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, hotkeys });
  return hotkeys;
}

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => act(() => void fireEvent.keyDown(window, { code, key: code, ...mods }));
const row = (action: HotkeyAction) => screen.getByTestId(`hotkey-${action}`);

beforeEach(() => {
  localStorage.clear();
  useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
});

afterEach(() => resetPlatform());

describe("DesktopHotkeysSection", () => {
  it("in the browser: only the hint that the desktop app has global hotkeys", () => {
    renderWithProviders(<DesktopHotkeysSection />);
    expect(screen.getByTestId("desktop-hotkeys-hint")).toHaveTextContent("Desktop-App");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("records a combination, shows the platform's key names and stores the shell's spelling", async () => {
    const hotkeys = desktop();
    renderWithProviders(<DesktopHotkeysSection />);
    for (const a of ["push_to_talk", "priority", "toggle_mute", "toggle_deafen"] as const) expect(row(a)).toHaveTextContent("keins");
    await userEvent.click(screen.getByTestId("hotkey-toggle_mute-change"));
    expect(row("toggle_mute")).toHaveTextContent("Kombination drücken");
    press("ControlLeft", { ctrlKey: true });
    expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("Ctrl + …");
    press("KeyM", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("Ctrl + Shift + M"));
    expect(hotkeys.register).toHaveBeenCalledWith("toggle_mute", "Ctrl+Shift+KeyM");
    expect(useVoiceSettings.getState().settings.desktopHotkeys.toggle_mute).toBe("Ctrl+Shift+KeyM");
    expect(screen.getByTestId("hotkey-toggle_mute-change")).toHaveTextContent("Ändern");
  });

  it("Escape cancels, Backspace removes the binding", async () => {
    const hotkeys = desktop();
    useVoiceSettings.getState().update({ desktopHotkeys: { ...DEFAULT_SETTINGS.desktopHotkeys, push_to_talk: "F13" } });
    renderWithProviders(<DesktopHotkeysSection />);
    expect(screen.getByTestId("hotkey-push_to_talk-key")).toHaveTextContent("F13");
    await userEvent.click(screen.getByTestId("hotkey-push_to_talk-change"));
    press("Escape");
    expect(screen.getByTestId("hotkey-push_to_talk-key")).toHaveTextContent("F13");
    expect(hotkeys.register).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("hotkey-push_to_talk-change"));
    press("Backspace");
    await waitFor(() => expect(screen.getByTestId("hotkey-push_to_talk-key")).toHaveTextContent("keins"));
    expect(hotkeys.unregister).toHaveBeenCalledWith("push_to_talk");
  });

  it("refuses a combination of another action or of the window with a translated message", async () => {
    const hotkeys = desktop();
    useVoiceSettings.getState().update({ pttKey: "F14", desktopHotkeys: { ...DEFAULT_SETTINGS.desktopHotkeys, toggle_mute: "F13" } });
    renderWithProviders(<DesktopHotkeysSection />);
    await userEvent.click(screen.getByTestId("hotkey-toggle_deafen-change"));
    press("F13");
    expect(await screen.findByRole("alert")).toHaveTextContent("Stummschalten");
    await userEvent.click(screen.getByTestId("hotkey-toggle_deafen-change"));
    press("F14");
    expect(await screen.findByRole("alert")).toHaveTextContent("Push-to-Talk");
    expect(hotkeys.register).not.toHaveBeenCalled();
    expect(useVoiceSettings.getState().settings.desktopHotkeys.toggle_deafen).toBe("");
  });

  it("shows the shell's refusal and keeps the old binding", async () => {
    desktop({ "Shift+KeyM": "hotkey.typing_key" });
    renderWithProviders(<DesktopHotkeysSection />);
    await userEvent.click(screen.getByTestId("hotkey-priority-change"));
    press("KeyM", { shiftKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("Alt");
    expect(screen.getByTestId("hotkey-priority-key")).toHaveTextContent("keins");
  });

  it("says that push-to-talk needs the push-to-talk input mode", () => {
    desktop();
    useVoiceSettings.getState().update({ inputMode: "vad", desktopHotkeys: { ...DEFAULT_SETTINGS.desktopHotkeys, push_to_talk: "F13" } });
    renderWithProviders(<DesktopHotkeysSection />);
    expect(screen.getByTestId("hotkey-ptt-mode")).toBeInTheDocument();
    act(() => useVoiceSettings.getState().update({ inputMode: "ptt" }));
    expect(screen.queryByTestId("hotkey-ptt-mode")).toBeNull();
  });
});
