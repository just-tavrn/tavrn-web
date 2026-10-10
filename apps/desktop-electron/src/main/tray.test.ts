// SPDX-License-Identifier: Apache-2.0
// The tray (the Tauri shell's tray.rs cases): states, menu, labels, close to tray, the handlers, with a fake tray host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, loadConfig } from "./config.ts";
import type { BridgeEvent } from "./events.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import { DEFAULT_LABELS, TrayController, attachWindow, menu, registerTrayHandlers, validateLabels, view, type MenuEntry, type MenuId, type TrayHost, type WindowLike } from "./tray.ts";
import type { Badge } from "./tray_icon.ts";

test("states map to badges and menu states", () => {
  assert.deepEqual(view("disconnected"), { badge: null, muteChecked: false, deafenChecked: false, voiceItems: false });
  assert.deepEqual(view("connected"), { badge: "connected", muteChecked: false, deafenChecked: false, voiceItems: true });
  assert.deepEqual(view("speaking"), { badge: "speaking", muteChecked: false, deafenChecked: false, voiceItems: true });
  assert.deepEqual(view("muted"), { badge: "muted", muteChecked: true, deafenChecked: false, voiceItems: true });
  assert.deepEqual(view("deafened"), { badge: "deafened", muteChecked: true, deafenChecked: true, voiceItems: true });
});

test("the menu has the Tauri shell's items in its order; the window item follows the window", () => {
  const entries = menu("muted", DEFAULT_LABELS, true);
  assert.deepEqual(
    entries.map((e) => (e.type === "separator" ? "-" : e.id)),
    ["window", "-", "mute", "deafen", "leave", "-", "quit"],
  );
  assert.deepEqual(entries[0], { type: "normal", id: "window", label: "Hide tavrn", enabled: true });
  assert.deepEqual(entries[2], { type: "checkbox", id: "mute", label: "Mute microphone", checked: true, enabled: true });
  assert.equal((menu("connected", DEFAULT_LABELS, false)[0] as { label: string }).label, "Show tavrn");
  const idle = menu("disconnected", DEFAULT_LABELS, false).filter((e) => e.type !== "separator") as Array<{ id: MenuId; enabled: boolean }>;
  assert.deepEqual(
    idle.filter((e) => !e.enabled).map((e) => e.id),
    ["mute", "deafen", "leave"],
    "voice items only in a voice channel",
  );
});

test("labels are bounded", () => {
  validateLabels(DEFAULT_LABELS);
  assert.throws(() => validateLabels({ ...DEFAULT_LABELS, mute: "m".repeat(65) }), (e) => e === "tray.invalid");
  assert.throws(() => validateLabels({ ...DEFAULT_LABELS, quit: " " }), (e) => e === "tray.invalid");
  assert.throws(() => validateLabels({ ...DEFAULT_LABELS, tooltip: "tavrn\u001b[31m" }), (e) => e === "tray.invalid");
  assert.throws(() => validateLabels({ ...DEFAULT_LABELS, tooltip: "t".repeat(129) }), (e) => e === "tray.invalid");
  validateLabels({
    tooltip: "tavrn · Allgemein (Gaming) · Stummgeschaltet",
    show: "tavrn anzeigen",
    hide: "tavrn ausblenden",
    mute: "Mikrofon stummschalten",
    deafen: "Taub schalten",
    leave: "Sprachkanal verlassen",
    quit: "tavrn beenden",
  });
});

