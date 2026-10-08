// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Message, TavrnApi, TavrnSocket, Thread } from "@tavrn/sdk";
import { defaultTitle } from "./titles";
import { relativeTime } from "./format";
import { applyThreadState, patchRoot, summaryOf, threadHandlers, threadMessage } from "./realtime";
import { useThreads } from "./store";
import { useUnread, applyBump } from "../stores/unread";
import { fetchPage, messagesKey, type MessagePages } from "../lib/messagePages";

const thread = (over: Partial<Thread> = {}): Thread =>
  ({ id: "T1", room_id: "R1", channel_id: "C1", root_message_id: "M1", root_deleted: false, encrypted: false, title: "x", title_epoch: null, title_author: "a@n", title_device_id: null, tags: [], created_by: "a@n", created_by_id: "U2", created_at: "2026-10-07T10:00:00.000Z", last_message_id: "M9", last_message_at: "2026-10-07T10:05:00.000Z", message_count: 3, participant_ids: ["U2"], archived_at: null, locked: false, ...over }) as Thread;

describe("thread helpers", () => {
  it("makes default titles from message text", () => {
    expect(defaultTitle("  Deploy\nfailed  ", "Thread")).toBe("Deploy failed");
    expect(defaultTitle("", "Thread")).toBe("Thread");
    expect(Array.from(defaultTitle("ü".repeat(120), "Thread"))).toHaveLength(100);
  });

  it("formats relative times in the user's language", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(relativeTime("2026-10-07T11:55:00Z", "en", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-10-07T12:00:00Z", "en", now)).toBe("now");
    expect(relativeTime("2026-10-05T12:00:00Z", "de", now)).toBe("vorgestern");
    expect(relativeTime("nope", "en", now)).toBe("");
  });

  it("pages a thread with the thread filter and keys its pages apart from the channel", async () => {
    const messages = vi.fn(async () => [] as Message[]);
    const api = { conversations: { messages } } as unknown as Pick<TavrnApi, "conversations">;
    await fetchPage(api, "C1", { before: "M5" }, "T1");
    await fetchPage(api, "C1", undefined);
    expect(messages.mock.calls).toEqual([["C1", { limit: 50, before: "M5", thread: "T1" }], ["C1", { limit: 50, before: undefined }]]);
    expect(messagesKey("C1")).toEqual(["messages", "C1"]);
    expect(messagesKey("C1", "T1")).toEqual(["messages", "C1", "thread", "T1"]);
  });

  it("patches the summary under the root message and removes it with the thread", () => {
    const qc = new QueryClient();
    const root = { id: "M1", conversation_id: "C1" } as Message;
    qc.setQueryData<MessagePages<Message>>(messagesKey("C1"), { pages: [[root]], pageParams: [undefined] });
    patchRoot(qc, "C1", "M1", "T1", summaryOf(thread()));
    expect(qc.getQueryData<MessagePages<Message>>(messagesKey("C1"))!.pages[0]![0]!.thread).toMatchObject({ id: "T1", message_count: 3 });
    patchRoot(qc, "C1", null, "T1", null);
    expect(qc.getQueryData<MessagePages<Message>>(messagesKey("C1"))!.pages[0]![0]!.thread).toBeUndefined();
  });

  it("routes thread messages to the thread and counts them for followers only", () => {
    const qc = new QueryClient();
    useThreads.setState({ followed: {}, open: null });
    useUnread.setState({ states: {}, held: {} });
    qc.setQueryData<MessagePages<Message>>(messagesKey("C1", "T1"), { pages: [[]], pageParams: [undefined] });
    const me = { id: "U1", address: "alice@n" };
    const m = { id: "M2", conversation_id: "C1", thread_id: "T1", author_id: "U2", mentions: [], mentions_everyone: false } as unknown as Message;
    expect(threadMessage(m, qc, me)).toBe(false);
    expect(qc.getQueryData<MessagePages<Message>>(messagesKey("C1", "T1"))!.pages[0]).toHaveLength(1);
    expect(useUnread.getState().states.C1).toBeUndefined();
    applyThreadState({ thread_id: "T1", channel_id: "C1", room_id: "R1", following: true, last_read_message_id: "M2", unread_count: 0, mention_count: 0 });
    expect(threadMessage({ ...m, id: "M3", mentions: ["alice@n"] } as Message, qc, me)).toBe(true);
    expect(useThreads.getState().followed.T1).toMatchObject({ unread: 1, mentions: 1 });
    expect(useUnread.getState().states.C1).toMatchObject({ unread: 1, mentions: 1 });
    // Unfollowing takes the thread's count off the channel.
    applyThreadState({ thread_id: "T1", channel_id: "C1", room_id: "R1", following: false, last_read_message_id: null, unread_count: 0, mention_count: 0 });
    expect(useUnread.getState().states.C1).toMatchObject({ unread: 0, mentions: 0 });
  });

  it("bumps counts without moving markers and never below zero", () => {
    const s = applyBump({ C1: { last: "M9", read: "M9", unread: 0, mentions: 0 } }, "C1", 2, 1);
    expect(s.C1).toEqual({ last: "M9", read: "M9", unread: 2, mentions: 1 });
    expect(applyBump(s, "C1", -5, -5).C1).toMatchObject({ unread: 0, mentions: 0 });
  });
});

describe("thread events keep the followed threads current (PROTOCOL.md §7e, #2)", () => {
  /** A socket whose handlers the test calls directly. */
  function socket() {
    const handlers: Record<string, (d: unknown) => void> = {};
    const s = { on: (type: string, fn: (d: unknown) => void) => ((handlers[type] = fn), () => undefined) } as unknown as TavrnSocket;
    return { s, emit: (type: string, d: unknown) => handlers[type]!(d) };
  }

  it("a thread the user started (on any connection) is followed at once; others' threads are not", () => {
    useThreads.setState({ followed: {}, open: null });
    const { s, emit } = socket();
    threadHandlers(s, new QueryClient(), () => ({ id: "U1", address: "alice@n" }));
    emit("thread.create", { room_id: "R1", thread: thread({ id: "T7", created_by_id: "U2" }) });
    expect(useThreads.getState().followed.T7).toBeUndefined();
    emit("thread.create", { room_id: "R1", thread: thread({ id: "T8", created_by_id: "U1", last_message_id: "M20" }) });
    expect(useThreads.getState().followed.T8).toMatchObject({ roomId: "R1", channelId: "C1", lastRead: "M20", unread: 0 });
  });
});
