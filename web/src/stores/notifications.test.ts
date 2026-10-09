// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApiError, type NotificationSettings } from "@tavrn/sdk";
import { DEFAULT_SETTINGS, FOREVER, decide, effectiveMode, muteUntil, normalizeSettings, setChannelSetting, setRoomSetting, useNotifications } from "./notifications";

const me = { id: "u1", address: "me@x" };
const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...DEFAULT_SETTINGS, ...over, global: { ...DEFAULT_SETTINGS.global, ...over.global } });
const msg = (over: Partial<Parameters<typeof decide>[1]> = {}) => ({ conversationId: "c1", roomId: "r1", authorId: "u2", mentions: [] as string[], mentionsEveryone: false, ...over });

describe("decide", () => {
  it("notifies room messages only when mentioned by default, DMs always", () => {
    const s = settings();
    expect(decide(s, msg(), me, { active: false })).toEqual({ notify: false, important: false });
    expect(decide(s, msg({ mentions: ["ME@x"] }), me, { active: false })).toEqual({ notify: true, important: true });
    expect(decide(s, msg({ mentionsEveryone: true }), me, { active: false }).notify).toBe(true);
    expect(decide(s, msg({ roomId: null }), me, { active: false })).toEqual({ notify: true, important: true });
  });

  it("never notifies own messages, the open conversation or system channels", () => {
    const s = settings({ global: { mode: "all", sound: true, browser: false } });
    expect(decide(s, msg({ authorId: "u1" }), me, { active: false }).notify).toBe(false);
    expect(decide(s, msg(), me, { active: true }).notify).toBe(false);
    expect(decide(s, msg({ system: true }), me, { active: false }).notify).toBe(false);
    expect(decide(s, msg(), me, { active: false })).toEqual({ notify: true, important: false });
  });

  it("applies channel over room over global, mutes and @everyone suppression", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    const s = settings({ rooms: { r1: { mode: "all", suppress_everyone: true } }, channels: { c2: { mode: "nothing" }, c3: { muted_until: "2026-10-05T13:00:00Z" } } });
    expect(effectiveMode(s, "r1", "c1")).toBe("all");
    expect(effectiveMode(s, "r1", "c2")).toBe("nothing");
    expect(decide(s, msg({ conversationId: "c2", mentions: ["me@x"] }), me, { active: false, now }).notify).toBe(false);
    expect(decide(s, msg({ conversationId: "c3", mentions: ["me@x"] }), me, { active: false, now }).notify).toBe(false);
    // The mute ran out.
    expect(decide(s, msg({ conversationId: "c3" }), me, { active: false, now: now + 2 * 3_600_000 }).notify).toBe(true);
    // @everyone is suppressed in r1: notifies (mode all) but is not a mention.
    expect(decide(s, msg({ mentionsEveryone: true }), me, { active: false, now })).toEqual({ notify: true, important: false });
    const roomMuted = settings({ rooms: { r1: { muted_until: FOREVER } } });
    expect(decide(roomMuted, msg({ mentions: ["me@x"] }), me, { active: false }).notify).toBe(false);
    expect(decide(settings({ global: { mode: "nothing", sound: true, browser: false } }), msg({ roomId: null }), me, { active: false }).notify).toBe(false);
  });

  it("computes mute ends", () => {
    expect(muteUntil(8, Date.parse("2026-10-05T12:00:00Z"))).toBe("2026-10-05T20:00:00.000Z");
    expect(muteUntil(0)).toBe(FOREVER);
  });
});

describe("normalizeSettings", () => {
  it("keeps valid values and drops the rest", () => {
    expect(normalizeSettings({ global: { mode: "loud", sound: "yes" }, rooms: { r: { mode: "all", muted_until: "nope", suppress_everyone: true }, x: 5 }, channels: { c: {} } })).toEqual({
      global: { mode: "mentions", sound: true, browser: false },
      rooms: { r: { mode: "all", suppress_everyone: true } },
      channels: {},
    });
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the report push switch only while it is off, like the node", () => {
    expect(normalizeSettings({ global: { mode: "all", reports: false } }).global).toEqual({ mode: "all", sound: true, browser: false, reports: false });
    expect(normalizeSettings({ global: { mode: "all", reports: true } }).global).toEqual({ mode: "all", sound: true, browser: false });
    expect(normalizeSettings({ global: { mode: "all", reports: "no" } }).global).toEqual({ mode: "all", sound: true, browser: false });
  });
});

describe("useNotifications", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotifications.getState().reset();
  });

  it("loads the settings from the node and saves changes there (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const served = settings({ global: { mode: "all", sound: false, browser: false } });
      const remote = { get: vi.fn(async () => served), put: vi.fn(async (s: NotificationSettings) => s) };
      await useNotifications.getState().load(remote, "me@x");
      expect(useNotifications.getState()).toMatchObject({ source: "server", settings: served });
      setRoomSetting("r1", { muted_until: FOREVER });
      setChannelSetting("c1", { mode: "nothing" });
      expect(remote.put).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(remote.put).toHaveBeenCalledTimes(1);
      expect(remote.put.mock.calls[0]![0]).toMatchObject({ rooms: { r1: { muted_until: FOREVER } }, channels: { c1: { mode: "nothing" } } });
      // Inheriting again removes the entry's field.
      setChannelSetting("c1", { mode: null });
      expect(useNotifications.getState().settings.channels.c1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to local storage when the node has no route (404)", async () => {
    localStorage.setItem("tavrn.notify.settings:me@x", JSON.stringify(settings({ rooms: { r9: { mode: "all" } } })));
    const notFound = new TavrnApiError({ type: "about:blank", title: "Not found", status: 404, detail: "", code: "route.not_found" });
    const remote = { get: vi.fn(async () => Promise.reject(notFound)), put: vi.fn() };
    await useNotifications.getState().load(remote, "me@x");
    expect(useNotifications.getState().source).toBe("local");
    expect(useNotifications.getState().settings.rooms.r9).toEqual({ mode: "all" });
    setRoomSetting("r9", { mode: "nothing" });
    expect(remote.put).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("tavrn.notify.settings:me@x")!).rooms.r9.mode).toBe("nothing");
  });

  it("keeps the newest entries of the notification center and counts unseen ones", () => {
    for (let i = 0; i < 60; i++) useNotifications.getState().push({ kind: "mention", title: `t${i}`, body: "", path: null });
    const entries = useNotifications.getState().entries;
    expect(entries).toHaveLength(50);
    expect(entries[0]!.title).toBe("t59");
    useNotifications.getState().markAllRead();
    expect(useNotifications.getState().entries.every((e) => e.read)).toBe(true);
  });
});

describe("push_text", () => {
  it("is kept when on and left out when off", () => {
    expect(normalizeSettings({ global: { mode: "all", sound: true, browser: false, push_text: true } }).global).toEqual({ mode: "all", sound: true, browser: false, push_text: true });
    expect(normalizeSettings({ global: { mode: "all", push_text: false } }).global).not.toHaveProperty("push_text");
    expect(normalizeSettings({ global: { mode: "all", push_text: "yes" } }).global).not.toHaveProperty("push_text");
  });
});
