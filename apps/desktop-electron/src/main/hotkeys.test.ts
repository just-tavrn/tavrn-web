// SPDX-License-Identifier: Apache-2.0
// The hotkeys of the Electron shell: the cases of the Tauri shell's hotkeys.rs, the key table against the crate's, the
// listener's life cycle with a fake listener and the bridge's handlers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HotkeyAction } from "./events.ts";
import { HotkeyError, Hotkeys, KEY_CODES, Matcher, Registry, comboKeys, formatCombo, parseCombo, registerHotkeyHandlers, unavailableReason, type HotkeyEvent, type KeyListener } from "./hotkeys.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";

const canonical = (text: string) => formatCombo(parseCombo(text));
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof HotkeyError ? e.code : String(e);
  }
};

test("the key table is the crate's (keys.rs), in the same order", () => {
  const rust = readFileSync(new URL("../../../desktop/crates/keywatch/src/keys.rs", import.meta.url), "utf8");
  const codes = [...rust.matchAll(/^\s*\("(\w+)", \d+, 0x[0-9a-f]+\),$/gm)].map((m) => m[1]);
  assert.ok(codes.length > 100, `${codes.length} keys found in keys.rs`);
  assert.deepEqual(KEY_CODES, codes);
});

test("parses and formats bindings in a fixed order", () => {
  assert.equal(canonical("Ctrl+Shift+KeyM"), "Ctrl+Shift+KeyM");
  assert.equal(canonical("shift+control+KeyM"), "Ctrl+Shift+KeyM");
  assert.equal(canonical("Super+Alt+Shift+Ctrl+Digit1"), "Ctrl+Alt+Shift+Super+Digit1");
  assert.equal(canonical("F13"), "F13");
  assert.equal(canonical("Alt + Numpad1"), "Alt+Numpad1");
  assert.equal(canonical("Option+KeyT"), "Alt+KeyT");
  for (const spelling of ["Super+KeyM", "Cmd+KeyM", "Command+KeyM", "Win+KeyM", "Meta+KeyM", "SUPER+KeyM"]) {
    assert.equal(canonical(spelling), "Super+KeyM", spelling);
  }
});

test("plain keys and lone modifiers are bindings", () => {
  for (const single of ["KeyV", "Backquote", "Space", "ControlLeft", "ShiftRight", "AltRight", "MetaLeft", "CapsLock", "Digit1", "Enter"]) {
    assert.equal(canonical(single), single);
  }
  assert.equal(canonical("Shift+ControlLeft"), "Shift+ControlLeft", "another modifier with a modifier key");
});

test("refuses invalid bindings", () => {
  for (const bad of ["", "+", "Ctrl+", "Ctrl", "Ctrl+Shift", "KeyQ+KeyM", "Ctrl+KeyQ+KeyM", "Hyper+KeyM", "Ctrl+Ctrl+KeyM", "Ctrl+keym", "Ctrl+ControlLeft", "Shift+ShiftRight", "Ctrl+Unknown", "Ctrl+F25", "constructor", "toString+KeyM", "__proto__+KeyM"]) {
    assert.equal(codeOf(() => parseCombo(bad)), "hotkey.invalid", JSON.stringify(bad));
  }
  assert.equal(codeOf(() => parseCombo(`Ctrl+${"K".repeat(70)}`)), "hotkey.invalid");
});

