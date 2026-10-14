// SPDX-License-Identifier: Apache-2.0
/**
 * "View the room as a role" (docs/CLIENT.md): the room as a member holding only the chosen roles (and `@everyone`)
 * sees it, derived on this device from the room detail the viewer already has. Nothing is asked of the node: the
 * permissions come from the shared evaluation (`computePermissions` of the SDK, pinned by the protocol's permission
 * test vectors) with `my_roles` = the chosen roles, `is_owner` = false and no member overrides (a new member has
 * none). Approximations: an adult member, not timed out, no moved voice participation, the chosen join date.
 */
import { Permission, hasPermission, roomLevelPermissions, parsePermissions, type Channel, type RoomDetail } from "@tavrn/sdk";
import { historyWindowStart, parseHistoryPolicy } from "@tavrn/e2ee";
import { channelPermissions } from "./channelPermissions";

/** Rooms derived by {@link previewRoom}: the voice "moved participation" of the real user never counts there. */
const derived = new WeakSet<RoomDetail>();
/** One derived room per cached room detail and role set, so consumers keep stable references. */
const memo = new WeakMap<RoomDetail, Map<string, RoomDetail>>();

/** Is this room detail a preview ({@link previewRoom})? */
export function isPreviewRoom(room: RoomDetail | null | undefined): boolean {
  return !!room && derived.has(room);
}

/** The chosen role ids that exist in the room, without `@everyone` (every member holds it anyway). */
export function previewRoleIds(room: Pick<RoomDetail, "roles">, roleIds: readonly string[]): string[] {
  return roleIds.filter((id, i) => roleIds.indexOf(id) === i && room.roles.some((r) => r.id === id && !r.is_everyone));
}

/**
 * The room detail as a member holding only `roleIds` (plus `@everyone`) would get it: the channels and categories that
 * member may view (a category with at least one visible channel), the overrides of what is left without any member's
 * own, `my_roles`/`my_permissions`/`is_owner` of that member, no read states (the unread counts are the viewer's).
 */
export function previewRoom(room: RoomDetail, roleIds: readonly string[]): RoomDetail {
  const roles = previewRoleIds(room, roleIds);
  const key = roles.join(",");
  const cached = memo.get(room)?.get(key);
  if (cached) return cached;
  const everyone = room.roles.find((r) => r.is_everyone);
  const memberRoles = room.roles.filter((r) => roles.includes(r.id)).map((r) => [r.id, parsePermissions(r.permissions)] as [string, bigint]);
  const roomPerms = roomLevelPermissions(false, parsePermissions(everyone?.permissions), memberRoles);
  // The simulated member: the chosen roles, not the owner, no member overrides (the viewer's own would count otherwise).
  const base: RoomDetail = { ...room, is_owner: false, my_roles: roles, my_permissions: roomPerms.toString(), overrides: room.overrides.filter((o) => o.subject_type !== "member"), read_states: [] };
  const channels = room.channels.filter((c) => hasPermission(channelPermissions(base, c.id, ""), Permission.VIEW_CHANNEL));
  const ids = new Set(channels.map((c) => c.id));
  const categories = room.categories.filter((cat) => channels.some((c) => c.category_id === cat.id));
  const categoryIds = new Set(categories.map((c) => c.id));
  const overrides = base.overrides.filter((o) => (o.target_type === "channel" ? ids.has(o.target_id) : o.target_type === "category" ? categoryIds.has(o.target_id) : true));
  const result: RoomDetail = { ...base, channels, categories, overrides };
  derived.add(result);
  const perRoom = memo.get(room) ?? new Map<string, RoomDetail>();
  perRoom.set(key, result);
  memo.set(room, perRoom);
  return result;
}

/** Does the preview hide this channel of the real room (it exists, the simulated member may not view it)? */
export function previewHides(room: RoomDetail, roleIds: readonly string[], channelId: string): boolean {
  return room.channels.some((c) => c.id === channelId) && !previewRoom(room, roleIds).channels.some((c) => c.id === channelId);
}

/**
 * Start of the encrypted history a new member with these permissions gets in a channel (milliseconds), or null when
 * nothing is cut: plaintext channels never (the node serves their history to every member who may read it), encrypted
 * ones by the channel's `history_for_new_members` from the join (ENCRYPTION.md §7b), and from the join itself without
 * `read_history` (tavrn-protocol permissions.md).
 */
export function previewHistoryStart(channel: Pick<Channel, "encrypted" | "history_for_new_members" | "kind">, perms: bigint, joinedAtMs: number): number | null {
  if (!channel.encrypted || channel.kind === "voice" || channel.kind === "system") return null;
  if (!hasPermission(perms, Permission.READ_HISTORY)) return joinedAtMs;
  return historyWindowStart(parseHistoryPolicy(channel.history_for_new_members), joinedAtMs);
}

/**
 * Cuts encrypted items older than `start` (messages, forum posts, file entries); plaintext items stay (`encrypted`
 * false), so an encrypted channel's plaintext notices are never cut. `cut` says whether anything was dropped, i.e. the
 * window's start lies within what is loaded.
 */
export function cutHistory<T extends { created_at: string; encrypted?: boolean }>(items: readonly T[], start: number | null): { items: T[]; cut: boolean } {
  if (start === null) return { items: items as T[], cut: false };
  const kept = items.filter((m) => m.encrypted === false || Date.parse(m.created_at) >= start);
  return { items: kept.length === items.length ? (items as T[]) : kept, cut: kept.length !== items.length };
}

/**
 * Does a search hit of the real room stay in the preview? Only in channels the roles may view, and an encrypted hit
 * (the local index) only from inside the history window a new member with the roles gets.
 */
export function previewKeepsHit(room: RoomDetail, roleIds: readonly string[], joinedAtMs: number, hit: { conversationId: string; ts: number; encrypted: boolean }): boolean {
  const shown = previewRoom(room, roleIds);
  const channel = shown.channels.find((c) => c.id === hit.conversationId);
  if (!channel) return false;
  if (!hit.encrypted) return true;
  const start = previewHistoryStart(channel, channelPermissions(shown, channel.id, ""), joinedAtMs);
  return start === null || hit.ts >= start;
}
