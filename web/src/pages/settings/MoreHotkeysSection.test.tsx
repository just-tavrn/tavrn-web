// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoreHotkeysSection } from "./MoreHotkeysSection";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { resetPlatform, setPlatform, type HotkeyAction, type PlatformHotkeys } from "../../platform";
import { browserPlatform } from "../../platform/browser";
import { DEFAULT_SETTINGS, useVoiceSettings } from "../../voice/settings";
import { resetHotkeysForTest, useHotkeyState } from "../../voice/hotkeys";
import { renderWithProviders } from "../../test/render";

function desktop(refuse: Record<string, string> = {}): PlatformHotkeys {
  const hotkeys: PlatformHotkeys = {
    register: vi.fn(async (_action: HotkeyAction, combo: string) => {
      if (refuse[combo]) throw refuse[combo];
      return combo;
    }),
    unregister: vi.fn(async () => {}),
    subscribe: () => () => undefined,
    setEnabled: vi.fn(async () => false),
  };
  setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, hotkeys });
  return hotkeys;
}

type Mods = Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>>;
const down = (code: string, mods: Mods = {}) => act(() => void fireEvent.keyDown(window, { code, key: code, ...mods }));
const up = (code: string, mods: Mods = {}) => act(() => void fireEvent.keyUp(window, { code, key: code, ...mods }));
const settings = () => useVoiceSettings.getState().settings;

beforeEach(() => {
  localStorage.clear();
  useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
  resetHotkeysForTest();
});

afterEach(() => resetPlatform());

