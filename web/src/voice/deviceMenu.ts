// SPDX-License-Identifier: Apache-2.0
/**
 * The quick menus of the microphone and headphones buttons (voice bar and stage controls): the input or output
 * devices as checkbox items, push-to-talk for the microphone, the link to Settings → Voice & video. A pure function
 * over the device list and the settings, so the menu is unit-tested; choosing an item only changes the voice settings,
 * which a running call follows live (`session.ts`, `applySettings`).
 */
import { menuItem, menuLabel, normalizeMenu, separator, type MenuEntry } from "../components/ContextMenu";
import type { VoiceSettings } from "./settings";

type T = (key: string, params?: Record<string, string | number>) => string;

export type VoiceDeviceKind = "input" | "output";

export interface VoiceDeviceMenuContext {
  /** Every device as `enumerateDevices()` lists it (`useMediaDevices`). */
  devices: MediaDeviceInfo[];
  settings: Pick<VoiceSettings, "inputDeviceId" | "outputDeviceId" | "inputMode">;
  /** The names are hidden until the page may use the microphone: offer "Show devices". */
  needsPermission: boolean;
  /** The browser can choose the output device (`HTMLMediaElement.setSinkId`). */
  sinkSupported: boolean;
  /** The push-to-talk binding as printed on the keyboard; empty = none. */
  pttKey: string;
}

export interface VoiceDeviceMenuActions {
  update: (patch: Partial<VoiceSettings>) => void;
  /** Asks for the microphone once, so the device names appear. */
  unlock: () => void;
  openSettings: () => void;
}

/** The menu of the microphone (`input`) or the headphones (`output`) button. */
export function voiceDeviceMenu(kind: VoiceDeviceKind, ctx: VoiceDeviceMenuContext, actions: VoiceDeviceMenuActions, t: T): MenuEntry[] {
  const input = kind === "input";
  const mediaKind: MediaDeviceKind = input ? "audioinput" : "audiooutput";
  const field = input ? "inputDeviceId" : "outputDeviceId";
  const current = ctx.settings[field];
  const name = t(input ? "voice.settings.microphone" : "voice.settings.speaker");
  const choose = (id: string) => () => actions.update({ [field]: id });
  // As in the settings tab: the system default first; the browser's "default" alias and nameless entries are not devices.
  const named = ctx.devices.filter((d) => d.kind === mediaKind && d.deviceId && d.deviceId !== "default");
  const list = !input && !ctx.sinkSupported
    ? [menuItem("output-unsupported", t("voice.menu.output_unsupported"), undefined, { disabled: true })]
    : [
        menuItem("device:", t("voice.settings.default_device"), choose(""), { checked: current === "" }),
        ...named.map((d, i) => menuItem(`device:${d.deviceId}`, d.label || `${name} ${i + 1}`, choose(d.deviceId), { checked: d.deviceId === current })),
        ctx.needsPermission && menuItem("show-devices", t("voice.settings.devices_show"), actions.unlock, { keepOpen: true }),
      ];
  return normalizeMenu([
    menuLabel("label", t(input ? "voice.menu.microphone" : "voice.menu.output")),
    ...list,
    separator("sep-mode"),
    input && menuItem("ptt", t("voice.menu.ptt"), () => actions.update({ inputMode: ctx.settings.inputMode === "ptt" ? "vad" : "ptt" }), { checked: ctx.settings.inputMode === "ptt", keepOpen: true, hint: ctx.pttKey || undefined }),
    separator("sep-settings"),
    menuItem("settings", t("voice.menu.settings"), actions.openSettings),
  ]);
}
