// SPDX-License-Identifier: Apache-2.0
/**
 * Hotkeys of the voice client (docs/DESKTOP.md "Hotkeys"), the Tauri shell's `hotkeys.rs` for the Electron shell:
 * push-to-talk and the priority speaker while held, mute and deafen as toggles, also while the app is in the background
 * or a game has the focus. The client registers one binding per action at start and whenever they change; the shell
 * validates a binding, refuses one that another action already uses and reports presses and releases of the bound
 * actions on the `hotkeys` event channel (`events.ts`), with the Tauri shell's payloads.
 *
 * The keys are **observed, never grabbed**: Electron's `globalShortcut` grabs a key (the game behind the app would no
 * longer get it, and a lone modifier cannot be bound), so the shell uses the Tauri shell's listener instead, the crate
 * `apps/desktop/crates/keywatch` as a Node-API module (`native/keywatch`: X RECORD, which copies the key events of the
 * X server and takes nothing away). It runs only while bindings exist and the client is signed in
 * (`setHotkeysEnabled`), and its filter holds only the bound keys and their modifiers: every other key is dropped in
 * the platform callback, nothing is stored or logged.
 *
 * A binding is written as the client captures it: modifiers in a fixed order and one key as `KeyboardEvent.code` names
 * it, e.g. `ControlLeft`, `KeyV`, `F13`, `Ctrl+Shift+KeyM`. `Super` is Super/Meta; `Cmd`, `Win`, `Meta`, `Command`,
 * `Control` and `Option` are accepted as spellings. A modifier in a combination means either side; a modifier key alone
 * is exactly that key.
 */
import { createRequire } from "node:module";
import type { HotkeyAction } from "./events.ts";
import { check, type IpcRegistry } from "./ipc.ts";

/** The actions, in the order the Tauri shell sorts them (events of one key come in this order). */
export const ACTIONS: readonly HotkeyAction[] = ["push_to_talk", "priority", "toggle_mute", "toggle_deafen"];

/**
 * The keys the listener knows, as `KeyboardEvent.code` names: the table of the crate (`keys.rs`; a unit test keeps both
 * equal).
 */
export const KEY_CODES: readonly string[] = [
  "Escape", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus",
  "Equal", "Backspace", "Tab", "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP",
  "BracketLeft", "BracketRight", "Enter", "ControlLeft", "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK",
  "KeyL", "Semicolon", "Quote", "Backquote", "ShiftLeft", "Backslash", "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN",
  "KeyM", "Comma", "Period", "Slash", "ShiftRight", "NumpadMultiply", "AltLeft", "Space", "CapsLock", "F1", "F2", "F3",
  "F4", "F5", "F6", "F7", "F8", "F9", "F10", "NumLock", "ScrollLock", "Numpad7", "Numpad8", "Numpad9", "NumpadSubtract",
  "Numpad4", "Numpad5", "Numpad6", "NumpadAdd", "Numpad1", "Numpad2", "Numpad3", "Numpad0", "NumpadDecimal",
  "IntlBackslash", "F11", "F12", "NumpadEnter", "ControlRight", "NumpadDivide", "PrintScreen", "AltRight", "Home",
  "ArrowUp", "PageUp", "ArrowLeft", "ArrowRight", "End", "ArrowDown", "PageDown", "Insert", "Delete", "AudioVolumeMute",
  "AudioVolumeDown", "AudioVolumeUp", "NumpadEqual", "Pause", "MetaLeft", "MetaRight", "ContextMenu", "MediaTrackNext",
  "MediaPlayPause", "MediaTrackPrevious", "MediaStop", "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21",
  "F22", "F23", "F24",
];
const KNOWN = new Set(KEY_CODES);

export type HotkeyErrorCode = "hotkey.invalid" | "hotkey.duplicate" | "hotkey.unavailable";