test("a combination watches its key and both sides of its modifiers", () => {
  assert.deepEqual(comboKeys(parseCombo("ControlLeft")), ["ControlLeft"]);
  assert.deepEqual(comboKeys(parseCombo("Ctrl+Shift+KeyM")), ["KeyM", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"]);
});

test("binds, replaces and refuses duplicates", () => {
  const r = new Registry();
  assert.equal(r.bind("toggle_mute", "ctrl+shift+KeyM"), "Ctrl+Shift+KeyM");
  assert.equal(r.bind("toggle_mute", "F14"), "F14");
  assert.equal(formatCombo(r.get("toggle_mute")!), "F14");
  try {
    r.bind("push_to_talk", "F14");
    assert.fail("a duplicate was bound");
  } catch (e) {
    assert.ok(e instanceof HotkeyError);
    assert.equal(e.message, "hotkey.duplicate");
    assert.equal(e.action, "toggle_mute");
  }
  assert.equal(r.get("push_to_talk"), undefined);
  assert.equal(r.bind("push_to_talk", "Ctrl+F14"), "Ctrl+F14", "a combination with the key is another binding");
  r.unbind("toggle_mute");
  r.unbind("toggle_mute");
  assert.equal(r.get("toggle_mute"), undefined);
});

/** Feeds key events (`+Code` press, `-Code` release) through a matcher. */
function run(bindings: [HotkeyAction, string][], keys: string[]): [HotkeyAction, boolean][] {
  const r = new Registry();
  for (const [a, t] of bindings) r.bind(a, t);
  const m = new Matcher();
  return keys.flatMap((k) => m.key(k.slice(1), k.startsWith("+"), r).map((e) => [e.action, e.pressed] as [HotkeyAction, boolean]));
}

test("matcher: a single key", () => {
  const ptt: [HotkeyAction, string][] = [["push_to_talk", "KeyV"]];
  assert.deepEqual(run(ptt, ["+KeyV", "-KeyV"]), [["push_to_talk", true], ["push_to_talk", false]]);
  assert.deepEqual(run(ptt, ["+KeyB", "-KeyB"]), [], "other keys do nothing");
  // Extra modifiers are fine: Shift to run while holding push-to-talk, pressed before or during the hold.
  assert.deepEqual(run(ptt, ["+ShiftLeft", "+KeyV", "-ShiftLeft", "-KeyV"]), [["push_to_talk", true], ["push_to_talk", false]]);
});

test("matcher: a lone modifier", () => {
  const ptt: [HotkeyAction, string][] = [["push_to_talk", "ControlLeft"]];
  assert.deepEqual(run(ptt, ["+ControlLeft", "+KeyC", "-KeyC", "-ControlLeft"]), [["push_to_talk", true], ["push_to_talk", false]]);
  assert.deepEqual(run(ptt, ["+ControlRight", "-ControlRight"]), [], "only the left one");
});

test("matcher: a combination", () => {
  const mute: [HotkeyAction, string][] = [["toggle_mute", "Ctrl+Shift+KeyM"]];
  assert.deepEqual(run(mute, ["+ControlRight", "+ShiftLeft", "+KeyM", "-KeyM"]), [["toggle_mute", true], ["toggle_mute", false]]);
  assert.deepEqual(run(mute, ["+ShiftLeft", "+KeyM", "-KeyM"]), [], "Ctrl missing");
  assert.deepEqual(run(mute, ["+KeyM", "+ControlLeft", "+ShiftLeft"]), [], "the key must come last");
  // Letting go of a modifier ends the hold.
  assert.deepEqual(run(mute, ["+ControlLeft", "+ShiftLeft", "+KeyM", "-ShiftLeft", "-KeyM"]), [["toggle_mute", true], ["toggle_mute", false]]);
  // The binding with more modifiers wins over the one it contains.
  const both: [HotkeyAction, string][] = [["toggle_mute", "Ctrl+KeyM"], ["toggle_deafen", "Ctrl+Shift+KeyM"]];
  assert.deepEqual(run(both, ["+ControlLeft", "+ShiftLeft", "+KeyM", "-KeyM"]), [["toggle_deafen", true], ["toggle_deafen", false]]);
  assert.deepEqual(run(both, ["+ControlLeft", "+KeyM", "-KeyM"]), [["toggle_mute", true], ["toggle_mute", false]]);
});

test("matcher: release and key repeat", () => {
  const ptt: [HotkeyAction, string][] = [["push_to_talk", "KeyV"], ["priority", "KeyB"]];
  // Key repeat sends presses while the key is held: one press, one release.
  assert.deepEqual(run(ptt, ["+KeyV", "+KeyV", "+KeyV", "-KeyV"]), [["push_to_talk", true], ["push_to_talk", false]]);
  // A release without a press (the press happened before the listener started) does nothing.
  assert.deepEqual(run(ptt, ["-KeyV"]), []);
  // Two actions held at once, released in any order.
  assert.deepEqual(run(ptt, ["+KeyV", "+KeyB", "-KeyV", "-KeyB"]), [["push_to_talk", true], ["priority", true], ["push_to_talk", false], ["priority", false]]);
});

test("matcher: ends holds when asked", () => {
  const r = new Registry();
  r.bind("push_to_talk", "KeyV");
  const m = new Matcher();
  assert.equal(m.key("KeyV", true, r).length, 1);
  assert.deepEqual(m.end("push_to_talk"), { action: "push_to_talk", pressed: false });
  assert.equal(m.end("push_to_talk"), null);
  assert.deepEqual(m.key("KeyV", true, r), [], "still down: a repeat");
  assert.deepEqual(m.reset(), []);
  assert.equal(m.key("KeyV", true, r).length, 1, "after a reset the next press counts");
  assert.deepEqual(m.reset(), [{ action: "push_to_talk", pressed: false }]);
});

/** A listener that records its life cycle and lets the test press keys (only those of the filter get through). */
class FakeListener implements KeyListener {
  starts = 0;
  stops = 0;
  keys: string[] = [];
  refuse = false;
  #callback: ((code: string, pressed: boolean) => void) | null = null;
  setKeys(codes: string[]) {
    this.keys = codes;
  }
  start(callback: (code: string, pressed: boolean) => void) {
    if (this.refuse) throw new Error("keywatch.unavailable: no X display: connection refused");
    if (this.#callback) throw new Error("keywatch.running");
    this.starts++;
    this.#callback = callback;
  }
  stop() {
    if (this.#callback) this.stops++;
    this.#callback = null;
  }
  press(code: string, pressed: boolean) {
    if (this.keys.includes(code)) this.#callback?.(code, pressed);
  }
}

function hotkeys(listener: KeyListener | { unavailable: string }) {
  const seen: HotkeyEvent[] = [];
  const logs: string[] = [];
  return { h: new Hotkeys(listener, (e) => seen.push(e), (m) => logs.push(m)), seen, logs };
}

test("the listener runs only while signed in with bindings", () => {
  const listener = new FakeListener();
  const { h } = hotkeys(listener);
  assert.equal(h.bind("push_to_talk", "ControlLeft"), "ControlLeft");
  assert.equal(h.running, false, "not signed in: no listener");
  assert.deepEqual(listener.keys, [], "and an empty filter");
  assert.equal(h.setEnabled(true), true);
  assert.equal(listener.starts, 1);
  h.bind("toggle_mute", "Ctrl+Shift+KeyM");
  assert.equal(listener.starts, 1, "a new binding only changes the filter");
  assert.deepEqual(listener.keys.sort(), ["ControlLeft", "ControlRight", "KeyM", "ShiftLeft", "ShiftRight"]);
  h.unbind("push_to_talk");
  h.unbind("toggle_mute");
  assert.equal(h.running, false, "no bindings: the listener stops");
  assert.equal(listener.stops, 1);
  h.bind("priority", "F13");
  assert.equal(h.running, true);
  assert.equal(h.setEnabled(false), false, "signed out: the listener stops");
  assert.equal(listener.stops, 2);
  assert.deepEqual(listener.keys, []);
  h.setEnabled(true);
  h.shutdown();
  assert.equal(h.running, false, "the app quits: the listener stops");
});

test("presses reach the client as actions and a stop releases what is held", () => {
  const listener = new FakeListener();
  const { h, seen } = hotkeys(listener);
  h.bind("push_to_talk", "ControlLeft");
  h.bind("toggle_mute", "Ctrl+Alt+KeyM");
  h.setEnabled(true);
  listener.press("ControlLeft", true);
  listener.press("KeyA", true);
  listener.press("ControlLeft", true);
  listener.press("ControlLeft", false);
  assert.deepEqual(seen, [
    { action: "push_to_talk", pressed: true },
    { action: "push_to_talk", pressed: false },
  ]);
  // Held while the client signs out: the hold ends with the listener.
  listener.press("ControlLeft", true);
  h.setEnabled(false);
  assert.deepEqual(seen.slice(2), [
    { action: "push_to_talk", pressed: true },
    { action: "push_to_talk", pressed: false },
  ]);
});

test("rebinding a held action releases it, the same binding again keeps the hold", () => {
  const listener = new FakeListener();
  const { h, seen } = hotkeys(listener);
  h.bind("push_to_talk", "KeyV");
  h.setEnabled(true);
  listener.press("KeyV", true);
  assert.equal(h.bind("push_to_talk", "KeyV"), "KeyV");
  assert.equal(seen.length, 1);
  h.bind("push_to_talk", "KeyB");
  assert.deepEqual(seen, [
    { action: "push_to_talk", pressed: true },
    { action: "push_to_talk", pressed: false },
  ]);
});

test("without a listener the binding stays and unavailable is reported, with the reason in the log", () => {
  const listener = new FakeListener();
  listener.refuse = true;
  const { h, logs } = hotkeys(listener);
  assert.equal(h.setEnabled(true), false, "nothing bound: nothing to start");
  assert.equal(codeOf(() => h.bind("push_to_talk", "KeyV")), "hotkey.unavailable");
  assert.equal(codeOf(() => h.setEnabled(true)), "hotkey.unavailable", "kept for the window: the listener is still wanted");
  assert.match(logs[0] ?? "", /^tavrn: no key listener: keywatch\.unavailable: no X display/);
  // A build without the module says so too.
  const missing = hotkeys({ unavailable: "the key listener module does not load" });
  missing.h.setEnabled(true);
  assert.equal(codeOf(() => missing.h.bind("priority", "F13")), "hotkey.unavailable");
  assert.match(missing.logs[0] ?? "", /module does not load/);
});

test("the log names the Wayland limitation", () => {
  assert.match(unavailableReason("keywatch.unavailable: no X display", { WAYLAND_DISPLAY: "wayland-0" }), /Wayland session without XWayland.*work while the window has focus/);
  assert.equal(unavailableReason("x", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }), "x");
});

test("the bridge's hotkeys namespace: checked arguments, the Tauri shell's answers and refusals", async () => {
  const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };
  const listener = new FakeListener();
  const { h, seen } = hotkeys(listener);
  const registry = new IpcRegistry((e) => e === me);
  registerHotkeyHandlers(registry, { hotkeys: h });
  const call = (method: string, ...args: unknown[]) => registry.dispatch(`tavrn:hotkeys.${method}`, method, me, args);
  assert.deepEqual(await call("registerHotkey", "toggle_mute", "ctrl+alt+KeyM"), { ok: true, value: "Ctrl+Alt+KeyM" });
  assert.deepEqual(await call("registerHotkey", "push_to_talk", "Ctrl+Alt+KeyM"), { ok: false, error: "hotkey.duplicate" });
  assert.deepEqual(await call("registerHotkey", "push_to_talk", "Ctrl+"), { ok: false, error: "hotkey.invalid" });
  assert.deepEqual(await call("registerHotkey", "push_to_talk", `Ctrl+${"K".repeat(200)}`), { ok: false, error: "hotkey.invalid" });
  assert.deepEqual(await call("registerHotkey", "shutdown", "KeyV"), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("registerHotkey", "push_to_talk"), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("registerHotkey", "push_to_talk", "K".repeat(2000)), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("setHotkeysEnabled", "yes"), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("setHotkeysEnabled", true), { ok: true, value: true });
  listener.press("ControlLeft", true);
  listener.press("AltRight", true);
  listener.press("KeyM", true);
  assert.deepEqual(seen, [{ action: "toggle_mute", pressed: true }]);
  assert.deepEqual(await call("unregisterHotkey", "toggle_mute"), { ok: true, value: undefined });
  assert.deepEqual(seen.at(-1), { action: "toggle_mute", pressed: false });
  assert.equal(h.running, false);
  assert.deepEqual(await call("unregisterHotkey", 1), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("setHotkeysEnabled", false), { ok: true, value: false });
});
