// SPDX-License-Identifier: Apache-2.0
/** The service worker `public/sw.js` (web push only), run against a fake worker scope. */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Shown {
  title: string;
  options: NotificationOptions & { data: { url: string }; renotify?: boolean; requireInteraction?: boolean };
}

type Handler = (event: unknown) => void;
interface Helpers {
  notificationFor: (p: unknown, strings: Record<string, string> | null, homeNode: string | null) => Shown;
  targetUrl: (p: unknown, homeNode: string | null) => string;
}

const source = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");

function load() {
  const handlers: Record<string, Handler> = {};
  const shown: Shown[] = [];
  const windows: Array<{ url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }> = [];
  const scope = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    registration: {
      showNotification: vi.fn(async (title: string, options: Shown["options"]) => {
        shown.push({ title, options });
      }),
    },
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null), claim: vi.fn(async () => undefined) },
    location: { origin: "https://chat.example.org" },
    tavrnPush: undefined as unknown as Helpers,
  };
  new Function("self", source)(scope);
  /** Dispatches an extendable event and waits for what it extended its life with. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  return { scope, handlers, shown, windows, dispatch, helpers: scope.tavrnPush };
}

const push = (payload: unknown) => ({ data: { json: () => payload } });

describe("service worker", () => {
  beforeEach(() => {
    indexedDB.deleteDatabase("tavrn-push");
  });

  it("registers push, click and message handlers and caches nothing", () => {
    const { handlers } = load();
    expect(Object.keys(handlers).sort()).toEqual(["activate", "install", "message", "notificationclick", "push"]);
    expect(source).not.toMatch(/caches\.|addEventListener\("fetch"/);
  });

  it("routes to the conversation: home node rooms directly, other nodes under /n/", () => {
    const { helpers } = load();
    expect(helpers.targetUrl({ node: "chat.example.org", conversation_id: "C1", room_id: "R1" }, "chat.example.org")).toBe("/rooms/R1/channels/C1");
    expect(helpers.targetUrl({ node: "chat.example.org", conversation_id: "D1" }, "chat.example.org")).toBe("/conversations/D1");
    expect(helpers.targetUrl({ node: "other.example", conversation_id: "C1", room_id: "R1" }, "chat.example.org")).toBe("/n/other.example/rooms/R1/channels/C1");
    expect(helpers.targetUrl({ node: "other.example", conversation_id: "D1" }, "chat.example.org")).toBe("/n/other.example/conversations/D1");
    expect(helpers.targetUrl({ type: "test" }, "chat.example.org")).toBe("/");
  });

  it("builds notifications without content for encrypted conversations", () => {
    const { helpers } = load();
    const home = "chat.example.org";
    const base = { v: 1, node: home, local: true, conversation_id: "C1" };
    const channel = helpers.notificationFor({ ...base, type: "message", room_id: "R1", room: "Tavern", conversation: "general", sender: "Alice", encrypted: true }, null, home);
    expect(channel.title).toBe("#general · Tavern");
    expect(channel.options.body).toBe("New message from Alice");
    expect(channel.options.tag).toBe(`${home}|C1`);
    expect(channel.options.renotify).toBe(false);
    expect(channel.options.data.url).toBe("/rooms/R1/channels/C1");
    const preview = helpers.notificationFor({ ...base, type: "mention", room: "Tavern", conversation: "general", sender: "Alice", text: "hi @bob", encrypted: false }, null, home);
    expect(preview.options.body).toBe("Alice: hi @bob");
    expect(preview.options.renotify).toBe(true);
    const dm = helpers.notificationFor({ ...base, type: "dm", conversation_kind: "dm", sender: "Alice", encrypted: true }, null, home);
    expect([dm.title, dm.options.body]).toEqual(["Alice", "New encrypted message"]);
    const group = helpers.notificationFor({ ...base, type: "dm", conversation_kind: "group", conversation: "Raid", sender: "Alice", encrypted: true }, null, home);
    expect([group.title, group.options.body]).toEqual(["Raid", "Alice: New encrypted message"]);
    // DMs are always end-to-end encrypted: a text the node puts into the push is never shown, nor for an encrypted message.
    const forged = helpers.notificationFor({ ...base, type: "dm", conversation_kind: "dm", sender: "Alice", text: "new bank account", encrypted: false }, null, home);
    expect(forged.options.body).not.toContain("bank");
    const forgedChannel = helpers.notificationFor({ ...base, type: "mention", room: "Tavern", conversation: "general", sender: "Alice", text: "new bank account", encrypted: true }, null, home);
    expect(forgedChannel.options.body).not.toContain("bank");
    const call = helpers.notificationFor({ ...base, type: "call", sender: "Alice" }, null, home);
    expect([call.title, call.options.body, call.options.requireInteraction]).toEqual(["Alice", "Alice is calling", true]);
    const remote = helpers.notificationFor({ v: 1, type: "mention", node: "other.example", local: false, conversation_id: "C9", room_id: "R9", encrypted: true }, null, home);
    expect([remote.title, remote.options.body, remote.options.data.url]).toEqual(["other.example", "You were mentioned on other.example", "/n/other.example/rooms/R9/channels/C9"]);
    const generic = helpers.notificationFor(null, null, home);
    expect([generic.title, generic.options.body]).toEqual(["tavrn", "New notification"]);
    const translated = helpers.notificationFor({ ...base, type: "message", sender: "Alice", room: "Tavern" }, { message: "Neue Nachricht von {sender}" }, home);
    expect(translated.options.body).toBe("Neue Nachricht von Alice");
  });

  it("names only the kind and the room of a report and opens the inbox that handles it", () => {
    const { helpers } = load();
    const home = "chat.example.org";
    const base = { v: 1, type: "report", node: home, local: true, encrypted: false };
    const room = helpers.notificationFor({ ...base, room_id: "R1", room: "Tavern", report_kind: "message" }, null, home);
    expect([room.title, room.options.body, room.options.data.url, room.options.tag]).toEqual(["New report", "New report in Tavern", "/rooms/R1/settings/reports", `${home}|report:R1`]);
    expect(room.options.renotify).toBe(false);
    const node = helpers.notificationFor({ ...base, report_kind: "user" }, null, home);
    expect([node.title, node.options.body, node.options.data.url, node.options.tag]).toEqual(["New report", "A report for the node admins", "/admin/reports", `${home}|report:node`]);
    const translated = helpers.notificationFor({ ...base, room_id: "R1", room: "Tavern" }, { report_title: "Neue Meldung", report: "Neue Meldung in {room}" }, home);
    expect([translated.title, translated.options.body]).toEqual(["Neue Meldung", "Neue Meldung in Tavern"]);
  });

  it("shows a push with the texts the page sent, and a generic one for unreadable data", async () => {
    const { dispatch, shown } = load();
    await dispatch("message", { data: { type: "tavrn.push.config", strings: { test: "Push klappt." }, homeNode: "chat.example.org" } });
    await dispatch("push", push({ v: 1, type: "test", node: "chat.example.org", local: true, encrypted: false }));
    expect(shown[0]).toMatchObject({ title: "tavrn", options: { body: "Push klappt." } });
    await dispatch("push", { data: { json: () => { throw new Error("not JSON"); } } });
    expect(shown[1]).toMatchObject({ title: "tavrn", options: { body: "New notification" } });
    await dispatch("push", push({ v: 2, type: "future" }));
    expect(shown[2]!.options.body).toBe("New notification");
  });

  it("a click focuses an open window and lets it navigate, else opens one", async () => {
    const { dispatch, scope, windows } = load();
    const notification = (url: string) => ({ close: vi.fn(), data: { url } });
    await dispatch("notificationclick", { notification: notification("/conversations/D1") });
    expect(scope.clients.openWindow).toHaveBeenCalledWith("https://chat.example.org/conversations/D1");
    windows.push({ url: "https://chat.example.org/friends", focus: vi.fn(async () => undefined), postMessage: vi.fn() });
    await dispatch("notificationclick", { notification: notification("/rooms/R1/channels/C1") });
    expect(windows[0]!.postMessage).toHaveBeenCalledWith({ type: "tavrn.push.open", url: "/rooms/R1/channels/C1" });
    expect(windows[0]!.focus).toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledTimes(1);
  });
});
