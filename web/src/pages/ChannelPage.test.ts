// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Permission, hasPermission, type RoomDetail } from "@tavrn/sdk";
import { channelPermissions } from "./ChannelPage";

const room: RoomDetail = {
  id: "r1", name: "R", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2, categories: [{ id: "cat", room_id: "r1", name: "Allgemein", position: 0, no_bots: false }],
  channels: [
    { id: "c-sync", room_id: "r1", category_id: "cat", kind: "text", name: "a", topic: "", position: 0, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0 },
    { id: "c-own", room_id: "r1", category_id: "cat", kind: "text", name: "b", topic: "", position: 1, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0 },
    { id: "c-welcome", room_id: "r1", category_id: null, kind: "system", name: "welcome", topic: "", position: -1, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: "welcome" },
  ],
  roles: [
    { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES).toString(), hoist: false, mentionable: false, is_everyone: true },
    { id: "mod", room_id: "r1", name: "Mod", color: null, position: 5, permissions: Permission.MANAGE_MESSAGES.toString(), hoist: false, mentionable: false, is_everyone: false },
  ],
  overrides: [
    { id: "o1", target_type: "category", target_id: "cat", subject_type: "role", subject_id: "everyone", allow: "0", deny: Permission.SEND_MESSAGES.toString() },
    { id: "o2", target_type: "channel", target_id: "c-own", subject_type: "member", subject_id: "u1", allow: "0", deny: Permission.VIEW_CHANNEL.toString() },
  ],
  my_roles: ["mod"], my_permissions: "0", is_owner: false, read_states: [],
};

describe("channelPermissions (the client computes like the node)", () => {
  it("a channel without own overrides inherits the category overrides", () => {
    const p = channelPermissions(room, "c-sync", "u1");
    expect(hasPermission(p, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(p, Permission.SEND_MESSAGES)).toBe(false);
    expect(hasPermission(p, Permission.MANAGE_MESSAGES)).toBe(true);
  });
  it("a channel's own override revokes visibility, the category's overrides still apply underneath", () => {
    expect(channelPermissions(room, "c-own", "u1")).toBe(0n);
    const other = channelPermissions(room, "c-own", "u2");
    expect(hasPermission(other, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPermission(other, Permission.SEND_MESSAGES)).toBe(false);
  });
  it("the owner has everything, an unknown channel nothing", () => {
    expect(hasPermission(channelPermissions({ ...room, is_owner: true }, "c-own", "u1"), Permission.ADMINISTRATOR)).toBe(true);
    expect(channelPermissions(room, "nope", "u1")).toBe(0n);
  });
  it("the welcome channel is read-only for everyone, owners included", () => {
    for (const r of [room, { ...room, is_owner: true }]) {
      const p = channelPermissions(r, "c-welcome", "u1");
      expect(hasPermission(p, Permission.VIEW_CHANNEL)).toBe(true);
      expect(hasPermission(p, Permission.SEND_MESSAGES)).toBe(false);
      expect(hasPermission(p, Permission.ATTACH_FILES)).toBe(false);
    }
  });
});

/**
 * The layered cases of tavrn-protocol testvectors/permissions.json ("Layered: …") through `channelPermissions`, the
 * function the sidebar, the composer and the voice client use. The SDK runs the vector file itself.
 */
describe("channelPermissions: layered overrides (role → category → channel → member)", () => {
  type Ov = { subject_type: "role" | "member"; subject_id: string; allow: bigint; deny: bigint };
  const layered = (everyone: bigint, roles: [string, bigint][], category: Ov[], channel: Ov[], myRoles = roles.map(([id]) => id)): RoomDetail => ({
    ...room,
    channels: [{ ...room.channels[0]!, id: "c", category_id: "cat" }],
    roles: [
      { ...room.roles[0]!, id: "r0", permissions: everyone.toString() },
      ...roles.map(([id, p], i) => ({ ...room.roles[1]!, id, position: i + 1, permissions: p.toString() })),
    ],
    overrides: [
      ...category.map((o, i) => ({ id: `oc${i}`, target_type: "category", target_id: "cat", ...o, allow: o.allow.toString(), deny: o.deny.toString() })),
      ...channel.map((o, i) => ({ id: `oh${i}`, target_type: "channel", target_id: "c", ...o, allow: o.allow.toString(), deny: o.deny.toString() })),
    ],
    my_roles: myRoles,
  });
  const role = (id: string, allow: bigint, deny: bigint): Ov => ({ subject_type: "role", subject_id: id, allow, deny });
  const member = (id: string, allow: bigint, deny: bigint): Ov => ({ subject_type: "member", subject_id: id, allow, deny });
  const { VIEW_CHANNEL: V, SEND_MESSAGES: S, ATTACH_FILES: A, KICK_MEMBERS: K } = Permission;

  it.each([
    ["owner example: @everyone without view_channel, a channel allow makes it visible", layered(S, [], [], [role("r0", V, 0n)]), V | S],
    ["a category allow and a channel deny: hidden", layered(S, [], [role("r0", V, 0n)], [role("r0", 0n, V)]), 0n],
    ["a channel without own overrides follows its category's allow", layered(S, [], [role("r0", V, 0n)], []), V | S],
    ["a channel with own overrides still inherits the category underneath", layered(V | S, [], [role("r0", 0n, S)], [role("r0", A, 0n)]), V | A],
    ["inside a layer the member override comes last", layered(V, [["r1", 0n]], [role("r1", S, 0n), member("u1", 0n, S)], []), V],
    ["a channel role deny beats a category member allow", layered(V, [["r1", 0n]], [member("u1", S, 0n)], [role("r1", 0n, S)]), V],
    ["@everyone first inside a layer", layered(V, [["r1", 0n]], [role("r0", 0n, S), role("r1", S, 0n)], []), V | S],
    ["a channel @everyone deny beats a category role allow", layered(V, [["r1", 0n]], [role("r1", S, 0n)], [role("r0", 0n, S)]), V],
    ["room-level bits in an override have no effect", layered(V, [], [role("r0", K, 0n)], []), V],
  ])("%s", (_, r, expected) => {
    expect(channelPermissions(r, "c", "u1")).toBe(expected);
  });
});
