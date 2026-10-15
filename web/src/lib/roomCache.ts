// SPDX-License-Identifier: Apache-2.0
/**
 * The room detail (`["room", id]`) in the query cache, kept current without refetching the whole room: mutation
 * answers and the payloads of realtime events (they carry the changed role, channel, category or a target's override
 * list, PROTOCOL.md §6) are written into the cached detail with these patches. Only changes that can move the
 * viewer's own room permissions (`my_permissions`, `my_roles`: roles, the own membership, the ownership) still refetch,
 * coalesced and debounced per room by {@link roomRefetcher}. The lists keep the node's order: roles highest first,
 * categories and channels by position, overrides by id (ties by id).
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Category, Channel, Member, PermissionOverride, Role, Room, RoomDetail, User } from "@tavrn/sdk";

/** A change of the cached room detail. */
export type RoomPatch = (room: RoomDetail) => RoomDetail;

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byPosition = (a: { id: string; position: number }, b: { id: string; position: number }) => a.position - b.position || byId(a, b);
const byPositionDesc = (a: { id: string; position: number }, b: { id: string; position: number }) => b.position - a.position || byId(a, b);

/** `list` with `item` inserted or replaced (by id), sorted by `order`. */
function upsert<T extends { id: string }>(list: readonly T[], item: T, order: (a: T, b: T) => number): T[] {
  // An answer without an id (an older node, a malformed event) changes nothing; the next refetch decides.
  if (typeof item?.id !== "string") return [...list];
  return [...list.filter((x) => x.id !== item.id), item].sort(order);
}

type OverrideKey = Pick<PermissionOverride, "target_type" | "target_id" | "subject_type" | "subject_id">;

export const withChannel = (channel: Channel): RoomPatch => (d) => ({ ...d, channels: upsert(d.channels, channel, byPosition) });

/** A deleted (or no longer visible) channel goes with its own overrides. */
export const withoutChannel = (id: string): RoomPatch => (d) => ({
  ...d,
  channels: d.channels.filter((c) => c.id !== id),
  overrides: d.overrides.filter((o) => !(o.target_type === "channel" && o.target_id === id)),
});

export const withCategory = (category: Category): RoomPatch => (d) => ({ ...d, categories: upsert(d.categories, category, byPosition) });

/** A deleted category goes with its overrides; its channels are left without a category (the node moves them out). */
export const withoutCategory = (id: string): RoomPatch => (d) => ({
  ...d,
  categories: d.categories.filter((c) => c.id !== id),
  channels: d.channels.some((c) => c.category_id === id) ? d.channels.map((c) => (c.category_id === id ? { ...c, category_id: null } : c)) : d.channels,
  overrides: d.overrides.filter((o) => !(o.target_type === "category" && o.target_id === id)),
});

export const withRole = (role: Role): RoomPatch => (d) => ({ ...d, roles: upsert(d.roles, role, byPositionDesc) });

export const withoutRole = (id: string): RoomPatch => (d) => ({
  ...d,
  roles: d.roles.filter((r) => r.id !== id),
  my_roles: d.my_roles.filter((r) => r !== id),
  overrides: d.overrides.filter((o) => !(o.subject_type === "role" && o.subject_id === id)),
});

/** The complete override list of one channel or category (the answer of `PUT /overrides`, `override.update`). */
export const withOverrides = (targetType: string, targetId: string, overrides: readonly PermissionOverride[]): RoomPatch => (d) =>
  Array.isArray(overrides) ? { ...d, overrides: [...d.overrides.filter((o) => !(o.target_type === targetType && o.target_id === targetId)), ...overrides].sort(byId) } : d;

/** Overrides cleared one by one ("Reset to category"). */
export const withoutOverrides = (cleared: readonly OverrideKey[]): RoomPatch => (d) => ({
  ...d,
  overrides: d.overrides.filter((o) => !cleared.some((c) => c.target_type === o.target_type && c.target_id === o.target_id && c.subject_type === o.subject_type && c.subject_id === o.subject_id)),
});

/** The room's own settings (`room.update` carries the room without the viewer's fields). */
export const withRoom = (room: Room): RoomPatch => (d) => ({ ...d, ...room });

