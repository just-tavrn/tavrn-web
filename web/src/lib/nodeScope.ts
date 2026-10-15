// SPDX-License-Identifier: Apache-2.0
/**
 * Which node a room, channel or conversation belongs to (FEDERATION.md: a node speaks only for what it hosts).
 * The query cache keys rooms, channels, conversations, message pages and member lists of every node by the bare id
 * (`["room", id]`, `["messages", id]`, …), and ids are chosen by nodes, so the realtime events of one node's socket
 * must not reach the entries of another node. This registry records, per query client, which node listed each room
 * (`["rooms"]` home, `["rooms", domain]`) and each DM or group DM (`["conversations"]`, `["conversations", domain]`),
 * and which cached room details list each channel. Claims only grow during a session (an id stays known after its
 * list entry left the cache) and are forgotten when the account changes.
 *
 * An id listed by the home node belongs to the home node, whoever else lists it; an id listed by two other nodes
 * belongs to neither. Another node's socket may change an id only when that node alone listed it and the home node's
 * lists of that kind have been seen. The home node's socket loses only rooms another node's room list names while the
 * home node's own (known) list does not: a room detail is whatever its node serves, so channel claims from details
 * (and DM lists, which can name any id) never silence the home node's channels.
 */
import type { Query, QueryClient } from "@tanstack/react-query";
import type { Conversation, Room, RoomDetail } from "@tavrn/sdk";
import { onAccountChange, useAuth } from "../stores/auth";

/** The home node's name in the registry. */
const HOME = "";

export type Kind = "room" | "conversation";

/** `own`: the node alone listed it; `foreign`: another node did; `unknown`: no list names it (yet). */
export type Verdict = "own" | "foreign" | "unknown";

interface Registry {
  generation: number;
  rooms: Map<string, Set<string>>;
  conversations: Map<string, Set<string>>;
  /** Channel id → the ids of the cached room details that list it. */
  channels: Map<string, Set<string>>;
  homeRooms: boolean;
  homeConversations: boolean;
}

let generation = 0;
onAccountChange(() => {
  generation++;
});

const registries = new WeakMap<QueryClient, Registry>();

/** The registry key of a node: the home node (null, or its own domain) is {@link HOME}. */
function nodeKey(node: string | null | undefined): string {
  return !node || node === useAuth.getState().user?.domain ? HOME : node;
}

function add(map: Map<string, Set<string>>, id: unknown, owner: string) {
  if (typeof id !== "string" || !id) return;
  const set = map.get(id);
  if (set) set.add(owner);
  else map.set(id, new Set([owner]));
}

function record(reg: Registry, query: Query) {
  const key = query.queryKey;
  const data = query.state.data;
  if (data === undefined || data === null) return;
  const [head, second, third] = key;
  const list = key.length === 1 || (key.length === 2 && typeof second === "string");
  if (head === "rooms" && list && Array.isArray(data)) {
    const owner = nodeKey(second as string | undefined);
    if (owner === HOME) reg.homeRooms = true;
    for (const r of data as Room[]) add(reg.rooms, r?.id, owner);
  } else if (head === "conversations" && list && Array.isArray(data)) {
    const owner = nodeKey(second as string | undefined);
    if (owner === HOME) reg.homeConversations = true;
    for (const c of data as Conversation[]) add(reg.conversations, c?.id, owner);
  } else if (head === "room" && typeof second === "string") {
    // `["room", id, node]` names its node (the room pickers across nodes).
    if (typeof third === "string") add(reg.rooms, second, nodeKey(third));
    const channels = (data as RoomDetail).channels;
    if (Array.isArray(channels)) for (const c of channels) add(reg.channels, c?.id, second);
  }
}

function registry(queryClient: QueryClient): Registry {
  let reg = registries.get(queryClient);
  if (reg && reg.generation === generation) return reg;
  const fresh: Registry = { generation, rooms: new Map(), conversations: new Map(), channels: new Map(), homeRooms: false, homeConversations: false };
  const cache = queryClient.getQueryCache();
  if (!reg) {
    cache.subscribe((event) => {
      if (event.type === "added" || (event.type === "updated" && event.action.type === "success")) {
        const current = registries.get(queryClient);
        if (current) record(current, event.query);
      }
    });
  }
  reg = fresh;
  registries.set(queryClient, reg);
  for (const query of cache.getAll()) record(reg, query);
  return reg;
}

/** The nodes that listed a room. */
function roomClaims(reg: Registry, roomId: string): Set<string> {
  return reg.rooms.get(roomId) ?? new Set();
}

/** The nodes that listed a channel's room(s) or a DM / group DM. */
function conversationClaims(reg: Registry, id: string): Set<string> {
  const claims = new Set(reg.conversations.get(id) ?? []);
  for (const roomId of reg.channels.get(id) ?? []) for (const n of roomClaims(reg, roomId)) claims.add(n);
  return claims;
}

/** Does the home node list this room? (Prefers the home copy when several cached rooms list one channel.) */
export function homeListsRoom(queryClient: QueryClient, roomId: string): boolean {
  return roomClaims(registry(queryClient), roomId).has(HOME);
}

/** Whose is this id, from the point of view of `node`'s socket (null = the home node)? */
export function verdict(queryClient: QueryClient, node: string | null, kind: Kind, id: string): Verdict {
  const reg = registry(queryClient);
  const claims = kind === "room" ? roomClaims(reg, id) : conversationClaims(reg, id);
  const self = nodeKey(node);
  if (self === HOME) {
    if (claims.has(HOME)) return "own";
    // Only another node's room list against the home node's known one; never a detail's or a DM list's claim.
    return kind === "room" && reg.homeRooms && claims.size ? "foreign" : "unknown";
  }
  if (claims.has(HOME) || [...claims].some((n) => n !== self)) return "foreign";
  if (!claims.has(self)) return "unknown";
  // Until the home node's list of that kind was seen, an id of the home node cannot be told apart.
  const homeSeen = kind === "room" ? reg.homeRooms : reg.homeRooms && reg.homeConversations;
  return homeSeen ? "own" : "unknown";
}

/**
 * May `node`'s socket (null = the home node) change the cached entries of this id? Another node only for ids it alone
 * listed; the home node for everything no other node claims (its own lists may lag behind its events).
 */
export function admits(queryClient: QueryClient, node: string | null, kind: Kind, id: string): boolean {
  const v = verdict(queryClient, node, kind, id);
  return nodeKey(node) === HOME ? v !== "foreign" : v === "own";
}