describe("More hotkeys", () => {
  it("in the browser: mute and deafen recorders for the window, with the hint about the desktop app", async () => {
    renderWithProviders(<MoreHotkeysSection />);
    expect(screen.getByText("Weitere Tastenkürzel")).toBeInTheDocument();
    expect(screen.getByTestId("more-hotkeys")).toBeInTheDocument();
    expect(screen.getByTestId("hotkey-whisper_reply-key")).toBeInTheDocument();
    expect(screen.getByText(/Desktop-App beobachtet sie auch systemweit/)).toBeInTheDocument();
    expect(screen.queryByTestId("hotkey-push_to_talk")).toBeNull();
    await userEvent.click(screen.getByTestId("hotkey-toggle_mute-change"));
    down("KeyM");
    await waitFor(() => expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("M"));
    expect(settings().hotkeys.toggle_mute).toBe("KeyM");
  });

  it("desktop: records a combination with the platform's key names and stores the shell's spelling", async () => {
    const hotkeys = desktop();
    renderWithProviders(<MoreHotkeysSection />);
    expect(screen.getByText(/beobachtet die Tasten nur und reserviert sie nicht/)).toBeInTheDocument();
    for (const a of ["toggle_mute", "toggle_deafen"] as const) expect(screen.getByTestId(`hotkey-${a}-key`)).toHaveTextContent("keins");
    await userEvent.click(screen.getByTestId("hotkey-toggle_mute-change"));
    expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("Taste oder Kombination drücken");
    down("ControlLeft", { ctrlKey: true });
    expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("Ctrl + …");
    down("KeyM", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("Ctrl + Shift + M"));
    expect(hotkeys.register).toHaveBeenCalledWith("toggle_mute", "Ctrl+Shift+KeyM");
    expect(settings().hotkeys.toggle_mute).toBe("Ctrl+Shift+KeyM");
    expect(screen.getByTestId("hotkey-toggle_mute-change")).toHaveTextContent("Ändern");
  });

  it("a modifier alone is recorded when it is released without another key", async () => {
    const hotkeys = desktop();
    renderWithProviders(<MoreHotkeysSection />);
    await userEvent.click(screen.getByTestId("hotkey-toggle_deafen-change"));
    down("ShiftRight", { shiftKey: true });
    up("ShiftRight");
    await waitFor(() => expect(screen.getByTestId("hotkey-toggle_deafen-key")).toHaveTextContent("Shift rechts"));
    expect(hotkeys.register).toHaveBeenCalledWith("toggle_deafen", "ShiftRight");
  });

  it("Escape cancels, Backspace removes the binding", async () => {
    const hotkeys = desktop();
    useVoiceSettings.getState().update({ hotkeys: { ...DEFAULT_SETTINGS.hotkeys, toggle_mute: "F13" } });
    renderWithProviders(<MoreHotkeysSection />);
    expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("F13");
    await userEvent.click(screen.getByTestId("hotkey-toggle_mute-change"));
    down("Escape");
    expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("F13");
    expect(hotkeys.register).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("hotkey-toggle_mute-change"));
    down("Backspace");
    await waitFor(() => expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("keins"));
    expect(hotkeys.unregister).toHaveBeenCalledWith("toggle_mute");
  });

  it("refuses the key of another action (push-to-talk included) with a translated message", async () => {
    const hotkeys = desktop();
    useVoiceSettings.getState().update({ hotkeys: { ...DEFAULT_SETTINGS.hotkeys, push_to_talk: "F14", toggle_mute: "F13" } });
    renderWithProviders(<MoreHotkeysSection />);
    await userEvent.click(screen.getByTestId("hotkey-toggle_deafen-change"));
    down("F13");
    expect(await screen.findByRole("alert")).toHaveTextContent("Stummschalten");
    await userEvent.click(screen.getByTestId("hotkey-toggle_deafen-change"));
    down("F14");
    expect(await screen.findByRole("alert")).toHaveTextContent("Push-to-Talk");
    expect(hotkeys.register).not.toHaveBeenCalled();
    expect(settings().hotkeys.toggle_deafen).toBe("");
  });

  it("shows the shell's refusal and keeps the old binding", async () => {
    desktop({ "Ctrl+Pause": "hotkey.invalid" });
    renderWithProviders(<MoreHotkeysSection />);
    await userEvent.click(screen.getByTestId("hotkey-toggle_mute-change"));
    down("Pause", { ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("kein Tastenkürzel");
    expect(screen.getByTestId("hotkey-toggle_mute-key")).toHaveTextContent("keins");
  });

  it("says when this system has no system-wide key listener", () => {
    desktop();
    renderWithProviders(<MoreHotkeysSection />);
    expect(screen.queryByTestId("hotkeys-unavailable")).toBeNull();
    act(() => useHotkeyState.setState({ listener: "unavailable" }));
    expect(screen.getByTestId("hotkeys-unavailable")).toHaveTextContent("Wayland");
  });
});

describe("HotkeyRecorder", () => {
  it("lights the key up while the action is held", () => {
    renderWithProviders(<HotkeyRecorder action="push_to_talk" label="Taste" removable={false} testid={{ key: "ptt-key", change: "ptt-capture" }} />);
    expect(screen.getByTestId("ptt-key")).toHaveTextContent("`");
    expect(screen.getByTestId("ptt-key")).not.toHaveAttribute("data-held");
    act(() => useHotkeyState.setState({ held: { push_to_talk: true } }));
    expect(screen.getByTestId("ptt-key")).toHaveAttribute("data-held", "true");
  });

  it("push-to-talk takes a plain key or a lone modifier", async () => {
    renderWithProviders(<HotkeyRecorder action="push_to_talk" label="Taste" removable={false} testid={{ key: "ptt-key", change: "ptt-capture" }} />);
    await userEvent.click(screen.getByTestId("ptt-capture"));
    down("KeyV");
    await waitFor(() => expect(screen.getByTestId("ptt-key")).toHaveTextContent("V"));
    await userEvent.click(screen.getByTestId("ptt-capture"));
    down("ControlLeft", { ctrlKey: true });
    up("ControlLeft");
    await waitFor(() => expect(settings().hotkeys.push_to_talk).toBe("ControlLeft"));
    expect(screen.getByTestId("ptt-key")).toHaveTextContent("Ctrl links");
  });
});
