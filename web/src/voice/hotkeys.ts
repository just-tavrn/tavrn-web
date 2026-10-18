// SPDX-License-Identifier: Apache-2.0
/**
 * Hotkeys of the voice client (docs/DESKTOP.md "Hotkeys", issue #36): push-to-talk and the priority speaker while
 * held, mute and deafen as toggles. One binding per action (`hotkeys` of the voice settings): it works while the
 * window has focus (the window's key events, here) and, in the desktop app, system-wide: the shell observes the bound
 * keys with a key listener and reports presses and releases (`platform.hotkeys`). `hotkeyHolds.ts` merges both sources
 * so a key the window and the shell both see fires once. The shell's listener runs only while the client is signed in.
 */
import { create } from "zustand";
import { platform, type HotkeyAction, type HotkeyEvent } from "../platform";
import { t } from "../i18n";
import { useAuth } from "../stores/auth";
import { useToasts } from "../stores/toasts";
import { HotkeyHolds } from "./hotkeyHolds";
import { normalizeCode } from "./hotkeyRecorder";
import { pushToTalk, setPrioritySpeaker, toggleDeafen, toggleMute, whisperHotkey } from "./index";
import { useVoiceSettings, type Hotkeys } from "./settings";
import { useVoice } from "./store";

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ["push_to_talk", "priority", "toggle_mute", "toggle_deafen"];

// ---------------------------------------------------------------- bindings and their names

export interface Binding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
  /** `KeyboardEvent.code`; may itself be a modifier key (`ControlLeft`). */
  key: string;
}

/** A binding in the canonical spelling, or null. */
export function parseBinding(combo: string | undefined): Binding | null {
  if (!combo) return null;
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  if (!key) return null;
  return { ctrl: parts.includes("Ctrl"), alt: parts.includes("Alt"), shift: parts.includes("Shift"), super: parts.includes("Super"), key };
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

/** Modifier keys bound alone: which modifier, which side. */
const SIDED = /^(Control|Alt|Shift|Meta)(Left|Right)$/;
const SIDED_NAMES: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Super" };

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

/** A key (`KeyboardEvent.code`) as it is printed on the keyboard; a lone modifier with its side. */
export function keyLabel(code: string, os: KeyOs = keyOs()): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  const sided = SIDED.exec(code);
  if (sided) {
    const name = MODIFIER_NAMES[os][SIDED_NAMES[sided[1]!]!] ?? sided[1]!;
    return t(sided[2] === "Left" ? "voice.hotkeys.key_left" : "voice.hotkeys.key_right", { key: name });
  }
  const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(code);
  if (m) return m[1] ?? m[2] ?? `Num ${m[3]}`;
  return code;
}

/** A binding with the platform's key names: `Ctrl + Shift + M`, `Win + 1`, `Cmd + K`, `Ctrl links`. */
export function comboLabel(combo = "", os: KeyOs = keyOs()): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return [...parts.map((m) => MODIFIER_NAMES[os][m] ?? m), keyLabel(key, os)].join(" + ");
}

export const actionLabel = (action: HotkeyAction) => action.startsWith("whisper:") ? t("voice.whisper.group") : t(`voice.hotkeys.action.${action}`);

/** The other action that already uses `combo`, or null. */
export function hotkeyConflict(bindings: Hotkeys, action: HotkeyAction, combo: string): HotkeyAction | null {
  return (Object.keys(bindings) as HotkeyAction[]).find((a) => a !== action && bindings[a] === combo) ?? null;
}

/** The translated reason of a refusal (`hotkey.*` codes of the shell). */
export function hotkeyError(e: unknown): string {
  const code = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  switch (code) {
    case "hotkey.duplicate":
      return t("voice.hotkeys.error.duplicate");
    case "hotkey.unavailable":
      return t("voice.hotkeys.error.unavailable");
    default:
      return t("voice.hotkeys.error.invalid");
  }
}

// ---------------------------------------------------------------- state for the settings

export type ListenerState = "off" | "on" | "unavailable";

interface HotkeyState {
  /** Actions held right now (the settings light the key up). */
  held: Partial<Record<HotkeyAction, boolean>>;
  /** The shell's key listener: running, not needed (browser, signed out, nothing bound) or not available here. */
  listener: ListenerState;
}

export const useHotkeyState = create<HotkeyState>(() => ({ held: {}, listener: "off" }));