/** Applies `patch` to every cached copy of the room's detail (also the per-node keys `["room", id, node]`). */
export function patchRoom(queryClient: QueryClient, roomId: string, patch: RoomPatch): void {
  queryClient.setQueriesData<RoomDetail>({ queryKey: ["room", roomId] }, (d) => (d ? patch(d) : d));
}

/**
 * Coalesced, debounced refetches of room details: every `schedule(roomId)` within `delayMs` of the last one ends in
 * one refetch. A fetch of the room in flight is not cancelled; the refetch waits until it is done.
 */
export function roomRefetcher(queryClient: QueryClient, delayMs = 250) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const fire = (roomId: string) => {
    timers.delete(roomId);
    if (queryClient.isFetching({ queryKey: ["room", roomId] }) > 0) {
      schedule(roomId);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["room", roomId] }, { cancelRefetch: false });
  };
  const schedule = (roomId: string) => {
    const pending = timers.get(roomId);
    if (pending) clearTimeout(pending);
    timers.set(roomId, setTimeout(() => fire(roomId), delayMs));
  };
  return {
    schedule,
    stop: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

// ---- The member list of a room (`["members", roomId]`, every member, the node's order: by user id) -------------

/** A change of a cached member list. */
export type MembersPatch = (list: Member[]) => Member[];

const byUserId = (a: Member, b: Member) => (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0);

/** `member` inserted or replaced (by user id), in the node's order. */
export const withMember = (member: Member): MembersPatch => (list) => {
  if (typeof member?.user?.id !== "string") return list;
  const at = list.findIndex((m) => m.user.id === member.user.id);
  if (at >= 0) return list.map((m, i) => (i === at ? member : m));
  return [...list, member].sort(byUserId);
};

/** A joined user (`member.join` carries the user only): no roles, no room profile yet. */
export const joinedMember = (user: User, joinedAt = new Date().toISOString()): Member => ({ user, roles: [], nick: null, nickname: null, joined_at: joinedAt, room_avatar: null, room_avatar_animated: false, room_avatar_still: null, room_bio: null, timeout_until: null });

/** A joined user added unless already listed (a listed member keeps its roles and room profile). */
export const withJoined = (user: User): MembersPatch => (list) => (typeof user?.id !== "string" || list.some((m) => m.user.id === user.id) ? list : withMember(joinedMember(user))(list));

export const withoutMember = (userId: string): MembersPatch => (list) => (list.some((m) => m.user.id === userId) ? list.filter((m) => m.user.id !== userId) : list);

/**
 * The public profile of one user replaced in a list (`user.update`): matched by id and address, so only the copies
 * of the node that sent it change (user ids are node-local; another node's copy, with its own avatar paths, waits
 * for that node's own event). The same list comes back when the user is not in it.
 */
export function withUser<T>(list: readonly T[], user: User, get: (item: T) => User, set: (item: T, user: User) => T): readonly T[] {
  if (!list.some((x) => sameUser(get(x), user))) return list;
  return list.map((x) => (sameUser(get(x), user) ? set(x, { ...get(x), ...user }) : x));
}

export const sameUser = (a: Pick<User, "id" | "address"> | null | undefined, b: Pick<User, "id" | "address">) => !!a && a.id === b.id && a.address === b.address;

/** The cached member list of a room, if any. */
export const cachedMembers = (queryClient: QueryClient, roomId: string) => queryClient.getQueryData<Member[]>(["members", roomId]);

/**
 * Applies `patch` to the room's cached member list. While the list is being fetched the answer may predate the change:
 * it is fetched again instead (the patch would be overwritten). Nothing is fetched for a list nobody loaded.
 */
export function patchMembers(queryClient: QueryClient, roomId: string, patch: MembersPatch): void {
  const query = queryClient.getQueryCache().find<Member[]>({ queryKey: ["members", roomId], exact: true });
  if (!query) return;
  if (query.state.fetchStatus === "fetching") {
    void queryClient.invalidateQueries({ queryKey: ["members", roomId], exact: true });
    return;
  }
  if (query.state.data) queryClient.setQueryData<Member[]>(["members", roomId], (list) => (list ? patch(list) : list));
}

/** `member_count` of the cached room detail moved by `delta` (a join or leave of another member). */
export const withMemberCount = (delta: number): RoomPatch => (d) => ({ ...d, member_count: Math.max(0, (d.member_count ?? 0) + delta) });