/** Why a binding is refused; the message is the code the client translates (the Tauri command's rejection). */
export class HotkeyError extends Error {
  readonly code: HotkeyErrorCode;
  /** For `hotkey.duplicate`: the action that has the binding. */
  readonly action: HotkeyAction | undefined;
  constructor(code: HotkeyErrorCode, action?: HotkeyAction) {
    super(code);
    this.code = code;
    this.action = action;
  }
}

type Modifier = "Ctrl" | "Alt" | "Shift" | "Super";
const MODIFIERS: readonly Modifier[] = ["Ctrl", "Alt", "Shift", "Super"];
/** The left and right key of each modifier. */
const MODIFIER_KEYS: Readonly<Record<Modifier, readonly [string, string]>> = {
  Ctrl: ["ControlLeft", "ControlRight"],
  Alt: ["AltLeft", "AltRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Super: ["MetaLeft", "MetaRight"],
};
const SPELLINGS: Readonly<Record<string, Modifier>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  meta: "Super",
  cmd: "Super",
  command: "Super",
  win: "Super",
};
const modifierOfKey = (code: string): Modifier | undefined => MODIFIERS.find((m) => MODIFIER_KEYS[m].includes(code));

/** The longest binding text the shell looks at. */
const MAX_LEN = 64;

/** A validated binding: modifiers (either side) and one key, which may itself be a modifier key. */
export interface Combo {
  readonly modifiers: ReadonlySet<Modifier>;
  readonly key: string;
}

/** Parses and validates a binding (see the module documentation). */
export function parseCombo(text: string): Combo {
  if (text.length === 0 || text.length > MAX_LEN) throw new HotkeyError("hotkey.invalid");
  const parts = text.split("+").map((p) => p.trim());
  const key = parts.pop()!;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const m = Object.hasOwn(SPELLINGS, part.toLowerCase()) ? SPELLINGS[part.toLowerCase()] : undefined;
    if (!m || modifiers.has(m)) throw new HotkeyError("hotkey.invalid");
    modifiers.add(m);
  }
  if (!KNOWN.has(key)) throw new HotkeyError("hotkey.invalid");
  // `Ctrl+ControlLeft` says the same thing twice.
  const own = modifierOfKey(key);
  if (own && modifiers.has(own)) throw new HotkeyError("hotkey.invalid");
  return { modifiers, key };
}

/** The canonical spelling: `Ctrl+Alt+Shift+Super+<code>`, what the client stores. */
export function formatCombo(combo: Combo): string {
  return [...MODIFIERS.filter((m) => combo.modifiers.has(m)), combo.key].join("+");
}

/** Every key the listener must watch for a binding: the key and both keys of each modifier. */
export function comboKeys(combo: Combo): string[] {
  return [combo.key, ...MODIFIERS.filter((m) => combo.modifiers.has(m)).flatMap((m) => MODIFIER_KEYS[m])];
}

const sameCombo = (a: Combo | undefined, b: Combo | undefined) => !!a && !!b && formatCombo(a) === formatCombo(b);

/** The bindings: at most one per action, never one binding for two actions. */
export class Registry {
  readonly #bindings = new Map<HotkeyAction, Combo>();

