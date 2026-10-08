// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findEntry, type MenuEntry, type MenuItem } from "../components/ContextMenu";
import { voiceDeviceMenu, type VoiceDeviceMenuActions, type VoiceDeviceMenuContext } from "./deviceMenu";
import { DEFAULT_SETTINGS, useVoiceSettings } from "./settings";

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key);

const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({ kind, deviceId, label, groupId: "g", toJSON: () => ({}) }) as MediaDeviceInfo;
const DEVICES = [
  device("audioinput", "default", "Default - Headset"),
  device("audioinput", "mic-1", "Headset microphone"),
  device("audioinput", "mic-2", "Webcam microphone"),
  device("audiooutput", "default", "Default - Speakers"),
  device("audiooutput", "out-1", "Speakers"),
  device("audiooutput", "out-2", "Headphones"),
  device("videoinput", "cam-1", "Webcam"),
];
/** What a browser lists before the page may use the microphone: one nameless entry per kind. */
const HIDDEN = [device("audioinput", "", ""), device("audiooutput", "", ""), device("videoinput", "", "")];

const ctx = (patch: Partial<VoiceDeviceMenuContext> = {}): VoiceDeviceMenuContext => ({
  devices: DEVICES,
  settings: { ...DEFAULT_SETTINGS },
  needsPermission: false,
  sinkSupported: true,
  pttKey: "`",
  ...patch,
});
/** The store's own `update`, so choosing an item is checked against the settings that apply to the call. */
const actions = () => ({ update: (p) => useVoiceSettings.getState().update(p), unlock: vi.fn<() => void>(), openSettings: vi.fn<() => void>() }) satisfies VoiceDeviceMenuActions;
const item = (entries: MenuEntry[], id: string) => findEntry(entries, id) as MenuItem;
const devicesOf = (entries: MenuEntry[]) => entries.filter((e): e is MenuItem => e.kind === "item" && e.id.startsWith("device:"));

