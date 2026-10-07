// SPDX-License-Identifier: Apache-2.0
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";

/**
 * May the user remove MLS leaves of departed members in this room's channels (`mls.remove_needed`,
 * ENCRYPTION.md §4.5)? Owners and members who may kick, ban or manage channels.
 */
export function mayManageRoom(room: RoomDetail): boolean {
  const p = parsePermissions(room.my_permissions);
  return room.is_owner || [Permission.ADMINISTRATOR, Permission.KICK_MEMBERS, Permission.BAN_MEMBERS, Permission.MANAGE_CHANNELS].some((b) => hasPermission(p, b));
}
