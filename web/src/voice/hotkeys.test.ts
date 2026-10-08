// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform, type HotkeyAction, type HotkeyEvent, type Platform, type PlatformHotkeys } from "../platform";
import { browserPlatform } from "../platform/browser";
import { DEFAULT_SETTINGS, useVoiceSettings } from "./settings";
import { useToasts } from "../stores/toasts";

const voice = vi.hoisted(() => ({ pushToTalk: vi.fn(), setPrioritySpeaker: vi.fn(), toggleMute: vi.fn(async () => {}), toggleDeafen: vi.fn(async () => {}) }));
vi.mock("./index", () => voice);

import { bindHotkey, browserKeyConflict, clearHotkey, comboFromEvent, comboLabel, desktopHeld, handleHotkey, hotkeyConflict, keyOs, resetHotkeysForTest, restoreHotkeys, startDesktopHotkeys } from "./hotkeys";

/** A fake shell: canonical spelling, typing keys refused, events through `emit`. */
function fakeShell(refuse: Record<string, string> = {}) {
  const handlers = new Set<(e: HotkeyEvent) => void>();
  const bound = new Map<HotkeyAction, string>();
  const hotkeys: PlatformHotkeys = {
    register: vi.fn(async (action: HotkeyAction, combo: string) => {
      if (refuse[combo]) throw refuse[combo];
      bound.set(action, combo);
      return combo;
    }),
    unregister: vi.fn(async (action: HotkeyAction) => {
      bound.delete(action);
    }),
    subscribe: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
  const platform: Platform = { ...browserPlatform, kind: "desktop", isDesktop: true, hotkeys };
  setPlatform(platform);
  return { hotkeys, bound, emit: (e: HotkeyEvent) => handlers.forEach((h) => h(e)) };
}

const settings = () => useVoiceSettings.getState().settings;

beforeEach(() => {
  localStorage.clear();
  useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
  useToasts.setState({ toasts: [] } as never);
  resetHotkeysForTest();
  vi.clearAllMocks();
});

afterEach(() => resetPlatform());

describe("combinations from the keyboard", () => {
  const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

  it("builds the canonical spelling in a fixed order", () => {
    expect(comboFromEvent(key("KeyM", { shiftKey: true, ctrlKey: true }))).toBe("Ctrl+Shift+KeyM");
    expect(comboFromEvent(key("F13"))).toBe("F13");
    expect(comboFromEvent(key("Digit1", { metaKey: true, altKey: true, ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Alt+Shift+Super+Digit1");
  });

  it("waits while only modifiers are held", () => {
    for (const code of ["ControlLeft", "ShiftRight", "AltLeft", "MetaLeft", "OSLeft", "CapsLock", ""]) expect(comboFromEvent(key(code, { ctrlKey: true }))).toBeNull();
  });

  it("shows the platform's key names", () => {
    expect(comboLabel("Ctrl+Shift+KeyM", "linux")).toBe("Ctrl + Shift + M");
    expect(comboLabel("Super+Digit1", "linux")).toBe("Super + 1");
    expect(comboLabel("Super+Digit1", "windows")).toBe("Win + 1");
    expect(comboLabel("Ctrl+Alt+Super+KeyK", "mac")).toBe("Control + Option + Cmd + K");
    expect(comboLabel("Alt+Numpad5", "windows")).toBe("Alt + Num 5");
    expect(comboLabel("Ctrl+Backquote", "linux")).toBe("Ctrl + `");
    expect(comboLabel("F13", "linux")).toBe("F13");
    expect(comboLabel("Ctrl+ArrowUp", "linux")).toBe("Ctrl + ↑");
  });

  it("recognizes the operating system for the key names", () => {
    expect(keyOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140")).toBe("windows");
    expect(keyOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15")).toBe("mac");
    expect(keyOs("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });
});

describe("conflict check", () => {
  it("refuses a combination of another global action", () => {
    const s = { ...DEFAULT_SETTINGS, desktopHotkeys: { ...DEFAULT_SETTINGS.desktopHotkeys, toggle_mute: "Ctrl+Shift+KeyM" } };
    expect(hotkeyConflict(s, "toggle_deafen", "Ctrl+Shift+KeyM")).toEqual({ key: "voice.hotkeys.conflict_desktop", action: "toggle_mute" });
    expect(hotkeyConflict(s, "toggle_mute", "Ctrl+Shift+KeyM")).toBeNull();
    expect(hotkeyConflict(s, "toggle_deafen", "Ctrl+Shift+KeyD")).toBeNull();
  });

  it("refuses a global binding equal to a key of the window (push-to-talk, priority speaker)", () => {
    const s = { ...DEFAULT_SETTINGS, pttKey: "F13", priorityKey: "F14" };
    expect(hotkeyConflict(s, "toggle_mute", "F13")).toEqual({ key: "voice.hotkeys.conflict_browser" });
    expect(hotkeyConflict(s, "push_to_talk", "F14")).toEqual({ key: "voice.hotkeys.conflict_browser" });
    expect(hotkeyConflict(s, "push_to_talk", "Ctrl+F13")).toBeNull();
  });

  it("refuses a key of the window equal to a global binding", () => {
    const s = { ...DEFAULT_SETTINGS, desktopHotkeys: { ...DEFAULT_SETTINGS.desktopHotkeys, push_to_talk: "F13", toggle_mute: "Ctrl+KeyM" } };
    expect(browserKeyConflict(s, "F13")).toBe(true);
    expect(browserKeyConflict(s, "KeyM")).toBe(false);
    expect(browserKeyConflict(s, "F14")).toBe(false);
  });
});

describe("binding through the shell", () => {
  it("stores the shell's canonical spelling in the voice settings", async () => {
    const shell = fakeShell();
    await expect(bindHotkey("toggle_mute", "Ctrl+Shift+KeyM")).resolves.toBeNull();
    expect(settings().desktopHotkeys.toggle_mute).toBe("Ctrl+Shift+KeyM");
    expect(shell.hotkeys.register).toHaveBeenCalledWith("toggle_mute", "Ctrl+Shift+KeyM");
    await clearHotkey("toggle_mute");
    expect(settings().desktopHotkeys.toggle_mute).toBe("");
    expect(shell.hotkeys.unregister).toHaveBeenCalledWith("toggle_mute");
  });

  it("refuses conflicts before the shell sees them and translates the shell's refusals", async () => {
    const shell = fakeShell({ "Shift+KeyM": "hotkey.typing_key", F20: "hotkey.unavailable" });
    useVoiceSettings.getState().update({ pttKey: "F13" });
    expect(await bindHotkey("toggle_mute", "F13")).toMatch(/Push-to-Talk|Fenster/);
    expect(shell.hotkeys.register).not.toHaveBeenCalled();
    expect(await bindHotkey("toggle_mute", "Shift+KeyM")).toMatch(/Strg|Ctrl/);
    expect(await bindHotkey("toggle_mute", "F20")).toMatch(/System/);
    expect(settings().desktopHotkeys.toggle_mute).toBe("");
  });

  it("restores the stored bindings at start and clears the actions without one", async () => {
    const shell = fakeShell({ F20: "hotkey.unavailable" });
    useVoiceSettings.getState().update({ desktopHotkeys: { push_to_talk: "F13", priority: "", toggle_mute: "F20", toggle_deafen: "Ctrl+KeyD" } });
    await restoreHotkeys();
    expect(shell.hotkeys.register).toHaveBeenCalledWith("push_to_talk", "F13");
    expect(shell.hotkeys.register).toHaveBeenCalledWith("toggle_deafen", "Ctrl+KeyD");
    expect(shell.hotkeys.unregister).toHaveBeenCalledWith("priority");
    // A combination the system refuses stays in the settings (another program may free it) and is reported once.
    expect(settings().desktopHotkeys.toggle_mute).toBe("F20");
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("does nothing in the browser", async () => {
    resetPlatform();
    await restoreHotkeys();
    expect(startDesktopHotkeys()).toBeTypeOf("function");
    expect(await bindHotkey("toggle_mute", "F13")).not.toBeNull();
  });
});

describe("the voice session reacts to presses and releases", () => {
  it("push-to-talk and the priority speaker follow press and release, once per hold", () => {
    handleHotkey({ action: "push_to_talk", pressed: true });
    handleHotkey({ action: "push_to_talk", pressed: true });
    expect(desktopHeld("push_to_talk")).toBe(true);
    handleHotkey({ action: "push_to_talk", pressed: false });
    expect(voice.pushToTalk.mock.calls).toEqual([[true], [false]]);
    expect(desktopHeld("push_to_talk")).toBe(false);
    handleHotkey({ action: "priority", pressed: true });
    handleHotkey({ action: "priority", pressed: false });
    handleHotkey({ action: "priority", pressed: false });
    expect(voice.setPrioritySpeaker.mock.calls).toEqual([[true], [false]]);
  });

  it("mute and deafen toggle on the press only", () => {
    handleHotkey({ action: "toggle_mute", pressed: true });
    handleHotkey({ action: "toggle_mute", pressed: false });
    handleHotkey({ action: "toggle_deafen", pressed: true });
    handleHotkey({ action: "toggle_deafen", pressed: false });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    expect(voice.toggleDeafen).toHaveBeenCalledTimes(1);
  });

  it("listens to the shell from the start until it stops", async () => {
    const shell = fakeShell();
    const stop = startDesktopHotkeys();
    shell.emit({ action: "toggle_mute", pressed: true });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    stop();
    shell.emit({ action: "toggle_mute", pressed: false });
    shell.emit({ action: "toggle_mute", pressed: true });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
  });
});
