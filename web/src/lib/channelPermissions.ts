// SPDX-License-Identifier: Apache-2.0
import { computePermissions, type RoomDetail } from "@tavrn/sdk";

/**
 * Permissions of the signed-in user in a channel, computed client-side with the same logic as the node: the roles,
 * then the category's overrides, then the channel's own on top (layered, tavrn-protocol permissions.md).
 */
export function channelPermissions(room: RoomDetail, channelId: string, userId: string): bigint {
  const channel = room.channels.find((c) => c.id === channelId);
  if (!channel) return 0n;
  const everyone = room.roles.find((r) => r.is_everyone);
  const memberRoles = room.roles.filter((r) => room.my_roles.includes(r.id) && !r.is_everyone).map((r) => [r.id, r.permissions] as [string, string]);
  const toEval = (o: { subject_type: string; subject_id: string; allow: string; deny: string }) => ({ subject_type: o.subject_type as "role" | "member", subject_id: o.subject_id, allow: o.allow, deny: o.deny });
  const perms = computePermissions({
    user_id: userId,
    is_owner: room.is_owner,
    everyone_role_id: everyone?.id ?? "",
    everyone_permissions: everyone?.permissions ?? "0",
    member_roles: memberRoles,
    category_overrides: room.overrides.filter((o) => o.target_type === "category" && o.target_id === channel.category_id).map(toEval),
    channel_overrides: room.overrides.filter((o) => o.target_type === "channel" && o.target_id === channel.id).map(toEval),
    timed_out: false,
    // The welcome channel is visible and read-only for everyone, owners included (SYSTEM_CHANNEL_FORCED/DENIED).
    system_channel: channel.kind === "system",
  });
  return perms;
}
