// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { Message, ThreadReadState } from "@tavrn/sdk";
import { applyMessage, applyRead, applyRoom, applyState, concernsMe, useThreads } from "./store";

const me = { id: "U1", address: "alice@n.test" };
const state = (thread: string, over: Partial<ThreadReadState> = {}): ThreadReadState => ({ thread_id: thread, channel_id: "C1", room_id: "R1", following: true, last_read_message_id: null, unread_count: 0, mention_count: 0, ...over });
const msg = (id: string, over: Partial<Message> = {}) => ({ id, thread_id: "T1", author_id: "U2", mentions: [] as string[], mentions_everyone: false, ...over }) as Pick<Message, "id" | "thread_id" | "author_id" | "mentions" | "mentions_everyone">;

describe("followed threads (PROTOCOL.md §7e)", () => {
  beforeEach(() => useThreads.setState({ followed: {}, open: null }));

  it("seeds a room's followed threads and replaces only that room's entries", () => {
    let f = applyRoom({}, "R1", [state("T1", { unread_count: 2 }), state("T2")]);
    f = applyRoom(f, "R2", [state("T9", { room_id: "R2" })]);
    expect(Object.keys(f).sort()).toEqual(["T1", "T2", "T9"]);
    f = applyRoom(f, "R1", [state("T2", { unread_count: 1 })]);
    expect(Object.keys(f).sort()).toEqual(["T2", "T9"]);
    expect(f.T2!.unread).toBe(1);
  });

  it("counts others' messages of followed threads, with mentions, unless active or already read", () => {
    let f = applyRoom({}, "R1", [state("T1", { last_read_message_id: "M1" })]);
    f = applyMessage(f, msg("M2"), me, false);
    f = applyMessage(f, msg("M3", { mentions: ["alice@n.test"] }), me, false);
    f = applyMessage(f, msg("M4", { mentions_everyone: true }), me, false);
    expect(f.T1).toMatchObject({ unread: 3, mentions: 2 });
    expect(applyMessage(f, msg("M5", { author_id: "U1" }), me, false)).toBe(f);
    expect(applyMessage(f, msg("M6"), me, true)).toBe(f);
    expect(applyMessage(f, msg("M0"), me, false)).toBe(f);
    expect(applyMessage(f, msg("M7", { thread_id: "OTHER" }), me, false)).toBe(f);
    f = applyRead(f, "T1", "M4");
    expect(f.T1).toMatchObject({ unread: 0, mentions: 0, lastRead: "M4" });
    expect(applyRead(f, "T1", "M2")).toBe(f);
  });

  it("follows and unfollows from read states", () => {
    let f = applyState({}, state("T1", { unread_count: 4 }));
    expect(f.T1!.unread).toBe(4);
    f = applyState(f, state("T1", { following: false }));
    expect(f.T1).toBeUndefined();
    expect(applyState(f, state("T1", { following: false }))).toBe(f);
  });

  it("thread messages concern the user only in followed threads or when they mention them", () => {
    useThreads.getState().seedRoom("R1", [state("T1")]);
    expect(concernsMe({ thread_id: null, mentions: [] }, me)).toBe(true);
    expect(concernsMe({ thread_id: "T1", mentions: [] }, me)).toBe(true);
    expect(concernsMe({ thread_id: "T2", mentions: [] }, me)).toBe(false);
    expect(concernsMe({ thread_id: "T2", mentions: ["alice@n.test"] }, me)).toBe(true);
  });
});
