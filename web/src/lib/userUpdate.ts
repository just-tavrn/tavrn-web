// SPDX-License-Identifier: Apache-2.0
/**
 * `user.update { user }` (PROTOCOL.md §6: a user's name or avatar changed) written into the cached lists that show the
 * user, instead of refetching every member list, the friends list and every node's conversation list: member lists
 * (`["members", room]`), conversation lists and details, the friends list. Only the caches of the node whose socket
 * delivered the event change (its rooms' member lists, its conversation list, the friends list for the home node), and
 * there only the copies with the event's user id and address: user ids are node-local, and a node speaks only for
 * the copies it served. Profile cards of the user are refreshed; the block list and message requests as before.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Conversation, FriendList, Member, Room, User } from "@tavrn/sdk";
import { withUser } from "./roomCache";
import { admits } from "./nodeScope";

/** Is `u` a well-formed user of an event (from a node: checked before it touches the cache)? */
export function isEventUser(u: unknown): u is User {
  const x = u as Partial<User> | null;
  return !!x && typeof x === "object" && typeof x.id === "string" && typeof x.address === "string";
}

const memberUser = (m: Member) => m.user;
const withMemberUser = (m: Member, user: User): Member => ({ ...m, user });
const self = (u: User) => u;
const replaced = (_: User, user: User) => user;

/** The conversation with the user's copy replaced, or the same object. */
function inConversation(c: Conversation, user: User): Conversation {
  if (!Array.isArray(c?.members)) return c;
  const members = withUser(c.members, user, self, replaced);
  return members === c.members ? c : { ...c, members: members as User[] };
}

/** `undefined` keeps the cached data untouched (no notification of the observers). */
const changed = <T>(before: T, after: T): T | undefined => (after === before ? undefined : after);

/** `node`: the node whose socket delivered the event, null for the home node. */
export function applyUserUpdate(queryClient: QueryClient, user: User, node: string | null): void {
  // Only the rooms and conversations this node alone lists (another node may name the home node's ids, lib/nodeScope.ts).
  const rooms = new Set((queryClient.getQueryData<Room[]>(node ? ["rooms", node] : ["rooms"]) ?? []).map((r) => r.id).filter((id) => admits(queryClient, node, "room", id)));
  queryClient.setQueriesData<Member[]>({ queryKey: ["members"], predicate: (q) => rooms.has(q.queryKey[1] as string) }, (list) =>
    Array.isArray(list) ? changed(list, withUser(list, user, memberUser, withMemberUser) as Member[]) : undefined,
  );
  const listKey = node ? ["conversations", node] : ["conversations"];
  const conversations = queryClient.getQueryData<Conversation[]>(listKey);
  if (Array.isArray(conversations)) {
    const next = conversations.map((c) => inConversation(c, user));
    if (next.some((c, i) => c !== conversations[i])) queryClient.setQueryData(listKey, next);
    const ids = new Set(conversations.map((c) => c.id).filter((id) => admits(queryClient, node, "conversation", id)));
    queryClient.setQueriesData<Conversation>({ queryKey: ["conversation"], predicate: (q) => ids.has(q.queryKey[1] as string) }, (c) =>
      c && typeof c === "object" && !Array.isArray(c) ? changed(c, inConversation(c, user)) : undefined,
    );
  }
  if (node !== null) {
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "profile" && q.queryKey[1] === node && q.queryKey[2] === user.address });
    return;
  }
  queryClient.setQueryData<FriendList>(["friends"], (f) => {
    if (!f || !Array.isArray(f.friends)) return undefined;
    const viaUser = <T extends { user: User }>(list: T[] | undefined) => (Array.isArray(list) ? (withUser(list, user, (x) => x.user, (x, u) => ({ ...x, user: u })) as T[]) : list);
    const next: FriendList = { ...f, friends: viaUser(f.friends)!, incoming: viaUser(f.incoming)!, outgoing: viaUser(f.outgoing)!, blocked: Array.isArray(f.blocked) ? (withUser(f.blocked, user, self, replaced) as User[]) : f.blocked };
    return next.friends === f.friends && next.incoming === f.incoming && next.outgoing === f.outgoing && next.blocked === f.blocked ? undefined : next;
  });
  // Profile cards (`["profile", node | "me", address]`) of this user only.
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "profile" && q.queryKey[1] !== node && q.queryKey[2] === user.address });
  for (const key of ["blocks", "requests"]) void queryClient.invalidateQueries({ queryKey: [key] });
}

