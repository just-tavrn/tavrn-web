// SPDX-License-Identifier: Apache-2.0
/** The client's side of the tray and the notification clicks (`desktopShell.ts`): voice store → tray, tray → voice. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Conversation, RoomDetail } from "@tavrn/sdk";
import { startDesktopShell, trayVoiceState } from "./desktopShell";
import { IDLE, useVoice } from "../voice/store";
import { useLocale } from "../i18n";
import type { PlatformNotifications, PlatformTray, TrayAction, TrayLabels, TrayVoiceState } from "./types";

const voice = vi.hoisted(() => ({ toggleMute: vi.fn(async () => {}), toggleDeafen: vi.fn(async () => {}), leaveVoice: vi.fn(async () => {}) }));
vi.mock("../voice", () => voice);

function fakeTray() {
  const sent: Array<{ state: TrayVoiceState; labels: TrayLabels }> = [];
  const listeners = new Set<(a: TrayAction) => void>();
  const tray: PlatformTray = {
    set: async (state, labels) => void sent.push({ state, labels }),
    onAction: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    status: async () => ({ state: "disconnected", tooltip: "Tavrn", available: true, closeToTray: true }),
    setCloseToTray: async () => {},
    quit: async () => {},
  };
  return { tray, sent, fire: (a: TrayAction) => listeners.forEach((fn) => fn(a)), listeners };
}

function fakeNotifications() {
  const listeners = new Set<(p: string) => void>();
  const notifications: PlatformNotifications = {
    show: async () => {},
    onOpen: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return { notifications, open: (p: string) => listeners.forEach((fn) => fn(p)), listeners };
}

function cache() {
  const qc = new QueryClient();
  qc.setQueryData<Partial<RoomDetail>>(["room", "r1"], { id: "r1", name: "Gaming", channels: [{ id: "v1", name: "Lounge", kind: "voice" } as RoomDetail["channels"][number]] });
  qc.setQueryData<Partial<Conversation>[]>(["conversations"], [{ id: "dm1", kind: "dm", name: null, members: [{ address: "me@t.local", display_name: "Me" }, { address: "bob@t.local", display_name: "Bob" }] as Conversation["members"] }]);
  return qc;
}

beforeEach(() => {
  vi.useFakeTimers();
  useVoice.setState(IDLE);
  useLocale.setState({ locale: "en" });
  Object.values(voice).forEach((f) => f.mockClear());
});

afterEach(() => {
  vi.useRealTimers();
  useLocale.setState({ locale: "de" });
});

describe("trayVoiceState", () => {
  const v = (over: Partial<typeof IDLE>) => trayVoiceState({ ...IDLE, ...over });
  it("maps the voice store to the five tray states; deafened wins over muted", () => {
    expect(v({})).toBe("disconnected");
    expect(v({ status: "joining" })).toBe("disconnected");
    expect(v({ status: "connected" })).toBe("connected");
    expect(v({ status: "reconnecting" })).toBe("connected");
    expect(v({ status: "connected", transmitting: true })).toBe("speaking");
    expect(v({ status: "connected", muted: true, transmitting: true })).toBe("muted");
    expect(v({ status: "connected", serverMuted: true })).toBe("muted");
    expect(v({ status: "connected", muted: true, deafened: true })).toBe("deafened");
  });
});

describe("startDesktopShell", () => {
  it("drives the tray from the voice store, at most every 150 ms, with the channel in the tooltip", async () => {
    const { tray, sent } = fakeTray();
    const stop = startDesktopShell({ tray, queryClient: cache(), self: "me@t.local", navigate: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ state: "disconnected", labels: { tooltip: "Tavrn", show: "Show Tavrn", hide: "Hide Tavrn", mute: "Mute microphone", quit: "Quit Tavrn" } });

    useVoice.setState({ status: "connected", target: { domain: "t.local", roomId: "r1", channelId: "v1" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.at(-1)).toMatchObject({ state: "connected", labels: { tooltip: "Tavrn · Lounge (Gaming) · In a voice channel" } });

    // Speaking flickers: the tray gets at most one update per 150 ms, and the last state wins.
    const before = sent.length;
    for (let i = 0; i < 10; i++) {
      useVoice.setState({ transmitting: i % 2 === 0 });
      await vi.advanceTimersByTimeAsync(20);
    }
    useVoice.setState({ transmitting: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.length - before).toBeLessThanOrEqual(3);
    expect(sent.at(-1)?.state).toBe("speaking");

    useVoice.setState({ muted: true, deafened: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.at(-1)).toMatchObject({ state: "deafened", labels: { tooltip: "Tavrn · Lounge (Gaming) · Voices muted" } });
    stop();
    expect(sent.at(-1)).toMatchObject({ state: "disconnected", labels: { tooltip: "Tavrn" } });
  });

  it("names a call by the other members", async () => {
    const { tray, sent } = fakeTray();
    useVoice.setState({ status: "connected", target: { domain: "t.local", roomId: "", channelId: "dm1", call: true } });
    const stop = startDesktopShell({ tray, queryClient: cache(), self: "me@t.local", navigate: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)?.labels.tooltip).toBe("Tavrn · Bob · In a voice channel");
    stop();
  });

  it("does not send the same state twice", async () => {
    const { tray, sent } = fakeTray();
    const stop = startDesktopShell({ tray, queryClient: cache(), self: "me@t.local", navigate: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    useVoice.setState({ quality: "good" });
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(1);
    stop();
    expect(sent).toHaveLength(2);
  });

  it("the tray menu mutes, deafens and leaves through the voice client", async () => {
    const { tray, fire, listeners } = fakeTray();
    const stop = startDesktopShell({ tray, queryClient: cache(), self: "me@t.local", navigate: () => {} });
    fire("mute");
    fire("deafen");
    fire("leave");
    expect(voice.toggleMute).toHaveBeenCalledOnce();
    expect(voice.toggleDeafen).toHaveBeenCalledOnce();
    expect(voice.leaveVoice).toHaveBeenCalledOnce();
    stop();
    expect(listeners.size).toBe(0);
  });

  it("a clicked notification opens its conversation", () => {
    const { notifications, open, listeners } = fakeNotifications();
    const navigate = vi.fn();
    const stop = startDesktopShell({ notifications, queryClient: cache(), self: "me@t.local", navigate });
    open("/rooms/r1/channels/c1");
    expect(navigate).toHaveBeenCalledWith("/rooms/r1/channels/c1");
    stop();
    expect(listeners.size).toBe(0);
  });

  it("follows the language", async () => {
    const { tray, sent } = fakeTray();
    const stop = startDesktopShell({ tray, queryClient: cache(), self: "me@t.local", navigate: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    useLocale.setState({ locale: "de" });
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.at(-1)?.labels.quit).toBe("Tavrn beenden");
    stop();
  });
});
