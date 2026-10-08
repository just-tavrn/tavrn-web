// SPDX-License-Identifier: Apache-2.0
/**
 * Global hotkeys of the desktop app (docs/DESKTOP.md "Global hotkeys"): push-to-talk and the priority speaker while
 * held, mute and deafen as toggles, also while the app is in the background. The bindings live in the voice settings
 * (`desktopHotkeys`, apart from the keys of the window `pttKey` and `priorityKey`, which `session.ts` handles while the
 * window has focus); the shell (`platform.hotkeys`) validates and grabs them and reports presses and releases, which
 * reach the voice session here. In the browser nothing of this runs.
 */
import { platform, type HotkeyAction, type HotkeyEvent } from "../platform";
import { t } from "../i18n";
import { useToasts } from "../stores/toasts";
import { pushToTalk, setPrioritySpeaker, toggleDeafen, toggleMute } from "./index";
import { useVoiceSettings, type VoiceSettings } from "./settings";

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ["push_to_talk", "priority", "toggle_mute", "toggle_deafen"];

type KeyState = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** Keys that only modify (the recorder keeps waiting for the real key). */
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS|Super|Hyper)(Left|Right)?$|^(AltGraph|CapsLock|NumLock|Fn|FnLock|ContextMenu)$/;

/** The combination of a key press in the shell's canonical spelling, or null while only modifiers are held. */
export function comboFromEvent(e: KeyState): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  return `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.metaKey ? "Super+" : ""}${e.code}`;
}

/** The modifiers held so far, for the recorder's "Ctrl + …". */
export function heldModifiers(e: KeyState): string {
  return `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.metaKey ? "Super+" : ""}`;
}

export type KeyOs = "linux" | "windows" | "mac";

/** The operating system whose key names the recorder shows (only labels depend on it). */
export function keyOs(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): KeyOs {
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  return "linux";
}

const MODIFIER_NAMES: Record<KeyOs, Record<string, string>> = {
  linux: { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Super" },
  windows: { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Win" },
  mac: { Ctrl: "Control", Alt: "Option", Shift: "Shift", Super: "Cmd" },
};

const KEY_NAMES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
  NumpadEnter: "Num Enter",
  PageUp: "Page Up",
  PageDown: "Page Down",
  ScrollLock: "Scroll Lock",
  PrintScreen: "Print Screen",
};

/** A key (`KeyboardEvent.code`) as it is printed on the keyboard. */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(code);
  if (m) return m[1] ?? m[2] ?? `Num ${m[3]}`;
  return code;
}

/** A combination with the platform's key names: `Ctrl + Shift + M`, `Win + 1`, `Cmd + K`. */
export function comboLabel(combo: string, os: KeyOs = keyOs()): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return [...parts.map((m) => MODIFIER_NAMES[os][m] ?? m), keyLabel(key)].join(" + ");
}

export type Conflict = { key: "voice.hotkeys.conflict_desktop"; action: HotkeyAction } | { key: "voice.hotkeys.conflict_browser" };

/**
 * Why `combo` cannot be bound to `action`: another global action uses it, or it is the push-to-talk or priority key
 * of the window (both would fire). Null when it is free.
 */
export function hotkeyConflict(s: VoiceSettings, action: HotkeyAction, combo: string): Conflict | null {
  const other = HOTKEY_ACTIONS.find((a) => a !== action && s.desktopHotkeys[a] === combo);
  if (other) return { key: "voice.hotkeys.conflict_desktop", action: other };
  if (combo === s.pttKey || (s.priorityKey && combo === s.priorityKey)) return { key: "voice.hotkeys.conflict_browser" };
  return null;
}

/** Whether a key of the window (`KeyboardEvent.code`) is bound as a global hotkey. */
export function browserKeyConflict(s: VoiceSettings, code: string): boolean {
  return HOTKEY_ACTIONS.some((a) => s.desktopHotkeys[a] === code);
}

export const actionLabel = (action: HotkeyAction) => t(`voice.hotkeys.action.${action}`);

