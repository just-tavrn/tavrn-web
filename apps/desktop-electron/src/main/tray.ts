// SPDX-License-Identifier: Apache-2.0
/**
 * The tray icon (docs/DESKTOP.md "Tray and close to tray", the Tauri shell's `tray.rs`): the voice state of the client
 * as the logo with a status badge (`tray_icon.ts`), a tooltip with the channel and the state, and a menu: show/hide the
 * window, mute, deafen, leave voice, quit. The client's voice store drives it (`traySet`, at most every 150 ms); the
 * voice items of the menu go back to the client as shell events (`{ kind: "tray", action }`). A left click on the icon
 * shows the window.
 *
 * Linux: Electron's `Tray` speaks the StatusNotifierItem protocol (what libayatana-appindicator does for the Tauri
 * shell), so KDE, Xfce, Cinnamon, MATE, Budgie, Ubuntu's GNOME and GNOME with the AppIndicator extension show it; plain
 * GNOME without the extension shows nothing (the app keeps running, a second start shows the window). The menu is
 * rebuilt on every change (Linux trays take a menu only as a whole).
 *
 * "Close to tray" (Settings → App, default on): closing the window hides it while there is a tray icon; the tray menu or
 * starting the app again shows it, Quit (tray menu, Settings → App) ends the app.
 */
import type { Menu, NativeImage, Tray, nativeImage } from "electron";
import type { Settings } from "./config.ts";
import type { BridgeEvent, TrayAction } from "./events.ts";
import { check, type IpcRegistry } from "./ipc.ts";
import { trayIconPng, type Badge, type Image } from "./tray_icon.ts";

export type VoiceState = "disconnected" | "connected" | "speaking" | "muted" | "deafened";
export const VOICE_STATES: readonly VoiceState[] = ["disconnected", "connected", "speaking", "muted", "deafened"];

const MAX_LABEL = 64;
const MAX_TOOLTIP = 128;

/** The texts of the tray in the client's language. */
export interface Labels {
  tooltip: string;
  show: string;
  hide: string;
  mute: string;
  deafen: string;
  leave: string;
  quit: string;
}

/** Until the client sends its texts. */
export const DEFAULT_LABELS: Readonly<Labels> = Object.freeze({
  tooltip: "tavrn",
  show: "Show tavrn",
  hide: "Hide tavrn",
  mute: "Mute microphone",
  deafen: "Deafen",
  leave: "Leave voice channel",
  quit: "Quit tavrn",
});