/** Whether `action` is held right now (window or system-wide). */
export function hotkeyHeld(action: HotkeyAction): boolean {
  return holds.held(action);
}

// ---------------------------------------------------------------- what a hold does

/** Outside a call nothing shows the toggled state (in a call the cues and the controls do): say what the next join gets. */
function announceOutsideCall(): void {
  const { status, muted, deafened } = useVoice.getState();
  if (status !== "idle") return;
  const key = deafened ? "voice.hotkeys.idle_deafened" : muted ? "voice.hotkeys.idle_muted" : "voice.hotkeys.idle_live";
  useToasts.getState().push({ kind: "info", title: t(key), testId: "hotkey-voice-state" });
}

function act(action: HotkeyAction, held: boolean): void {
  useHotkeyState.setState((s) => ({ held: { ...s.held, [action]: held } }));
  if (action === "whisper_reply" || action.startsWith("whisper:")) { whisperHotkey(action, held); return; }
  switch (action) {
    case "push_to_talk":
      pushToTalk(held);
      break;
    case "priority":
      setPrioritySpeaker(held);
      break;
    case "toggle_mute":
      if (held) void toggleMute().then(announceOutsideCall);
      break;
    case "toggle_deafen":
      if (held) void toggleDeafen().then(announceOutsideCall);
      break;
  }
}

const focused = () => typeof document === "undefined" || document.hasFocus();
const holds = new HotkeyHolds(act, focused);

/** A press or release reported by the shell's key listener. */
export function handleHotkey(e: HotkeyEvent): void {
  holds.global(e.action, e.pressed);
}

// ---------------------------------------------------------------- the window's keys

let recording = false;

/** While a recorder of the settings listens, the window's keys bind instead of acting. */
export function setRecording(on: boolean): void {
  recording = on;
}

type KeyState = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** Whether the modifiers a binding needs are held (more may be held: Shift to run while holding push-to-talk). */
function modifiersHeld(b: Binding, e: KeyState): boolean {
  return (!b.ctrl || e.ctrlKey) && (!b.alt || e.altKey) && (!b.shift || e.shiftKey) && (!b.super || e.metaKey);
}

const modifierCount = (b: Binding) => Number(b.ctrl) + Number(b.alt) + Number(b.shift) + Number(b.super);

/** The action a keydown in the window presses: its key with its modifiers held, the most specific binding wins. */
export function actionOfKeyDown(bindings: Hotkeys, e: KeyState): HotkeyAction | null {
  const code = normalizeCode(e.code);
  let best: { action: HotkeyAction; n: number } | null = null;
  for (const action of Object.keys(bindings) as HotkeyAction[]) {
    const b = parseBinding(bindings[action]);
    if (!b || b.key !== code || !modifiersHeld(b, e)) continue;
    if (!best || modifierCount(b) > best.n) best = { action, n: modifierCount(b) };
  }
  return best?.action ?? null;
}

/** Whether a keyup in the window ends the hold of a binding: its key, or one of its modifiers, went up. */
export function releasesBinding(combo: string | undefined, e: KeyState): boolean {
  const b = parseBinding(combo);
  return !!b && (b.key === normalizeCode(e.code) || !modifiersHeld(b, e));
}

