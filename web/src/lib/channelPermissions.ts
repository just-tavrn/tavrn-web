// SPDX-License-Identifier: Apache-2.0
import { Permission, computePermissions, hasPermission, type RoomDetail } from "@tavrn/sdk";
import { isPreviewRoom } from "./previewRoom";

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
  // A role preview (lib/previewRoom.ts) simulates a member without the viewer's moved participation.
  if (channel.kind === "voice" && voiceChannelId === channel.id && !isPreviewRoom(room)) {
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

/** The bit a member needs to use a channel of a kind: what the stage, the composer and the files view check. */
const USE_BIT: Record<string, bigint> = {
  voice: Permission.CONNECT,
  text: Permission.SEND_MESSAGES,
  // Posting in announcement channels also needs manage_messages; without it members still reply in threads, so only
  // send_messages counts here (otherwise every announcement channel would be marked for every member).
  announcement: Permission.SEND_MESSAGES,
  forum: Permission.SEND_MESSAGES,
  files: Permission.ATTACH_FILES,
};

/**
 * "Restricted for you" (the channel list's per-viewer mark): the viewer sees the channel (`perms` from
 * `channelPermissions`) but lacks the right to use it: `join` for a voice channel without `connect`, `read_only` for a
 * text, announcement or forum channel without `send_messages` and a files channel without `attach_files`. `null` when
 * the viewer has the right, cannot see the channel at all, or for the welcome channel (read-only for everybody).
 */
export function viewerRestriction(kind: string, perms: bigint): "join" | "read_only" | null {
  const bit = USE_BIT[kind];
  if (bit === undefined || !hasPermission(perms, Permission.VIEW_CHANNEL) || hasPermission(perms, bit)) return null;
  return kind === "voice" ? "join" : "read_only";
}

/**
 * "Private channel" (the channel list's structural mark, the same for everyone who sees the channel): what the
 * `@everyone` role alone may do there, with the same layered evaluation as `channelPermissions` (role bits, then the
 * category's `@everyone` override, then the channel's) and every other role's and member's override ignored.
 * `private` when `@everyone` may not view the channel, `join_private` for a voice channel `@everyone` may view but not
 * connect to, `null` otherwise (also without an `@everyone` role and for the welcome channel, which everyone sees).
 */
export function channelPrivacy(room: Pick<RoomDetail, "channels" | "roles" | "overrides">, channelId: string): "private" | "join_private" | null {
  const channel = room.channels.find((c) => c.id === channelId);
  const everyone = room.roles.find((r) => r.is_everyone);
  if (!channel || !everyone || channel.kind === "system") return null;
  const layer = (type: string, id: string | null | undefined) =>
    room.overrides
      .filter((o) => o.target_type === type && o.target_id === id && o.subject_type === "role" && o.subject_id === everyone.id)
      .map((o) => ({ subject_type: "role" as const, subject_id: o.subject_id, allow: o.allow, deny: o.deny }));
  const perms = computePermissions({
    // No user: only the @everyone role and its overrides count.
    user_id: "",
    is_owner: false,
    everyone_role_id: everyone.id,
    everyone_permissions: everyone.permissions,
    member_roles: [],
    category_overrides: layer("category", channel.category_id),
    channel_overrides: layer("channel", channel.id),
    timed_out: false,
  });
  if (!hasPermission(perms, Permission.VIEW_CHANNEL)) return "private";
  if (channel.kind === "voice" && !hasPermission(perms, Permission.CONNECT)) return "join_private";
  return null;
}

/** The access marks of the channel list, in display order: the structural one first, then the viewer's own. */
export type AccessMarkKind = "private" | "join_private" | "restricted_join" | "restricted_read";

/** Both marks of a channel for a viewer whose permissions there are `perms` (`channelPermissions`). */
export function channelAccessMarks(room: Pick<RoomDetail, "channels" | "roles" | "overrides">, channelId: string, perms: bigint): AccessMarkKind[] {
  const kind = room.channels.find((c) => c.id === channelId)?.kind ?? "";
  const privacy = channelPrivacy(room, channelId);
  const restriction = viewerRestriction(kind, perms);
  return [...(privacy ? [privacy] : []), ...(restriction ? [restriction === "join" ? ("restricted_join" as const) : ("restricted_read" as const)] : [])];
}