const isControl = (c: string) => {
  const code = c.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

/** Non-empty, bounded (characters), no control characters; throws `tray.invalid`. */
export function validateLabels(l: Labels): void {
  const ok = (s: string, max: number) => s.trim() !== "" && [...s].length <= max && ![...s].some(isControl);
  const menu = [l.show, l.hide, l.mute, l.deafen, l.leave, l.quit];
  if (!ok(l.tooltip, MAX_TOOLTIP) || !menu.every((m) => ok(m, MAX_LABEL))) throw "tray.invalid";
}

/** What the tray shows for a state. */
export interface View {
  badge: Badge | null;
  muteChecked: boolean;
  deafenChecked: boolean;
  /** Mute, deafen and leave apply only in a voice channel or call. */
  voiceItems: boolean;
}

export function view(state: VoiceState): View {
  if (state === "disconnected") return { badge: null, muteChecked: false, deafenChecked: false, voiceItems: false };
  // Deafened mutes the microphone too (the client does both).
  return { badge: state, muteChecked: state === "muted" || state === "deafened", deafenChecked: state === "deafened", voiceItems: true };
}

export type MenuId = "window" | "mute" | "deafen" | "leave" | "quit";
export type MenuEntry = { type: "separator" } | { type: "normal" | "checkbox"; id: MenuId; label: string; checked?: boolean; enabled: boolean };

/** The tray's menu for a state (the Tauri shell's items and order). */
export function menu(state: VoiceState, labels: Labels, windowVisible: boolean): MenuEntry[] {
  const v = view(state);
  return [
    { type: "normal", id: "window", label: windowVisible ? labels.hide : labels.show, enabled: true },
    { type: "separator" },
    { type: "checkbox", id: "mute", label: labels.mute, checked: v.muteChecked, enabled: v.voiceItems },
    { type: "checkbox", id: "deafen", label: labels.deafen, checked: v.deafenChecked, enabled: v.voiceItems },
    { type: "normal", id: "leave", label: labels.leave, enabled: v.voiceItems },
    { type: "separator" },
    { type: "normal", id: "quit", label: labels.quit, enabled: true },
  ];
}

/** The tray icon of the platform (Electron's `Tray`, a fake in tests). */
export interface TrayHost {
  show(icon: Badge | null, tooltip: string, entries: MenuEntry[]): void;
}

export interface TrayDeps {
  /** Creates the icon (after the app is ready); throws or answers null when the desktop offers no tray. */
  createHost(onMenu: (id: MenuId) => void, onClick: () => void): TrayHost | null;
  settings: Settings;
  events: { send(event: BridgeEvent): boolean };
  /** The main window is on screen (visible and not minimized). */
  windowVisible(): boolean;
  showMain(): void;
  hideMain(): void;
  quit(): void;
}

/** `ShellTrayStatus` of the client's bridge. */
export interface TrayStatus {
  state: VoiceState;
  tooltip: string;
  available: boolean;
  close_to_tray: boolean;
}

/** "Close to tray" unless the settings say otherwise: on (the owner's choice for every platform). */
export const CLOSE_TO_TRAY_DEFAULT = true;

export class TrayController {
  readonly #deps: TrayDeps;
  #host: TrayHost | null = null;
  #state: VoiceState = "disconnected";
  #labels: Labels = { ...DEFAULT_LABELS };

  constructor(deps: TrayDeps) {
    this.#deps = deps;
  }

  /** Creates the tray icon (once, when the app is ready); a desktop without a tray keeps only the state. */
  create(): void {
    if (this.#host) return;
    try {
      this.#host = this.#deps.createHost(
        (id) => this.#menu(id),
        () => this.#deps.showMain(),
      );
    } catch (e) {
      console.error("tavrn: no tray icon:", e);
      this.#host = null;
    }
    this.#apply();
  }

  get available(): boolean {
    return this.#host !== null;
  }

  #apply(): void {
    this.#host?.show(view(this.#state).badge, this.#labels.tooltip, menu(this.#state, this.#labels, this.#deps.windowVisible()));
  }

  #menu(id: MenuId): void {
    const tray = (action: TrayAction) => this.#deps.events.send({ channel: "shell_events", event: { kind: "tray", action } });
    if (id === "window") {
      if (this.#deps.windowVisible()) this.#deps.hideMain();
      else this.#deps.showMain();
      this.#apply();
    } else if (id === "mute" || id === "deafen" || id === "leave") {
      tray(id);
      // A check item toggles itself when clicked; the client's next state sets it right.
      this.#apply();
    } else if (id === "quit") this.#deps.quit();
  }

  /** The client's voice state and the texts of the tray; throws `tray.invalid`. */
  set(state: VoiceState, labels: Labels): void {
    validateLabels(labels);
    this.#state = state;
    this.#labels = { ...labels };
    this.#apply();
  }

  /** The show/hide item follows the window. */
  windowChanged(): void {
    this.#apply();
  }

  /** Whether closing the window hides it into the tray (only with a tray icon). */
  closesToTray(): boolean {
    return this.available && (this.#deps.settings.get().close_to_tray ?? CLOSE_TO_TRAY_DEFAULT);
  }

  status(): TrayStatus {
    return { state: this.#state, tooltip: this.#labels.tooltip, available: this.available, close_to_tray: this.closesToTray() };
  }
}

/** The part of a `BrowserWindow` close to tray needs. */
export interface WindowLike {
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
  on(event: "show" | "hide" | "minimize" | "restore" | "focus", listener: () => void): unknown;
  hide(): void;
}

/** Close to tray for the main window; `quitting`: the app is ending (Quit, `app.quit()`), the window really closes. */
export function attachWindow(win: WindowLike, tray: TrayController, quitting: () => boolean): void {
  win.on("close", (event) => {
    if (quitting() || !tray.closesToTray()) return;
    event.preventDefault();
    win.hide();
  });
  for (const e of ["show", "hide", "minimize", "restore", "focus"] as const) win.on(e, () => tray.windowChanged());
}

const label = check.string(MAX_TOOLTIP * 4);

/** The `tray` namespace of the bridge. */
export function registerTrayHandlers(registry: IpcRegistry, deps: { tray: TrayController; settings: Settings; quit: () => void }): void {
  const labels = check.record({ tooltip: label, show: label, hide: label, mute: label, deafen: label, leave: label, quit: label });
  registry.handle("tray", "traySet", check.args([check.oneOf(...VOICE_STATES), labels]), (state: VoiceState, l: Labels) => deps.tray.set(state, l));
  registry.handle("tray", "trayStatus", check.args([]), () => deps.tray.status());
  registry.handle("tray", "setCloseToTray", check.args([check.bool]), (on: boolean) => deps.settings.update((c) => ({ ...c, close_to_tray: on })));
  registry.handle("tray", "quitApp", check.args([]), () => deps.quit());
}

/** The parts of Electron the tray icon needs (type-only here: the main process passes them in). */
export interface ElectronTrayApi {
  Tray: typeof Tray;
  Menu: typeof Menu;
  nativeImage: typeof nativeImage;
}

/** The tray icon over Electron's `Tray`: the five icons drawn once from the logo, the menu rebuilt on every change. */
export function electronTrayHost(electron: ElectronTrayApi, base: Image, onMenu: (id: MenuId) => void, onClick: () => void): TrayHost {
  const icons = new Map<Badge | null, NativeImage>();
  const icon = (badge: Badge | null) => {
    let image = icons.get(badge);
    if (!image) {
      image = electron.nativeImage.createFromBuffer(trayIconPng(base, badge));
      icons.set(badge, image);
    }
    return image;
  };
  const tray = new electron.Tray(icon(null));
  tray.on("click", onClick);
  let shown = { badge: undefined as Badge | null | undefined, tooltip: "", menu: "" };
  // A clicked check item toggled itself: the next state rebuilds the menu even when it did not change.
  const clicked = (id: MenuId) => {
    shown.menu = "";
    onMenu(id);
  };
  return {
    show(badge, tooltip, entries) {
      if (badge !== shown.badge) tray.setImage(icon(badge));
      if (tooltip !== shown.tooltip) tray.setToolTip(tooltip);
      const key = JSON.stringify(entries);
      if (key !== shown.menu) {
        tray.setContextMenu(
          electron.Menu.buildFromTemplate(
            entries.map((e) => (e.type === "separator" ? { type: "separator" as const } : { type: e.type, label: e.label, checked: e.checked, enabled: e.enabled, click: () => clicked(e.id) })),
          ),
        );
      }
      shown = { badge, tooltip, menu: key };
    },
  };
}
