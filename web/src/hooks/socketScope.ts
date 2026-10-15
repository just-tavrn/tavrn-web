// SPDX-License-Identifier: Apache-2.0
/**
 * The node scope of realtime events (lib/nodeScope.ts): every handler registered on a socket through
 * {@link scopeSocket} sees only the events whose rooms, channels and conversations belong to the socket's node. The
 * scope of an event comes from its payload: the room it names must be the node's, the conversation (channel, DM or
 * group DM) too; channel ids that a room event adds or changes must at least not belong to another node. Events
 * without such ids (profiles, presence, the moderation inbox, MLS) pass unchanged.
 *
 * An id no list names yet is not the node's to change. For another node's socket three cases still matter: a new
 * message there (the room or DM is looked up on that node first and the event is handled once that node lists it),
 * a new or changed DM or group DM and a room change (that node's own list is refreshed). Everything else is dropped.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { TavrnSocket } from "@tavrn/sdk";
import { admits, verdict, type Kind } from "../lib/nodeScope";
import { loadRoomDetails } from "../lib/notify";
import { conversationsQuery, roomsQuery } from "../lib/queries";

interface Scope {
  /** Ids that must belong to the node. */
  own: Array<[Kind, unknown]>;
  /** Channel ids an event writes into a room: they must not belong to another node. */
  channels?: unknown[];
}

type Payload = Record<string, unknown> | null | undefined;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const field = (d: Payload, key: string): unknown => (d && typeof d === "object" ? d[key] : undefined);

const ROOM_EVENTS = new Set(["category.create", "category.update", "category.delete", "override.update", "role.create", "role.update", "role.delete", "member.update", "member.join", "member.leave", "emoji.update"]);
const CONVERSATION_EVENTS = new Set(["message.create", "message.update", "message.delete", "message.redact", "poll.vote.delete", "read.update", "interaction.reply", "conversation.leave"]);

/** The ids an event of this type touches; null for events that are not scoped to a room or conversation. */
export function scopeOf(type: string, data: unknown): Scope | null {
  const d = data as Payload;
  if (ROOM_EVENTS.has(type)) return { own: [["room", field(d, "room_id")]] };
  if (CONVERSATION_EVENTS.has(type)) return { own: [["conversation", field(d, "conversation_id")]] };
  switch (type) {
    case "room.update":
    case "room.delete":
      return { own: [["room", field(d, "id")]] };
    case "channel.create":
    case "channel.update":
    case "channel.delete":
      // A channel the viewer can no longer see may come without its room (`hidden`): then the channel itself decides.
      return field(d, "room_id") === undefined ? { own: [["conversation", field(d, "id")]] } : { own: [["room", field(d, "room_id")]], channels: [field(d, "id")] };
    case "thread.create":
    case "thread.update": {
      const thread = field(d, "thread") as Payload;
      return { own: [["room", field(d, "room_id")]], channels: [field(thread, "channel_id")] };
    }
    case "thread.delete":
    case "thread.read":
      return { own: [["room", field(d, "room_id")]], channels: [field(d, "channel_id")] };
    case "message.purge": {
      const ids = field(d, "conversation_ids");
      return { own: Array.isArray(ids) ? ids.map((id) => ["conversation", id] as [Kind, unknown]) : [["conversation", undefined]] };
    }
    case "poll.vote": {
      const vote = (field(d, "vote") as Payload) ?? d;
      return { own: [["conversation", field(vote, "conversation_id")]] };
    }
    case "typing":
      return { own: [["conversation", field(d, "channel_id") ?? field(d, "conversation_id")]] };
    case "conversation.create":
    case "conversation.update":
      return { own: [["conversation", field(field(d, "conversation") as Payload, "id")]] };
    default:
      return null;
  }
}

/** Not looked up again for this long when the node does not list the conversation of a message. */
const UNRESOLVED_MS = 60_000;
const unresolved = new Map<string, number>();

/** Forgets the negative lookups (tests). */
export function resetScopeLookups(): void {
  unresolved.clear();
}

/**
 * Looks up a conversation of a message on `node` (its rooms, then its DM list) and tells whether that node owns it.
 * The home node's lists are loaded too: only then can an id of the home node be told apart.
 */
async function resolveConversation(queryClient: QueryClient, node: string, conversationId: string): Promise<boolean> {
  const key = `${node}|${conversationId}`;
  if ((unresolved.get(key) ?? 0) > Date.now()) return false;
  await Promise.all([queryClient.fetchQuery(roomsQuery(null)).catch(() => undefined), queryClient.fetchQuery(conversationsQuery(null)).catch(() => undefined), loadRoomDetails(queryClient, node, conversationId).catch(() => undefined)]);
  if (verdict(queryClient, node, "conversation", conversationId) === "unknown") await queryClient.fetchQuery({ ...conversationsQuery(node), staleTime: 0 }).catch(() => undefined);
  const own = admits(queryClient, node, "conversation", conversationId);
  if (!own) unresolved.set(key, Date.now() + UNRESOLVED_MS);
  return own;
}

/** Is the event within the node's scope? `unknown` when an id it must own is not listed by any node yet. */
function check(queryClient: QueryClient, node: string | null, scope: Scope): "pass" | "drop" | "unknown" {
  let unknown = false;
  for (const [kind, id] of scope.own) {
    const s = str(id);
    if (!s) return "drop";
    if (admits(queryClient, node, kind, s)) continue;
    if (node === null || verdict(queryClient, node, kind, s) !== "unknown") return "drop";
    unknown = true;
  }
  for (const id of scope.channels ?? []) {
    const s = str(id);
    if (s && verdict(queryClient, node, "conversation", s) === "foreign") return "drop";
  }
  return unknown ? "unknown" : "pass";
}

/**
 * A view of `socket` whose handlers see only the events within the scope of `node` (null = the home node). Only
 * `on` is used by the handlers of rooms, messages and conversations.
 */
export function scopeSocket(socket: TavrnSocket, queryClient: QueryClient, node: string | null): TavrnSocket {
  const scoped = Object.create(socket) as TavrnSocket;
  scoped.on = (<T>(type: string, handler: (data: T) => void) =>
    socket.on<T>(type, (data) => {
      const scope = scopeOf(type, data);
      if (!scope) return handler(data);
      const result = check(queryClient, node, scope);
      if (result === "pass") return handler(data);
      if (result === "drop" || node === null) return;
      // Not listed by any node yet, on another node's socket.
      if (type === "message.create") {
        const conversationId = str(field(data as Payload, "conversation_id"))!;
        void resolveConversation(queryClient, node, conversationId).then((own) => (own ? handler(data) : undefined));
      } else if (type === "conversation.create" || type === "conversation.update") {
        void queryClient.invalidateQueries({ queryKey: ["conversations", node], exact: true });
      } else if (type === "member.join" || type === "room.update") {
        void queryClient.invalidateQueries({ queryKey: ["rooms", node], exact: true });
      }
    })) as TavrnSocket["on"];
  return scoped;
}