/** The translated reason of a refusal (`hotkey.*` codes of the shell). */
export function hotkeyError(e: unknown): string {
  const code = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  switch (code) {
    case "hotkey.typing_key":
      return t("voice.hotkeys.error.typing_key", { super: MODIFIER_NAMES[keyOs()].Super ?? "Super" });
    case "hotkey.duplicate":
      return t("voice.hotkeys.error.duplicate");
    case "hotkey.unavailable":
      return t("voice.hotkeys.error.unavailable");
    default:
      return t("voice.hotkeys.error.invalid");
  }
}

/** Binds `combo` to `action` through the shell and stores it; resolves to the translated refusal, or null. */
export async function bindHotkey(action: HotkeyAction, combo: string): Promise<string | null> {
  const hotkeys = platform().hotkeys;
  if (!hotkeys) return t("voice.hotkeys.browser_hint");
  const { settings, update } = useVoiceSettings.getState();
  const conflict = hotkeyConflict(settings, action, combo);
  if (conflict) return conflict.key === "voice.hotkeys.conflict_desktop" ? t(conflict.key, { action: actionLabel(conflict.action) }) : t(conflict.key);
  try {
    const canonical = await hotkeys.register(action, combo);
    update({ desktopHotkeys: { ...useVoiceSettings.getState().settings.desktopHotkeys, [action]: canonical } });
    return null;
  } catch (e) {
    return hotkeyError(e);
  }
}

/** Removes the binding of `action`. */
export async function clearHotkey(action: HotkeyAction): Promise<void> {
  await platform().hotkeys?.unregister(action);
  const { settings, update } = useVoiceSettings.getState();
  update({ desktopHotkeys: { ...settings.desktopHotkeys, [action]: "" } });
}

/**
 * Hands the stored bindings to the shell at start (a reloaded page re-registers the same ones, which the shell
 * accepts). A combination the system refuses stays stored, another program may free it later; the user hears once.
 */
export async function restoreHotkeys(): Promise<void> {
  const hotkeys = platform().hotkeys;
  if (!hotkeys) return;
  const stored = useVoiceSettings.getState().settings.desktopHotkeys;
  const failed: string[] = [];
  for (const action of HOTKEY_ACTIONS) {
    try {
      if (stored[action]) await hotkeys.register(action, stored[action]);
      else await hotkeys.unregister(action);
    } catch (e) {
      failed.push(`${actionLabel(action)} (${comboLabel(stored[action])}): ${hotkeyError(e)}`);
    }
  }
  if (failed.length) useToasts.getState().push({ kind: "warning", title: t("voice.hotkeys.restore_failed"), detail: failed.join("\n") });
}

const held = new Set<HotkeyAction>();

/** Whether a global hotkey of `action` is held right now (focus changes of the window do not release it). */
export function desktopHeld(action: HotkeyAction): boolean {
  return held.has(action);
}

/** A press or release of the shell: push-to-talk and the priority speaker follow the hold, the toggles the press. */
export function handleHotkey(e: HotkeyEvent): void {
  if (e.pressed === held.has(e.action)) return;
  if (e.pressed) held.add(e.action);
  else held.delete(e.action);
  switch (e.action) {
    case "push_to_talk":
      pushToTalk(e.pressed);
      break;
    case "priority":
      setPrioritySpeaker(e.pressed);
      break;
    case "toggle_mute":
      if (e.pressed) void toggleMute();
      break;
    case "toggle_deafen":
      if (e.pressed) void toggleDeafen();
      break;
  }
}

/** At start of the desktop app: listen to the shell and restore the bindings. Returns the stopper. */
export function startDesktopHotkeys(): () => void {
  const hotkeys = platform().hotkeys;
  if (!hotkeys) return () => undefined;
  const off = hotkeys.subscribe(handleHotkey);
  void restoreHotkeys();
  return () => {
    off();
    held.clear();
  };
}

/** Tests: forget the held keys. */
export function resetHotkeysForTest(): void {
  held.clear();
}
