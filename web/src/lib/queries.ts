// SPDX-License-Identifier: Apache-2.0
/**
 * Shared query definitions: one key, one fetch and one freshness per kind of data, used by every view and by the
 * loaders outside React (`queryClient.fetchQuery(roomsQuery(node))` dedupes requests in flight and respects the
 * staleTime). A view that needs a part of the data (a page of members, the rooms of one kind) derives it from the
 * shared entry instead of filling the same key with a different fetch.
 */
import { queryOptions } from "@tanstack/react-query";
import type { Member, TavrnApi } from "@tavrn/sdk";
import { apiFor } from "../stores/nodes";
import { useUnread } from "../stores/unread";

/** Members per page of `GET /rooms/{id}/members` (the node's maximum). */
const MEMBER_PAGE = 500;
/** At most this many pages (10 000 members). */
const MEMBER_PAGES = 20;

/** Every member of a room (pages of 500, the node's order: by user id). */
export async function fetchRoomMembers(api: TavrnApi, roomId: string): Promise<Member[]> {
  const all: Member[] = [];
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const batch = await api.members.list(roomId, { limit: MEMBER_PAGE, after: all.at(-1)?.user.id });
    all.push(...batch);
    if (batch.length < MEMBER_PAGE) break;
  }
  return all;
}

/**
 * The complete member list of a room (`["members", roomId]`): the member list, the settings, the ownership transfer,
 * the ghost check and the cleanup election all read the same entry. Member events patch it (hooks/roomEvents.ts).
 */
export function roomMembersQuery(api: TavrnApi, roomId: string) {
  return queryOptions({ queryKey: ["members", roomId], queryFn: () => fetchRoomMembers(api, roomId), enabled: !!roomId });
}

/**
 * The room list of a node (`["rooms"]` for the home node, `["rooms", domain]` for another one). `client` only for
 * loaders that already hold that node's client (the same requests).
 */
export function roomsQuery(node: string | null, client?: TavrnApi) {
  return queryOptions({ queryKey: node ? ["rooms", node] : ["rooms"], queryFn: () => (client ?? apiFor(node)).rooms.list(), staleTime: 30_000 });
}

/** The DM and group DM list of a node (`["conversations"]` home, `["conversations", domain]`); it seeds the unread counts. */
export function conversationsQuery(node: string | null, client?: TavrnApi) {
  return queryOptions({
    queryKey: node ? ["conversations", node] : ["conversations"],
    queryFn: async () => {
      const list = await (client ?? apiFor(node)).conversations.list();
      useUnread.getState().seed(list.map((c) => ({ conversation_id: c.id, last_message_id: c.last_message_id, last_read_message_id: c.last_read_message_id, unread_count: c.unread_count ?? 0, mention_count: c.mention_count ?? 0 })));
      return list;
    },
    staleTime: 30_000,
  });
}

/** Node information changes rarely (limits, capabilities): ten minutes. */
const NODE_INFO_STALE_MS = 10 * 60_000;

/**
 * `GET /node` of the home node (`["node"]`) or another node with a session (`["node", domain]`). The node this page
 * was loaded from (sign-in pages, before a session exists) keeps its own key `["node", "origin"]` (publicApi).
 */
export function nodeInfoQuery(node: string | null, api: TavrnApi = apiFor(node)) {
  return queryOptions({ queryKey: node ? ["node", node] : ["node"], queryFn: () => api.node.info(), staleTime: NODE_INFO_STALE_MS });
}