/** A key that types text into a field (a plain character, no Ctrl, Alt or Super). */
function typesIntoField(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  const editable = !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  return editable && e.key?.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function onKeyDown(e: KeyboardEvent): void {
  if (recording || e.repeat || typesIntoField(e)) return;
  const action = actionOfKeyDown(useVoiceSettings.getState().settings.hotkeys, e);
  if (action) holds.window(action, true);
}

function onKeyUp(e: KeyboardEvent): void {
  const bindings = useVoiceSettings.getState().settings.hotkeys;
  for (const action of Object.keys(bindings) as HotkeyAction[]) if (bindings[action] && releasesBinding(bindings[action], e)) holds.window(action, false);
}

// ---------------------------------------------------------------- the shell

const signedIn = () => !!useAuth.getState().token;

async function enableListener(): Promise<void> {
  const hotkeys = platform().hotkeys;
  if (!hotkeys) return;
  try {
    const on = await hotkeys.setEnabled(signedIn());
    useHotkeyState.setState({ listener: on ? "on" : "off" });
  } catch {
    useHotkeyState.setState({ listener: "unavailable" });
  }
}

/** Ends a hold whose binding changed or went away (its release would never come). */
function releaseBinding(action: HotkeyAction): void {
  holds.release(action);
}

/**
 * Binds `combo` to `action`: refuses a binding of another action, lets the desktop shell validate it, stores it.
 * Resolves to the translated refusal, or null. Without a key listener on this system the binding is kept (it works
 * while the window has focus) and the settings say so.
 */
export async function bindHotkey(action: HotkeyAction, combo: string): Promise<string | null> {
  const { settings, update } = useVoiceSettings.getState();
  const other = hotkeyConflict(settings.hotkeys, action, combo);
  if (other) return t("voice.hotkeys.conflict", { action: actionLabel(other) });
  let canonical = combo;
  const hotkeys = platform().hotkeys;
  if (hotkeys) {
    try {
      canonical = await hotkeys.register(action, combo);
      if (useHotkeyState.getState().listener === "off") await enableListener();
    } catch (e) {
      if (e !== "hotkey.unavailable") return hotkeyError(e);
      useHotkeyState.setState({ listener: "unavailable" });
    }
  }
  releaseBinding(action);
  update({ hotkeys: { ...useVoiceSettings.getState().settings.hotkeys, [action]: canonical } });
  return null;
}

/** Removes the binding of `action`. */
export async function clearHotkey(action: HotkeyAction): Promise<void> {
  releaseBinding(action);
  const { settings, update } = useVoiceSettings.getState();
  update({ hotkeys: { ...settings.hotkeys, [action]: "" } });
  const hotkeys = platform().hotkeys;
  if (!hotkeys) return;
  await hotkeys.unregister(action);
  await enableListener();
}

/**
 * Hands the stored bindings to the shell (at start; a reloaded page registers the same ones again) and switches its
 * key listener with the sign-in. A binding the shell refuses stays stored and is reported once.
 */
export async function restoreHotkeys(): Promise<void> {
  const hotkeys = platform().hotkeys;
  if (!hotkeys) return;
  const stored = useVoiceSettings.getState().settings.hotkeys;
  const failed: string[] = [];
  for (const action of [...new Set([...HOTKEY_ACTIONS, ...Object.keys(stored)])] as HotkeyAction[]) {
    try {
      if (stored[action]) await hotkeys.register(action, stored[action]);
      else await hotkeys.unregister(action);
    } catch (e) {
      if (e !== "hotkey.unavailable") failed.push(`${actionLabel(action)} (${comboLabel(stored[action])}): ${hotkeyError(e)}`);
    }
  }
  await enableListener();
  if (failed.length) useToasts.getState().push({ kind: "warning", title: t("voice.hotkeys.restore_failed"), detail: failed.join("\n") });
}

/**
 * At start of the app: the window's keys, the shell's presses and releases, the bindings restored in the shell and its
 * listener following the sign-in. Returns the stopper.
 */
export function startHotkeys(): () => void {
  const target = typeof window === "undefined" ? null : window;
  const blur = () => {
    holds.blur();
    for (const action of Object.keys(useHotkeyState.getState().held) as HotkeyAction[]) {
      if (action === "whisper_reply" || action.startsWith("whisper:")) holds.release(action);
    }
  };
  target?.addEventListener("keydown", onKeyDown);
  target?.addEventListener("keyup", onKeyUp);
  target?.addEventListener("blur", blur);
  const offs: Array<() => void> = [
    () => {
      target?.removeEventListener("keydown", onKeyDown);
      target?.removeEventListener("keyup", onKeyUp);
      target?.removeEventListener("blur", blur);
    },
  ];
  const hotkeys = platform().hotkeys;
  if (hotkeys) {
    offs.push(hotkeys.subscribe(handleHotkey));
    // Signing in or out switches the listener (a sign-out also ends what is held).
    offs.push(
      useAuth.subscribe((now, prev) => {
        if (!!now.token === !!prev.token) return;
        if (!now.token) holds.releaseAll();
        void enableListener();
      }),
    );
    void restoreHotkeys();
  }
  return () => {
    for (const off of offs) off();
    holds.releaseAll();
  };
}

/** Tests: forget the held keys and the recorder. */
export function resetHotkeysForTest(): void {
  holds.releaseAll();
  recording = false;
  useHotkeyState.setState({ held: {}, listener: "off" });
}
