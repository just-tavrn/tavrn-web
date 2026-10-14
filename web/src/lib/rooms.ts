// SPDX-License-Identifier: Apache-2.0
import { Permission, hasPermission, parsePermissions, roomLevelPermissions, type Member, type RoomDetail } from "@tavrn/sdk";

/** The room permissions that let a member remove leaves of departed members (ENCRYPTION.md §4.7 rule 3). */
const MANAGE = [Permission.ADMINISTRATOR, Permission.KICK_MEMBERS, Permission.BAN_MEMBERS, Permission.MANAGE_CHANNELS];

/**
 * May the user remove MLS leaves of departed members in this room's channels (`mls.remove_needed`,
 * ENCRYPTION.md §4.5)? Owners and members who may kick, ban or manage channels.
 */
export function mayManageRoom(room: RoomDetail): boolean {
  const p = parsePermissions(room.my_permissions);
  return room.is_owner || MANAGE.some((b) => hasPermission(p, b));
}

/**
 * The members who may do the same, by their roles ({@link mayManageRoom} for each of them): only their devices are
 * elected to remove a departed member's leaf (the cleanup election, `LeafCleaner` `managers`). Bots run no cleanup.
 * Null without a loaded member list (every member then counts).
 */
export function roomManagers(room: Pick<RoomDetail, "owner_id" | "roles">, members: Member[] | undefined): string[] | null {
  if (!members) return null;
  const everyone = BigInt(room.roles.find((r) => r.is_everyone)?.permissions ?? "0");
  const roles = new Map(room.roles.filter((r) => !r.is_everyone).map((r) => [r.id, BigInt(r.permissions)] as const));
  return members
    .filter((m) => (m.user.kind ?? "user") === "user")
    .filter((m) => {
      const own = m.roles.flatMap((id) => (roles.has(id) ? [[id, roles.get(id)!] as [string, bigint]] : []));
      const p = roomLevelPermissions(m.user.id === room.owner_id, everyone, own);
      return MANAGE.some((b) => hasPermission(p, b));
    })
    .map((m) => m.user.address);
}
