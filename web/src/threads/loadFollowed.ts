// SPDX-License-Identifier: Apache-2.0
/**
 * Followed threads of every room at start (PROTOCOL.md §7e): without them, thread messages of rooms not opened since
 * the start would neither count nor notify under the followed-thread rules. The protocol has no route across rooms,
 * so each node's rooms are asked one after the other in the background (`GET /rooms/{id}/followed-threads`), spaced
 * out, at most {@link FOLLOWED_ROOMS_MAX} rooms, once per connection of the node's socket and not more often than
 * every {@link FOLLOWED_REFRESH_MS}. `thread.read` and `message.create` keep the state current afterwards.
 */
import type { QueryClient } from "@tanstack/react-query";
import { TavrnApiError, type FollowedThreads } from "@tavrn/sdk";
import { useThreads } from "./store";

/** Pause between two rooms. */
export const FOLLOWED_GAP_MS = 200;
/** Rooms asked per node at most. */
export const FOLLOWED_ROOMS_MAX = 100;
/** A node's rooms are asked again after a reconnect only when the last load is older than this. */
export const FOLLOWED_REFRESH_MS = 60_000;

export interface FollowedLoad {
  /** The node's domain (also the query key `["followed-threads", key, roomId]` of `useFollowedThreads`). */
  key: string;
  client: { rooms: { list: () => Promise<Array<{ id: string }>> }; threads: { followed: (roomId: string) => Promise<FollowedThreads> } };
  queryClient: QueryClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const loads = new Map<string, { at: number; done: Promise<void> }>();

/** Tests: forget the loads. */
export function resetFollowedLoads(): void {
  loads.clear();
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function loadFollowedThreads({ key, client, queryClient, sleep = wait, now = Date.now }: FollowedLoad): Promise<void> {
  const known = loads.get(key);
  if (known && now() - known.at < FOLLOWED_REFRESH_MS) return known.done;
  const done = (async () => {
    const rooms = await client.rooms.list().catch(() => []);
    for (const [i, room] of rooms.slice(0, FOLLOWED_ROOMS_MAX).entries()) {
      if (i > 0) await sleep(FOLLOWED_GAP_MS);
      let list: FollowedThreads;
      try {
        list = await client.threads.followed(room.id);
      } catch (e) {
        // A node without threads has no such route: nothing to load there. Other failures skip the room.
        if (e instanceof TavrnApiError && e.code === "route.not_found") return;
        continue;
      }
      useThreads.getState().seedRoom(room.id, list.items);
      queryClient.setQueryData(["followed-threads", key, room.id], list);
    }
  })();
  loads.set(key, { at: now(), done });
  return done;
}
