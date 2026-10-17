// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, useNotifications } from "./notifications";
import { markConversationRead, useUnread } from "./unread";
import { applyThreadState } from "../threads/realtime";

const push = (path: string, messageId?: string, kind: "mention" | "dm" | "call" = "mention") =>
  useNotifications.getState().push({ path, messageId, kind, title: "Message", body: "" });
const read = (path: string, messageId?: string) => useNotifications.getState().entries.find((e) => e.path === path && e.messageId === messageId)?.read;

beforeEach(() => {
  localStorage.clear();
  useNotifications.getState().reset();
  useUnread.setState({ states: {}, held: {} });
});

describe("message reads update the notification bell", () => {
  it("marks only messages through the read marker and preserves their history", () => {
    const path = "/conversations/c1";
    push(path, "01", "dm");
    push(path, "03", "dm");
    push("/conversations/c2", "01", "dm");
    push(path, "00", "call");
    useUnread.getState().read("c1", "02");
    expect(read(path, "01")).toBe(true);
    expect(read(path, "03")).toBe(false);
    expect(read("/conversations/c2", "01")).toBe(false);
    expect(read(path, "00")).toBe(false);
    expect(useNotifications.getState().entries).toHaveLength(4);
  });

  it("keeps nodes and threads separate from their parent channel", () => {
    const path = "/n/other.test/rooms/r1/channels/c1";
    push(path, "01");
    push("/rooms/r1/channels/c1", "01");
    push(`${path}/threads/t1`, "01");
    push(`${path}/threads/t2`, "01");
    useUnread.getState().read("c1", "02", "other.test");
    expect(read(path, "01")).toBe(true);
    expect(read("/rooms/r1/channels/c1", "01")).toBe(false);
    expect(read(`${path}/threads/t1`, "01")).toBe(false);
    applyThreadState({ thread_id: "t1", channel_id: "c1", room_id: "r1", following: true, last_read_message_id: "02", unread_count: 0, mention_count: 0 }, "other.test");
    expect(read(`${path}/threads/t1`, "01")).toBe(true);
    expect(read(`${path}/threads/t2`, "01")).toBe(false);
  });

  it("also acknowledges old entries without message ids and persists the result", async () => {
    const remote = { get: vi.fn(async () => DEFAULT_SETTINGS), put: vi.fn() };
    await useNotifications.getState().load(remote, "me@home.test");
    push("/conversations/c1", undefined, "dm");
    useUnread.getState().seed([{ conversation_id: "c1", last_read_message_id: "02", unread_count: 0, mention_count: 0 }]);
    expect(read("/conversations/c1")).toBe(true);
    useNotifications.getState().reset();
    await useNotifications.getState().load(remote, "me@home.test");
    expect(read("/conversations/c1")).toBe(true);
  });

  it("keeps legacy entries unseen while only part of the conversation was read", () => {
    push("/conversations/c1", undefined, "dm");
    useUnread.getState().seed([{ conversation_id: "c1", last_message_id: "09", last_read_message_id: "02", unread_count: 1, mention_count: 0 }]);
    expect(read("/conversations/c1")).toBe(false);
    useUnread.getState().read("c1", "03");
    expect(read("/conversations/c1")).toBe(false);
    useUnread.getState().read("c1", "09");
    expect(read("/conversations/c1")).toBe(true);
  });

  it("reconciles restored entries when read states arrived before notification settings", async () => {
    localStorage.setItem("tavrn.notify.entries:me@home.test", JSON.stringify([
      { id: "e1", path: "/n/other.test/conversations/c1", messageId: "01", kind: "dm", title: "Message", body: "", read: false, at: new Date().toISOString() },
    ]));
    useUnread.getState().seed([{ conversation_id: "c1", last_read_message_id: "02", unread_count: 0, mention_count: 0 }], "other.test");
    await useNotifications.getState().load({ get: vi.fn(async () => DEFAULT_SETTINGS), put: vi.fn() }, "me@home.test");
    expect(read("/n/other.test/conversations/c1", "01")).toBe(true);
  });

  it("marks an entry that finishes its room lookup after its message was read", () => {
    useUnread.getState().read("c1", "02");
    push("/rooms/r1/channels/c1", "01");
    push("/rooms/r1/channels/c1", "03");
    expect(read("/rooms/r1/channels/c1", "01")).toBe(true);
    expect(read("/rooms/r1/channels/c1", "03")).toBe(false);
    // An older response or device marker must not undo progress.
    useUnread.getState().read("c1", "00");
    push("/rooms/r1/channels/c1", "02");
    expect(read("/rooms/r1/channels/c1", "02")).toBe(true);
    useNotifications.getState().reset();
    push("/rooms/r1/channels/c1", "01");
    expect(read("/rooms/r1/channels/c1", "01")).toBe(false);
  });

  it("also marks message entries when a conversation is marked read from its menu", async () => {
    push("/n/other.test/conversations/c1", "01", "dm");
    useUnread.setState({ states: { c1: { last: "02", read: null, unread: 1, mentions: 0 } } });
    await markConversationRead({ conversations: { markRead: vi.fn(async () => ({})) } }, "c1", "other.test");
    expect(read("/n/other.test/conversations/c1", "01")).toBe(true);
  });
});