beforeEach(() => {
  localStorage.clear();
  useVoiceSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

describe("voiceDeviceMenu: microphone", () => {
  it("lists the microphones as checkbox items under its label, the current one checked", () => {
    const entries = voiceDeviceMenu("input", ctx({ settings: { ...DEFAULT_SETTINGS, inputDeviceId: "mic-2" } }), actions(), t);
    expect(entries[0]).toEqual({ kind: "label", id: "label", label: "voice.menu.microphone" });
    // The system default first, then every named microphone (the browser's "default" alias is the system default).
    expect(devicesOf(entries).map((e) => [e.label, e.checked])).toEqual([
      ["voice.settings.default_device", false],
      ["Headset microphone", false],
      ["Webcam microphone", true],
    ]);
    // Never a speaker or a camera in the microphone list.
    expect(findEntry(entries, "device:out-1")).toBeUndefined();
    expect(findEntry(entries, "device:cam-1")).toBeUndefined();
  });

  it("checks the system default when no device is chosen and names unnamed devices by their position", () => {
    const entries = voiceDeviceMenu("input", ctx({ devices: [device("audioinput", "mic-1", ""), device("audioinput", "mic-2", "")] }), actions(), t);
    expect(devicesOf(entries).map((e) => [e.label, e.checked])).toEqual([
      ["voice.settings.default_device", true],
      ["voice.settings.microphone 1", false],
      ["voice.settings.microphone 2", false],
    ]);
  });

  it("choosing a microphone updates the voice settings (the running call follows them)", () => {
    const entries = voiceDeviceMenu("input", ctx(), actions(), t);
    item(entries, "device:mic-1").onSelect!();
    expect(useVoiceSettings.getState().settings.inputDeviceId).toBe("mic-1");
    item(entries, "device:").onSelect!();
    expect(useVoiceSettings.getState().settings.inputDeviceId).toBe("");
  });

  it("toggles push-to-talk both ways and shows the bound key", () => {
    const a = actions();
    const vad = voiceDeviceMenu("input", ctx(), a, t);
    const ptt = item(vad, "ptt");
    expect(ptt).toMatchObject({ label: "voice.menu.ptt", checked: false, hint: "`", keepOpen: true });
    ptt.onSelect!();
    expect(useVoiceSettings.getState().settings.inputMode).toBe("ptt");
    const on = voiceDeviceMenu("input", ctx({ settings: useVoiceSettings.getState().settings }), a, t);
    expect(item(on, "ptt").checked).toBe(true);
    item(on, "ptt").onSelect!();
    expect(useVoiceSettings.getState().settings.inputMode).toBe("vad");
    // Without a binding there is no hint.
    expect(item(voiceDeviceMenu("input", ctx({ pttKey: "" }), a, t), "ptt").hint).toBeUndefined();
  });

  it("offers “Show devices” while the names are hidden", () => {
    const a = actions();
    const entries = voiceDeviceMenu("input", ctx({ devices: HIDDEN, needsPermission: true }), a, t);
    expect(devicesOf(entries).map((e) => e.id)).toEqual(["device:"]);
    const show = item(entries, "show-devices");
    expect(show).toMatchObject({ label: "voice.settings.devices_show", keepOpen: true });
    show.onSelect!();
    expect(a.unlock).toHaveBeenCalledTimes(1);
    expect(findEntry(voiceDeviceMenu("input", ctx(), a, t), "show-devices")).toBeUndefined();
  });

  it("ends with the link to the voice settings, after separators", () => {
    const a = actions();
    const entries = voiceDeviceMenu("input", ctx(), a, t);
    expect(entries.map((e) => (e.kind === "separator" ? "|" : e.id))).toEqual(["label", "device:", "device:mic-1", "device:mic-2", "|", "ptt", "|", "settings"]);
    const settings = item(entries, "settings");
    expect(settings.label).toBe("voice.menu.settings");
    settings.onSelect!();
    expect(a.openSettings).toHaveBeenCalledTimes(1);
  });
});

describe("voiceDeviceMenu: output", () => {
  it("lists the speakers, the current one checked; choosing one updates the settings", () => {
    const entries = voiceDeviceMenu("output", ctx({ settings: { ...DEFAULT_SETTINGS, outputDeviceId: "out-2" } }), actions(), t);
    expect(entries[0]).toEqual({ kind: "label", id: "label", label: "voice.menu.output" });
    expect(devicesOf(entries).map((e) => [e.label, e.checked])).toEqual([
      ["voice.settings.default_device", false],
      ["Speakers", false],
      ["Headphones", true],
    ]);
    item(entries, "device:out-1").onSelect!();
    expect(useVoiceSettings.getState().settings.outputDeviceId).toBe("out-1");
    // No push-to-talk in the output menu.
    expect(findEntry(entries, "ptt")).toBeUndefined();
    expect(entries.map((e) => (e.kind === "separator" ? "|" : e.id))).toEqual(["label", "device:", "device:out-1", "device:out-2", "|", "settings"]);
  });

  it("without setSinkId shows a disabled notice instead of the list", () => {
    const entries = voiceDeviceMenu("output", ctx({ sinkSupported: false, needsPermission: true }), actions(), t);
    expect(devicesOf(entries)).toEqual([]);
    expect(findEntry(entries, "show-devices")).toBeUndefined();
    expect(item(entries, "output-unsupported")).toMatchObject({ label: "voice.menu.output_unsupported", disabled: true });
    expect(entries.map((e) => (e.kind === "separator" ? "|" : e.id))).toEqual(["label", "output-unsupported", "|", "settings"]);
  });

  it("offers “Show devices” while the names are hidden", () => {
    const entries = voiceDeviceMenu("output", ctx({ devices: HIDDEN, needsPermission: true }), actions(), t);
    expect(devicesOf(entries).map((e) => e.id)).toEqual(["device:"]);
    expect(findEntry(entries, "show-devices")).toBeDefined();
  });
});
