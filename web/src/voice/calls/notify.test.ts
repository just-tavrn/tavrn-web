// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { callNoticeWanted, closeCallNotice, showCallNotice } from "./notify";
import { RING_VIBRATION } from "../cues";

/** A service worker registration that records its notifications. */
function registration() {
  const list: Array<{ tag: string; title: string; options: NotificationOptions & { renotify?: boolean; vibrate?: number[] }; close: () => void }> = [];
  return {
    list,
    showNotification: vi.fn(async (title: string, options: NotificationOptions = {}) => {
      const n = { tag: options.tag ?? "", title, options, close: () => list.splice(list.indexOf(n), 1) };
      list.push(n);
    }),
    getNotifications: vi.fn(async (filter?: { tag?: string }) => list.filter((n) => !filter?.tag || n.tag === filter.tag)),
  };
}

const notice = { tag: "chat.example.org|D1", title: "Alice is calling", body: "alice@chat.example.org", path: "/conversations/D1" };

describe("system notification of an incoming call (mobile browsers)", () => {
  it("is wanted when the ring cannot be heard: page hidden or sound blocked, with permission and notifications on", () => {
    const base = { hidden: false, soundBlocked: false, permission: "granted" as const, enabled: true };
    expect(callNoticeWanted(base)).toBe(false);
    expect(callNoticeWanted({ ...base, soundBlocked: true })).toBe(true);
    expect(callNoticeWanted({ ...base, hidden: true })).toBe(true);
    expect(callNoticeWanted({ ...base, hidden: true, permission: "default" })).toBe(false);
    expect(callNoticeWanted({ ...base, hidden: true, permission: "unsupported" })).toBe(false);
    expect(callNoticeWanted({ ...base, hidden: true, enabled: false })).toBe(false);
  });

  it("shows one notification per call through the service worker (the push's tag) and closes it when the ring ends", async () => {
    const reg = registration();
    expect(await showCallNotice(reg, notice)).toBe(true);
    expect(reg.list).toHaveLength(1);
    expect(reg.list[0]!.title).toBe("Alice is calling");
    expect(reg.list[0]!.options).toMatchObject({ body: notice.body, tag: notice.tag, requireInteraction: true, renotify: true, data: { url: "/conversations/D1" } });
    expect(reg.list[0]!.options.vibrate).toEqual(RING_VIBRATION);
    // Shown already (by the page or by a push): not again, no second alert.
    expect(await showCallNotice(reg, notice)).toBe(false);
    expect(reg.showNotification).toHaveBeenCalledTimes(1);
    await closeCallNotice(reg, notice.tag);
    expect(reg.list).toHaveLength(0);
    // Without a service worker nothing happens.
    expect(await showCallNotice(null, notice)).toBe(false);
    await closeCallNotice(null, notice.tag);
  });

  it("never throws when the platform refuses the notification", async () => {
    const reg = { showNotification: vi.fn(async () => Promise.reject(new TypeError("no permission"))), getNotifications: vi.fn(async () => []) };
    expect(await showCallNotice(reg, notice)).toBe(false);
  });
});
