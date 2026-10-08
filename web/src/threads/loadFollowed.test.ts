// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { TavrnApiError, type ThreadReadState } from "@tavrn/sdk";
import { FOLLOWED_GAP_MS, FOLLOWED_ROOMS_MAX, loadFollowedThreads, resetFollowedLoads } from "./loadFollowed";
import { concernsMe, useThreads } from "./store";

const state = (thread: string, room: string): ThreadReadState => ({ thread_id: thread, channel_id: `C-${room}`, room_id: room, following: true, last_read_message_id: null, unread_count: 1, mention_count: 0 });

/** A node's API: `rooms` it lists, the followed threads per room (an Error fails that room). */
function client(rooms: string[], followed: Record<string, ThreadReadState[] | Error>) {
  return {
    rooms: { list: vi.fn(async () => rooms.map((id) => ({ id }))) },
    threads: {
      followed: vi.fn(async (roomId: string) => {
        const r = followed[roomId] ?? [];
        if (r instanceof Error) throw r;
        return { items: r };
      }),
    },
  };
}

const notFound = () => new TavrnApiError({ type: "x", title: "", status: 404, detail: "", code: "route.not_found" });

describe("followed threads of every room at start (PROTOCOL.md §7e, #2)", () => {
  beforeEach(() => {
    useThreads.setState({ followed: {}, open: null });
    resetFollowedLoads();
  });

  it("loads every room's followed threads one after the other, spaced, into the store and the query cache", async () => {
    const c = client(["R1", "R2"], { R1: [state("T1", "R1")], R2: [state("T2", "R2"), state("T3", "R2")] });
    const sleep = vi.fn(async (_ms: number) => {});
    const queryClient = new QueryClient();
    await loadFollowedThreads({ key: "home.test", client: c, queryClient, sleep });
    expect(Object.keys(useThreads.getState().followed).sort()).toEqual(["T1", "T2", "T3"]);
    // A thread message of a room that was never opened now concerns the user (notifications, counts).
    expect(concernsMe({ thread_id: "T2", mentions: [] }, { address: "alice@home.test" })).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(FOLLOWED_GAP_MS);
    // Opening a room later finds its list in the cache (useFollowedThreads uses the same key).
    expect(queryClient.getQueryData(["followed-threads", "home.test", "R2"])).toEqual({ items: [state("T2", "R2"), state("T3", "R2")] });
  });

  it("a failing room does not stop the others; a node without threads (404 route) stops at once", async () => {
    const c = client(["R1", "R2", "R3"], { R1: new TypeError("Failed to fetch"), R2: [state("T2", "R2")] });
    await loadFollowedThreads({ key: "a", client: c, queryClient: new QueryClient(), sleep: async () => {} });
    expect(Object.keys(useThreads.getState().followed)).toEqual(["T2"]);
    expect(c.threads.followed).toHaveBeenCalledTimes(3);

    resetFollowedLoads();
    const old = client(["R1", "R2"], { R1: notFound() });
    await loadFollowedThreads({ key: "b", client: old, queryClient: new QueryClient(), sleep: async () => {} });
    expect(old.threads.followed).toHaveBeenCalledTimes(1);
  });

  it("at most FOLLOWED_ROOMS_MAX rooms per node", async () => {
    const rooms = Array.from({ length: FOLLOWED_ROOMS_MAX + 5 }, (_, i) => `R${i}`);
    const c = client(rooms, {});
    await loadFollowedThreads({ key: "a", client: c, queryClient: new QueryClient(), sleep: async () => {} });
    expect(c.threads.followed).toHaveBeenCalledTimes(FOLLOWED_ROOMS_MAX);
  });

  it("one load per node at a time, and not again within the refresh interval (reconnects)", async () => {
    const c = client(["R1"], { R1: [state("T1", "R1")] });
    const queryClient = new QueryClient();
    const now = vi.fn(() => 1_000_000);
    await Promise.all([loadFollowedThreads({ key: "a", client: c, queryClient, sleep: async () => {}, now }), loadFollowedThreads({ key: "a", client: c, queryClient, sleep: async () => {}, now })]);
    expect(c.rooms.list).toHaveBeenCalledTimes(1);
    await loadFollowedThreads({ key: "a", client: c, queryClient, sleep: async () => {}, now });
    expect(c.rooms.list).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 60_001);
    await loadFollowedThreads({ key: "a", client: c, queryClient, sleep: async () => {}, now });
    expect(c.rooms.list).toHaveBeenCalledTimes(2);
    // Another node loads on its own.
    await loadFollowedThreads({ key: "b", client: c, queryClient, sleep: async () => {}, now });
    expect(c.rooms.list).toHaveBeenCalledTimes(3);
  });
});