function setup(t: { after: (fn: () => void) => void }, opts: { tray?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "tavrn-electron-tray-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const settings = new Settings(join(d, "settings.json"));
  const sent: BridgeEvent[] = [];
  const shown: Array<{ badge: Badge | null; tooltip: string; entries: MenuEntry[] }> = [];
  const calls: string[] = [];
  let visible = true;
  let clickMenu: (id: MenuId) => void = () => undefined;
  let clickIcon: () => void = () => undefined;
  const tray = new TrayController({
    createHost: (onMenu, onClick) => {
      if (opts.tray === false) throw new Error("no tray on this desktop");
      clickMenu = onMenu;
      clickIcon = onClick;
      return { show: (badge, tooltip, entries) => void shown.push({ badge, tooltip, entries }) } satisfies TrayHost;
    },
    settings,
    events: { send: (e) => (sent.push(e), true) },
    windowVisible: () => visible,
    showMain: () => {
      calls.push("show");
      visible = true;
    },
    hideMain: () => {
      calls.push("hide");
      visible = false;
    },
    quit: () => void calls.push("quit"),
  });
  return {
    tray,
    settings,
    sent,
    shown,
    calls,
    setVisible: (v: boolean) => (visible = v),
    clickMenu: (id: MenuId) => clickMenu(id),
    clickIcon: () => clickIcon(),
  };
}

test("the tray shows the plain logo until the client sends its state, then its icon, tooltip and menu", (t) => {
  const { tray, shown } = setup(t);
  tray.create();
  assert.equal(tray.available, true);
  assert.equal(shown.at(-1)?.badge, null);
  assert.equal(shown.at(-1)?.tooltip, "tavrn");
  tray.set("speaking", { ...DEFAULT_LABELS, tooltip: "tavrn · Lounge (Gaming) · Speaking" });
  assert.equal(shown.at(-1)?.badge, "speaking");
  assert.equal(shown.at(-1)?.tooltip, "tavrn · Lounge (Gaming) · Speaking");
  assert.deepEqual(tray.status(), { state: "speaking", tooltip: "tavrn · Lounge (Gaming) · Speaking", available: true, close_to_tray: true });
  assert.throws(() => tray.set("muted", { ...DEFAULT_LABELS, show: "" }), (e) => e === "tray.invalid");
  assert.equal(tray.status().state, "speaking", "a refused update changes nothing");
});

test("the voice items of the menu go to the client as shell events; the window item shows and hides; quit quits", (t) => {
  const { tray, sent, calls, shown, clickMenu, clickIcon, setVisible } = setup(t);
  tray.create();
  tray.set("connected", DEFAULT_LABELS);
  clickMenu("mute");
  clickMenu("deafen");
  clickMenu("leave");
  assert.deepEqual(sent, [
    { channel: "shell_events", event: { kind: "tray", action: "mute" } },
    { channel: "shell_events", event: { kind: "tray", action: "deafen" } },
    { channel: "shell_events", event: { kind: "tray", action: "leave" } },
  ]);
  clickMenu("window");
  assert.deepEqual(calls, ["hide"]);
  assert.equal((shown.at(-1)?.entries[0] as { label: string }).label, "Show tavrn");
  clickMenu("window");
  assert.deepEqual(calls, ["hide", "show"]);
  setVisible(false);
  clickIcon();
  assert.deepEqual(calls, ["hide", "show", "show"], "a left click shows the window");
  clickMenu("quit");
  assert.equal(calls.at(-1), "quit");
});

test("close to tray: on by default with a tray icon, off without one, the setting is persisted", (t) => {
  const { tray, settings } = setup(t);
  assert.equal(tray.closesToTray(), false, "no icon yet");
  tray.create();
  assert.equal(tray.closesToTray(), true);
  settings.update((c) => ({ ...c, close_to_tray: false }));
  assert.equal(tray.closesToTray(), false);
  const none = setup(t, { tray: false });
  none.tray.create();
  assert.equal(none.tray.available, false);
  assert.deepEqual(none.tray.status(), { state: "disconnected", tooltip: "tavrn", available: false, close_to_tray: false });
  none.tray.set("muted", DEFAULT_LABELS);
  assert.equal(none.tray.status().state, "muted", "the state is kept without an icon");
});

type Listener = (e: { preventDefault(): void }) => void;
class FakeWindow implements WindowLike {
  readonly listeners = new Map<string, Listener[]>();
  hidden = 0;
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  hide() {
    this.hidden++;
  }
  /** Emits `close`; true when a listener prevented it. */
  close(): boolean {
    let prevented = false;
    for (const fn of this.listeners.get("close") ?? []) fn({ preventDefault: () => (prevented = true) });
    return prevented;
  }
}

test("closing the window hides it while close to tray is on; quitting really closes it", (t) => {
  const { tray, settings, shown, setVisible } = setup(t);
  tray.create();
  const win = new FakeWindow();
  let quitting = false;
  attachWindow(win, tray, () => quitting);
  assert.equal(win.close(), true);
  assert.equal(win.hidden, 1);
  settings.update((c) => ({ ...c, close_to_tray: false }));
  assert.equal(win.close(), false, "off: the window closes and the app ends");
  settings.update((c) => ({ ...c, close_to_tray: true }));
  quitting = true;
  assert.equal(win.close(), false, "Quit closes the window");
  // The window item follows the window's visibility.
  setVisible(false);
  for (const fn of win.listeners.get("hide") ?? []) fn({ preventDefault: () => undefined });
  assert.equal((shown.at(-1)?.entries[0] as { label: string }).label, "Show tavrn");
});

const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

test("the handlers: traySet, trayStatus, setCloseToTray (persisted), quitApp, odd arguments refused", async (t) => {
  const { tray, settings, calls } = setup(t);
  tray.create();
  const registry = new IpcRegistry((e) => e === me);
  registerTrayHandlers(registry, { tray, settings, quit: () => void calls.push("quit") });
  const call = (method: string, ...args: unknown[]) => registry.dispatch(`tavrn:tray.${method}`, method, me, args);
  assert.deepEqual(await call("traySet", "muted", DEFAULT_LABELS), { ok: true, value: undefined });
  assert.deepEqual(await call("trayStatus"), { ok: true, value: { state: "muted", tooltip: "tavrn", available: true, close_to_tray: true } });
  assert.deepEqual(await call("setCloseToTray", false), { ok: true, value: undefined });
  assert.equal(loadConfig(settings.path).close_to_tray, false);
  assert.deepEqual(await call("trayStatus"), { ok: true, value: { state: "muted", tooltip: "tavrn", available: true, close_to_tray: false } });
  assert.deepEqual(await call("quitApp"), { ok: true, value: undefined });
  assert.equal(calls.at(-1), "quit");
  assert.deepEqual(await call("traySet", "shouting", DEFAULT_LABELS), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("traySet", "muted", { ...DEFAULT_LABELS, extra: "x" }), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("traySet", "muted", { ...DEFAULT_LABELS, mute: 1 }), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("traySet", "muted", { ...DEFAULT_LABELS, mute: "m".repeat(65) }), { ok: false, error: "tray.invalid" });
  assert.deepEqual(await call("setCloseToTray", "yes"), { ok: false, error: "ipc.invalid_arguments" });
});