  /** Binds `text` to `action`; returns the canonical spelling. */
  bind(action: HotkeyAction, text: string): string {
    const combo = parseCombo(text);
    const other = ACTIONS.find((a) => a !== action && sameCombo(this.#bindings.get(a), combo));
    if (other) throw new HotkeyError("hotkey.duplicate", other);
    this.#bindings.set(action, combo);
    return formatCombo(combo);
  }

  /** Removes the binding of `action` (nothing bound: nothing happens). */
  unbind(action: HotkeyAction): void {
    this.#bindings.delete(action);
  }

  get(action: HotkeyAction): Combo | undefined {
    return this.#bindings.get(action);
  }

  /** The bindings in the actions' order. */
  entries(): [HotkeyAction, Combo][] {
    return ACTIONS.flatMap((a) => {
      const c = this.#bindings.get(a);
      return c ? [[a, c] as [HotkeyAction, Combo]] : [];
    });
  }

  /** The keys the listener must watch (each once). */
  keys(): string[] {
    return [...new Set(this.entries().flatMap(([, c]) => comboKeys(c)))];
  }
}

/** A press or release of a bound action, reported to the client (the Tauri shell's `HotkeyEvent`). */
export interface HotkeyEvent {
  action: HotkeyAction;
  pressed: boolean;
}

/**
 * Turns the presses and releases of the watched keys into presses and releases of actions:
 *
 * - an action is pressed when its key goes down while its modifiers are held (more modifiers may be held: Shift to run
 *   while holding push-to-talk); of the bindings with that key the one with the most modifiers wins, so
 *   `Ctrl+Shift+KeyM` does not also fire `Ctrl+KeyM`;
 * - it is released when its key or one of its modifiers goes up;
 * - a press of a key that is already down (key repeat) changes nothing, a release of a key that is not down too.
 */
export class Matcher {
  readonly #down = new Set<string>();
  readonly #active = new Set<HotkeyAction>();

  #held(m: Modifier): boolean {
    return MODIFIER_KEYS[m].some((k) => this.#down.has(k));
  }

  key(code: string, pressed: boolean, registry: Registry): HotkeyEvent[] {
    const events: HotkeyEvent[] = [];
    if (pressed) {
      if (this.#down.has(code)) return events;
      this.#down.add(code);
      const candidates = registry.entries().filter(([, c]) => c.key === code && [...c.modifiers].every((m) => this.#held(m)));
      const best = Math.max(-1, ...candidates.map(([, c]) => c.modifiers.size));
      for (const [action, c] of candidates) {
        if (c.modifiers.size !== best || this.#active.has(action)) continue;
        this.#active.add(action);
        events.push({ action, pressed: true });
      }
    } else {
      if (!this.#down.delete(code)) return events;
      for (const action of ACTIONS) {
        if (!this.#active.has(action)) continue;
        const c = registry.get(action);
        if (!c || c.key === code || [...c.modifiers].some((m) => !this.#held(m))) {
          this.#active.delete(action);
          events.push({ action, pressed: false });
        }
      }
    }
    return events;
  }

  /** Ends the hold of `action` (its binding changed or went away: the release would never come). */
  end(action: HotkeyAction): HotkeyEvent | null {
    return this.#active.delete(action) ? { action, pressed: false } : null;
  }

  /** Forgets every key and ends every hold (the listener stopped). */
  reset(): HotkeyEvent[] {
    this.#down.clear();
    const ended = ACTIONS.filter((a) => this.#active.has(a)).map((action) => ({ action, pressed: false }));
    this.#active.clear();
    return ended;
  }
}

/** The system-wide key listener: the native module in the app, a fake in the tests. */
export interface KeyListener {
  /** The keys it reports (`KeyboardEvent.code` names); every other key is dropped in the platform callback. */
  setKeys(codes: string[]): void;
  /** Starts it; throws `keywatch.unavailable: <why>` when this system has none. */
  start(callback: (code: string, pressed: boolean) => void): void;
  stop(): void;
}

/**
 * The native listener (`native/keywatch`, copied to `dist/native/keywatch.node` by the build), or why there is none: the
 * module is missing (a build without it) or does not load here.
 */
export function nativeKeyListener(file: string): KeyListener | { unavailable: string } {
  try {
    return createRequire(import.meta.url)(file) as KeyListener;
  } catch (e) {
    return { unavailable: `the key listener module does not load (${file}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
}

/** Why the listener cannot run, in the words of the log (the Wayland case named, docs/DESKTOP.md "Hotkeys"). */
export function unavailableReason(reason: string, env: NodeJS.ProcessEnv): string {
  if (!env.DISPLAY && env.WAYLAND_DISPLAY) {
    return `${reason}; a Wayland session without XWayland: the listener sees the keys of X11 programs only, the hotkeys work while the window has focus`;
  }
  return reason;
}

/** The hotkeys of the app: bindings, whether the client is signed in, the listener while both call for it. */
export class Hotkeys {
  readonly #registry = new Registry();
  readonly #matcher = new Matcher();
  readonly #listener: KeyListener | null;
  readonly #missing: string;
  readonly #emit: (event: HotkeyEvent) => void;
  readonly #log: (message: string) => void;
  #enabled = false;
  #running = false;

  /** `listener`: the native module, or why there is none; `emit`: the events to the client. */
  constructor(listener: KeyListener | { unavailable: string }, emit: (event: HotkeyEvent) => void, log: (message: string) => void = (m) => console.error(m)) {
    if ("unavailable" in listener) {
      this.#listener = null;
      this.#missing = listener.unavailable;
    } else {
      this.#listener = listener;
      this.#missing = "";
    }
    this.#emit = emit;
    this.#log = log;
  }

  /** Binds `text` to `action` (see {@link Registry.bind}); a hold of the old binding ends. */
  bind(action: HotkeyAction, text: string): string {
    const old = this.#registry.get(action);
    const canonical = this.#registry.bind(action, text);
    if (!sameCombo(old, this.#registry.get(action))) this.#end(action);
    this.#update();
    return canonical;
  }

  /** Removes the binding of `action`; a hold of it ends. */
  unbind(action: HotkeyAction): void {
    this.#registry.unbind(action);
    this.#end(action);
    this.#update();
  }

  /** The client signed in or out: the listener runs only while signed in. Returns whether it runs now. */
  setEnabled(enabled: boolean): boolean {
    this.#enabled = enabled;
    return this.#update();
  }

  /** Whether the listener runs. */
  get running(): boolean {
    return this.#running;
  }

  /** Stops the listener (the app quits). */
  shutdown(): void {
    this.#enabled = false;
    this.#update();
  }

  #send(events: Iterable<HotkeyEvent | null>): void {
    for (const e of events) if (e) this.#emit(e);
  }

  #end(action: HotkeyAction): void {
    this.#send([this.#matcher.end(action)]);
  }

  /** Starts or stops the listener as the bindings and the sign-in call for it, and hands it the keys to watch. */
  #update(): boolean {
    const keys = this.#registry.keys();
    const wanted = this.#enabled && keys.length > 0;
    this.#listener?.setKeys(wanted ? keys : []);
    if (wanted && !this.#running) {
      if (!this.#listener) {
        this.#log(`tavrn: no key listener: ${unavailableReason(this.#missing, process.env)}`);
        throw new HotkeyError("hotkey.unavailable");
      }
      try {
        this.#listener.start((code, pressed) => this.#send(this.#matcher.key(code, pressed, this.#registry)));
      } catch (e) {
        this.#log(`tavrn: no key listener: ${unavailableReason(e instanceof Error ? e.message : String(e), process.env)}`);
        throw new HotkeyError("hotkey.unavailable");
      }
      this.#running = true;
    } else if (!wanted && this.#running) {
      this.#listener?.stop();
      this.#running = false;
      this.#send(this.#matcher.reset());
    }
    return this.#running;
  }
}

export interface HotkeyDeps {
  hotkeys: Hotkeys;
}

/** The `hotkeys` namespace of the bridge (the Tauri shell's `register_hotkey`, `unregister_hotkey`, `set_hotkeys_enabled`). */
export function registerHotkeyHandlers(registry: IpcRegistry, deps: HotkeyDeps): void {
  const action = check.oneOf(...ACTIONS);
  // Longer texts reach the parser, which refuses them as `hotkey.invalid` like the Tauri shell.
  registry.handle("hotkeys", "registerHotkey", check.args([action, check.string(1024)]), (a: HotkeyAction, combo: string) => deps.hotkeys.bind(a, combo));
  registry.handle("hotkeys", "unregisterHotkey", check.args([action]), (a: HotkeyAction) => deps.hotkeys.unbind(a));
  registry.handle("hotkeys", "setHotkeysEnabled", check.args([check.bool]), (enabled: boolean) => deps.hotkeys.setEnabled(enabled));
}
