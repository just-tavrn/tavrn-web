// SPDX-License-Identifier: Apache-2.0
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform, type HotkeyAction, type HotkeyEvent, type Platform, type PlatformHotkeys } from "../platform";
import { browserPlatform } from "../platform/browser";
import { DEFAULT_SETTINGS, useVoiceSettings } from "./settings";
import { useToasts } from "../stores/toasts";
import { useAuth } from "../stores/auth";
import { IDLE, useVoice } from "./store";

const voice = vi.hoisted(() => ({ pushToTalk: vi.fn(), setPrioritySpeaker: vi.fn(), toggleMute: vi.fn(async () => {}), toggleDeafen: vi.fn(async () => {}) }));
vi.mock("./index", () => voice);

import { actionOfKeyDown, bindHotkey, clearHotkey, comboLabel, handleHotkey, hotkeyConflict, hotkeyHeld, keyLabel, keyOs, releasesBinding, resetHotkeysForTest, restoreHotkeys, setRecording, startHotkeys, useHotkeyState } from "./hotkeys";

/** A fake shell: canonical spelling, refusals by binding, events through `emit`, the listener's switch. */
function fakeShell(refuse: Record<string, string> = {}, opts: { listener?: "ok" | "unavailable" } = {}) {
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
    setEnabled: vi.fn(async (enabled: boolean) => {
      if (enabled && bound.size && opts.listener === "unavailable") throw "hotkey.unavailable";
      return enabled && bound.size > 0;
    }),
  };
  const platform: Platform = { ...browserPlatform, kind: "desktop", isDesktop: true, hotkeys };
  setPlatform(platform);
  return { hotkeys, bound, emit: (e: HotkeyEvent) => handlers.forEach((h) => h(e)) };
}

const settings = () => useVoiceSettings.getState().settings;
const bindings = (patch: Partial<typeof DEFAULT_SETTINGS.hotkeys>) => useVoiceSettings.getState().update({ hotkeys: { ...settings().hotkeys, ...patch } });
const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const signIn = () => useAuth.setState({ token: "t" } as never);
const signOut = () => useAuth.setState({ token: null } as never);

let stop: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
  useToasts.setState({ toasts: [] } as never);
  signOut();
  resetHotkeysForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.restoreAllMocks();
  resetPlatform();
});

