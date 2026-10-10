// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Permission, type RoomDetail } from "@tavrn/sdk";
import { channelPermissions } from "./channelPermissions";

const { VIEW_CHANNEL: V, READ_HISTORY: H, CONNECT: C, SPEAK: S, SEND_MESSAGES: M } = Permission;

/** A voice channel `stage` that @everyone may neither view nor connect to (a moderator may still move people in). */
const room: RoomDetail = {
  id: "r1", name: "R", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed", age_gate: "none", history_restore: "request",
  member_count: 2, categories: [],
  channels: [
    { id: "stage", room_id: "r1", category_id: null, kind: "voice", name: "Stage", topic: "", position: 0, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0 },
    { id: "text", room_id: "r1", category_id: null, kind: "text", name: "chat", topic: "", position: 1, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0 },
  ],
  roles: [{ id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: (V | H | C | S | M).toString(), hoist: false, mentionable: false, is_everyone: true }],
  overrides: [
    { id: "o1", target_type: "channel", target_id: "stage", subject_type: "role", subject_id: "everyone", allow: "0", deny: (V | C | M).toString() },
    { id: "o2", target_type: "channel", target_id: "stage", subject_type: "member", subject_id: "u1", allow: "0", deny: S.toString() },
    { id: "o3", target_type: "channel", target_id: "text", subject_type: "role", subject_id: "everyone", allow: "0", deny: V.toString() },
  ],
  my_roles: [], my_permissions: "0", is_owner: false, read_states: [],
};

describe("channelPermissions: the own voice channel (VOICE.md §7 moved participations)", () => {
  it("hidden and closed without being in it", () => {
    expect(channelPermissions(room, "stage", "u1")).toBe(0n);
    expect(channelPermissions(room, "stage", "u1", null)).toBe(0n);
    expect(channelPermissions(room, "stage", "u1", "other")).toBe(0n);
  });
  it("in it (a moderator moved the user there): view, read and connect, the rest from roles and overrides", () => {
    expect(channelPermissions(room, "stage", "u1", "stage")).toBe(V | H | C);
    expect(channelPermissions(room, "stage", "u2", "stage")).toBe(V | H | C | S);
  });
  it("only for voice channels", () => {
    expect(channelPermissions(room, "text", "u1", "text")).toBe(0n);
  });
});
