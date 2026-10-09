// SPDX-License-Identifier: Apache-2.0
/**
 * Permissions of any member of a room in a channel, computed by the client with the same rules as the node
 * (tavrn-protocol/permissions.md, `computePermissions` of the SDK). `channelPermissions` (pages/ChannelPage.tsx)
 * covers the own user from `my_roles`; this one takes a member of the member list, so the voice client can
 * check what another participant may do (the priority speaker of design note 4.13 item 3) instead of trusting
 * what that participant's client claims.
 */
import { computePermissions, type Channel, type Member, type PermissionOverride, type Role } from "@tavrn/sdk";

export interface RoomPermissionData {
  owner_id: string;
  no_bots?: boolean;
  roles: Pick<Role, "id" | "permissions" | "is_everyone">[];
  overrides: Pick<PermissionOverride, "target_type" | "target_id" | "subject_type" | "subject_id" | "allow" | "deny">[];
  channels: (Pick<Channel, "id" | "category_id" | "no_bots_effective"> & { kind?: string })[];
}

export function memberChannelPermissions(
  room: RoomPermissionData,
  channelId: string,
  member: Pick<Member, "roles" | "timeout_until"> & { user: Pick<Member["user"], "id" | "kind"> },
  now = Date.now(),
): bigint {
  const channel = room.channels.find((c) => c.id === channelId);
  if (!channel) return 0n;
  const everyone = room.roles.find((r) => r.is_everyone);
  const toEval = (o: RoomPermissionData["overrides"][number]) => ({ subject_type: o.subject_type as "role" | "member", subject_id: o.subject_id, allow: o.allow, deny: o.deny });
  return computePermissions({
    user_id: member.user.id,
    is_owner: member.user.id === room.owner_id,
    everyone_role_id: everyone?.id ?? "",
    everyone_permissions: everyone?.permissions ?? "0",
    member_roles: room.roles.filter((r) => !r.is_everyone && member.roles.includes(r.id)).map((r) => [r.id, r.permissions] as [string, string]),
    category_overrides: room.overrides.filter((o) => o.target_type === "category" && o.target_id === channel.category_id).map(toEval),
    channel_overrides: room.overrides.filter((o) => o.target_type === "channel" && o.target_id === channel.id).map(toEval),
    timed_out: !!member.timeout_until && Date.parse(member.timeout_until) > now,
    kind: member.user.kind,
    no_bots: channel.no_bots_effective ?? room.no_bots ?? false,
    system_channel: channel.kind === "system",
  });
}