describe("key names", () => {
  it("shows the platform's names, a lone modifier with its side", () => {
    expect(comboLabel("Ctrl+Shift+KeyM", "linux")).toBe("Ctrl + Shift + M");
    expect(comboLabel("Super+Digit1", "windows")).toBe("Win + 1");
    expect(comboLabel("Ctrl+Alt+Super+KeyK", "mac")).toBe("Control + Option + Cmd + K");
    expect(comboLabel("Alt+Numpad5", "windows")).toBe("Alt + Num 5");
    expect(comboLabel("Ctrl+ArrowUp", "linux")).toBe("Ctrl + ↑");
    expect(comboLabel("Backquote", "linux")).toBe("`");
    expect(comboLabel("KeyV", "linux")).toBe("V");
    expect(keyLabel("ControlLeft", "windows")).toBe("Ctrl links");
    expect(keyLabel("ShiftRight", "linux")).toBe("Shift rechts");
    expect(keyLabel("MetaLeft", "windows")).toBe("Win links");
    expect(keyLabel("AltRight", "mac")).toBe("Option rechts");
    expect(comboLabel("Shift+ControlLeft", "linux")).toBe("Shift + Ctrl links");
  });

  it("recognizes the operating system for the key names", () => {
    expect(keyOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140")).toBe("windows");
    expect(keyOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15")).toBe("mac");
    expect(keyOs("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });
});

describe("matching the window's keys", () => {
  const b = { ...DEFAULT_SETTINGS.hotkeys, push_to_talk: "ControlLeft", priority: "KeyV", toggle_mute: "Ctrl+KeyM", toggle_deafen: "Ctrl+Shift+KeyM" };

  it("a single key, a lone modifier, a combination; the most specific binding wins", () => {
    expect(actionOfKeyDown(b, key("ControlLeft", { ctrlKey: true }))).toBe("push_to_talk");
    expect(actionOfKeyDown(b, key("ControlRight", { ctrlKey: true }))).toBeNull();
    expect(actionOfKeyDown(b, key("KeyV"))).toBe("priority");
    expect(actionOfKeyDown(b, key("KeyV", { shiftKey: true }))).toBe("priority");
    expect(actionOfKeyDown(b, key("KeyM", { ctrlKey: true }))).toBe("toggle_mute");
    expect(actionOfKeyDown(b, key("KeyM", { ctrlKey: true, shiftKey: true }))).toBe("toggle_deafen");
    expect(actionOfKeyDown(b, key("KeyM"))).toBeNull();
  });

  it("the key or one of its modifiers going up ends the hold", () => {
    expect(releasesBinding("ControlLeft", key("ControlLeft"))).toBe(true);
    expect(releasesBinding("Ctrl+KeyM", key("ControlLeft", {}))).toBe(true);
    expect(releasesBinding("Ctrl+KeyM", key("ShiftLeft", { ctrlKey: true }))).toBe(false);
    expect(releasesBinding("KeyV", key("KeyB"))).toBe(false);
  });
});

describe("conflict check", () => {
  it("refuses a binding of another action, the same one for the same action is fine", () => {
    const b = { ...DEFAULT_SETTINGS.hotkeys, toggle_mute: "Ctrl+Shift+KeyM" };
    expect(hotkeyConflict(b, "toggle_deafen", "Ctrl+Shift+KeyM")).toBe("toggle_mute");
    expect(hotkeyConflict(b, "toggle_mute", "Ctrl+Shift+KeyM")).toBeNull();
    expect(hotkeyConflict(b, "priority", "Backquote")).toBe("push_to_talk");
    expect(hotkeyConflict(b, "toggle_deafen", "Ctrl+Shift+KeyD")).toBeNull();
  });
});

describe("binding", () => {
  it("in the browser: stored for the window, no shell", async () => {
    await expect(bindHotkey("toggle_mute", "KeyM")).resolves.toBeNull();
    expect(settings().hotkeys.toggle_mute).toBe("KeyM");
    expect(await bindHotkey("toggle_deafen", "KeyM")).toMatch(/Stummschalten/);
    await clearHotkey("toggle_mute");
    expect(settings().hotkeys.toggle_mute).toBe("");
  });

  it("in the desktop app: the shell's canonical spelling is stored, its listener starts for a signed-in user", async () => {
    const shell = fakeShell();
    signIn();
    await expect(bindHotkey("push_to_talk", "ControlLeft")).resolves.toBeNull();
    expect(settings().hotkeys.push_to_talk).toBe("ControlLeft");
    expect(shell.hotkeys.register).toHaveBeenCalledWith("push_to_talk", "ControlLeft");
    expect(useHotkeyState.getState().listener).toBe("on");
    await clearHotkey("push_to_talk");
    expect(settings().hotkeys.push_to_talk).toBe("");
    expect(shell.hotkeys.unregister).toHaveBeenCalledWith("push_to_talk");
    expect(useHotkeyState.getState().listener).toBe("off");
  });

  it("refuses conflicts before the shell sees them and translates the shell's refusals", async () => {
    const shell = fakeShell({ "Ctrl+KeyQ": "hotkey.invalid" });
    bindings({ push_to_talk: "F13" });
    expect(await bindHotkey("toggle_mute", "F13")).toMatch(/Push-to-Talk/);
    expect(shell.hotkeys.register).not.toHaveBeenCalled();
    expect(await bindHotkey("toggle_mute", "Ctrl+KeyQ")).toMatch(/kein Tastenkürzel/);
    expect(settings().hotkeys.toggle_mute).toBe("");
  });

  it("without a key listener on this system the binding is kept for the window and the settings say so", async () => {
    fakeShell({ KeyV: "hotkey.unavailable" });
    await expect(bindHotkey("push_to_talk", "KeyV")).resolves.toBeNull();
    expect(settings().hotkeys.push_to_talk).toBe("KeyV");
    expect(useHotkeyState.getState().listener).toBe("unavailable");
  });

  it("restores the stored bindings at start, clears the actions without one and switches the listener with the sign-in", async () => {
    const shell = fakeShell({ F20: "hotkey.invalid" });
    bindings({ push_to_talk: "ControlLeft", toggle_mute: "F20", toggle_deafen: "Ctrl+KeyD" });
    signIn();
    await restoreHotkeys();
    expect(shell.hotkeys.register).toHaveBeenCalledWith("push_to_talk", "ControlLeft");
    expect(shell.hotkeys.register).toHaveBeenCalledWith("toggle_deafen", "Ctrl+KeyD");
    expect(shell.hotkeys.unregister).toHaveBeenCalledWith("priority");
    expect(shell.hotkeys.setEnabled).toHaveBeenLastCalledWith(true);
    // A binding the shell refuses stays in the settings and is reported once.
    expect(settings().hotkeys.toggle_mute).toBe("F20");
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("signing out stops the shell's listener and ends what is held; signing in starts it again", async () => {
    const shell = fakeShell();
    bindings({ push_to_talk: "ControlLeft" });
    signIn();
    stop = startHotkeys();
    await vi.waitFor(() => expect(useHotkeyState.getState().listener).toBe("on"));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    shell.emit({ action: "push_to_talk", pressed: true });
    expect(voice.pushToTalk).toHaveBeenLastCalledWith(true);
    signOut();
    expect(voice.pushToTalk).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(shell.hotkeys.setEnabled).toHaveBeenLastCalledWith(false));
    expect(useHotkeyState.getState().listener).toBe("off");
    signIn();
    await vi.waitFor(() => expect(shell.hotkeys.setEnabled).toHaveBeenLastCalledWith(true));
  });
});

describe("the voice session reacts to presses and releases", () => {
  it("push-to-talk and the priority speaker follow press and release, once per hold (key repeat)", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    handleHotkey({ action: "push_to_talk", pressed: true });
    handleHotkey({ action: "push_to_talk", pressed: true });
    expect(hotkeyHeld("push_to_talk")).toBe(true);
    expect(useHotkeyState.getState().held.push_to_talk).toBe(true);
    handleHotkey({ action: "push_to_talk", pressed: false });
    expect(voice.pushToTalk.mock.calls).toEqual([[true], [false]]);
    expect(hotkeyHeld("push_to_talk")).toBe(false);
    handleHotkey({ action: "priority", pressed: true });
    handleHotkey({ action: "priority", pressed: false });
    handleHotkey({ action: "priority", pressed: false });
    expect(voice.setPrioritySpeaker.mock.calls).toEqual([[true], [false]]);
  });

  it("the window's keys act in the browser, not while a recorder listens or while typing a character into a field", () => {
    bindings({ push_to_talk: "ControlLeft", toggle_mute: "KeyM" });
    stop = startHotkeys();
    fireEvent.keyDown(window, { code: "ControlLeft", key: "Control", ctrlKey: true });
    fireEvent.keyDown(window, { code: "ControlLeft", key: "Control", ctrlKey: true, repeat: true });
    fireEvent.keyUp(window, { code: "ControlLeft", key: "Control" });
    expect(voice.pushToTalk.mock.calls).toEqual([[true], [false]]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { code: "KeyM", key: "m" });
    expect(voice.toggleMute).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { code: "KeyM", key: "m" });
    fireEvent.keyUp(window, { code: "KeyM", key: "m" });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    setRecording(true);
    fireEvent.keyDown(window, { code: "KeyM", key: "m" });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    setRecording(false);
    input.remove();
  });

  it("in the desktop app a key both the window and the shell see toggles once", () => {
    const shell = fakeShell();
    bindings({ toggle_mute: "KeyM" });
    stop = startHotkeys();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    shell.emit({ action: "toggle_mute", pressed: true });
    fireEvent.keyDown(window, { code: "KeyM", key: "m" });
    shell.emit({ action: "toggle_mute", pressed: false });
    fireEvent.keyUp(window, { code: "KeyM", key: "m" });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
  });

  it("a binding that changes or goes away while held is released", async () => {
    fakeShell();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    handleHotkey({ action: "push_to_talk", pressed: true });
    await bindHotkey("push_to_talk", "F14");
    expect(voice.pushToTalk.mock.calls).toEqual([[true], [false]]);
    handleHotkey({ action: "priority", pressed: true });
    await clearHotkey("priority");
    expect(voice.setPrioritySpeaker.mock.calls).toEqual([[true], [false]]);
    expect(hotkeyHeld("priority")).toBe(false);
  });

  it("mute and deafen toggle on the press only", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    handleHotkey({ action: "toggle_mute", pressed: true });
    handleHotkey({ action: "toggle_mute", pressed: false });
    handleHotkey({ action: "toggle_deafen", pressed: true });
    handleHotkey({ action: "toggle_deafen", pressed: false });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    expect(voice.toggleDeafen).toHaveBeenCalledTimes(1);
  });

  it("outside a call a toggle says what the next voice channel gets (no other feedback there)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    useVoice.setState({ ...IDLE });
    voice.toggleMute.mockImplementationOnce(async () => useVoice.setState({ muted: true }));
    handleHotkey({ action: "toggle_mute", pressed: true });
    await vi.waitFor(() => expect(useToasts.getState().toasts.map((x) => x.testId)).toEqual(["hotkey-voice-state"]));
    expect(useToasts.getState().toasts[0]!.title).toMatch(/stumm/i);
    handleHotkey({ action: "toggle_mute", pressed: false });
    voice.toggleDeafen.mockImplementationOnce(async () => useVoice.setState({ deafened: true, muted: true }));
    handleHotkey({ action: "toggle_deafen", pressed: true });
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(2));
    expect(useToasts.getState().toasts[1]!.title).toMatch(/Ton aus/);
    handleHotkey({ action: "toggle_deafen", pressed: false });
    // In a call the cues and the controls show it.
    useToasts.setState({ toasts: [] } as never);
    useVoice.setState({ status: "connected" });
    handleHotkey({ action: "toggle_mute", pressed: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(useToasts.getState().toasts).toHaveLength(0);
    useVoice.setState({ ...IDLE });
  });

  it("listens to the shell from the start until it stops", () => {
    const shell = fakeShell();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const off = startHotkeys();
    shell.emit({ action: "toggle_mute", pressed: true });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    off();
    shell.emit({ action: "toggle_mute", pressed: false });
    shell.emit({ action: "toggle_mute", pressed: true });
    expect(voice.toggleMute).toHaveBeenCalledTimes(1);
  });
});
