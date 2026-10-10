// SPDX-License-Identifier: Apache-2.0
import { Permission, computePermissions, type RoomDetail } from "@tavrn/sdk";

/** What a moved participation grants in its voice channel (tavrn-protocol permissions.md "Moved participations"). */
const MOVED = Permission.VIEW_CHANNEL | Permission.READ_HISTORY | Permission.CONNECT;

/**
 * Permissions of the signed-in user in a channel, computed client-side with the same logic as the node: the roles,
 * then the category's overrides, then the channel's own on top (layered, tavrn-protocol permissions.md).
 *
 * `voiceChannelId` is the voice channel of this room the user's own voice session is in. The node let them in, so
 * view, read and connect hold there even when the overrides deny them: a moderator may move a member into a channel
 * they may neither view nor connect to (VOICE.md §7 "Moved participations"); the other bits follow the roles and
 * overrides as usual (added last in the channel layer, as the node does).
 */
export function channelPermissions(room: RoomDetail, channelId: string, userId: string, voiceChannelId?: string | null): bigint {
  const channel = room.channels.find((c) => c.id === channelId);
  if (!channel) return 0n;
  const everyone = room.roles.find((r) => r.is_everyone);
  const memberRoles = room.roles.filter((r) => room.my_roles.includes(r.id) && !r.is_everyone).map((r) => [r.id, r.permissions] as [string, string]);
  const toEval = (o: { subject_type: string; subject_id: string; allow: string; deny: string }) => ({ subject_type: o.subject_type as "role" | "member", subject_id: o.subject_id, allow: o.allow, deny: o.deny });
  let channelOverrides = room.overrides.filter((o) => o.target_type === "channel" && o.target_id === channel.id).map(toEval);
  if (channel.kind === "voice" && voiceChannelId === channel.id) {
    // The member override comes last in the channel layer: the moved bits go there.
    const own = channelOverrides.find((o) => o.subject_type === "member" && o.subject_id === userId);
    const merged = { subject_type: "member" as const, subject_id: userId, allow: (BigInt(own?.allow ?? "0") | MOVED).toString(), deny: (BigInt(own?.deny ?? "0") & ~MOVED).toString() };
    channelOverrides = [...channelOverrides.filter((o) => o !== own), merged];
  }
  const perms = computePermissions({
    user_id: userId,
    is_owner: room.is_owner,
    everyone_role_id: everyone?.id ?? "",
    everyone_permissions: everyone?.permissions ?? "0",
    member_roles: memberRoles,
    category_overrides: room.overrides.filter((o) => o.target_type === "category" && o.target_id === channel.category_id).map(toEval),
    channel_overrides: channelOverrides,
    timed_out: false,
    // The welcome channel is visible and read-only for everyone, owners included (SYSTEM_CHANNEL_FORCED/DENIED).
    system_channel: channel.kind === "system",
  });
  return perms;
}
