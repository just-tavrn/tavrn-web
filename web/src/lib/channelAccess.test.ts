// SPDX-License-Identifier: Apache-2.0
// The two access marks of the channel list: "restricted for you" (the viewer may see a channel but not use it) and
// "private channel" (the @everyone role may not view it, or may not join a voice channel).
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { channelAccessMarks, channelPrivacy, viewerRestriction } from "./channelPermissions";

const { VIEW_CHANNEL: V, READ_HISTORY: H, CONNECT: C, SEND_MESSAGES: M, ATTACH_FILES: A, CREATE_THREADS: T, MANAGE_MESSAGES: MM } = Permission;

describe("viewerRestriction: the right to use a channel the viewer can see", () => {
  it("voice needs connect", () => {
    expect(viewerRestriction("voice", V | H)).toBe("join");
    expect(viewerRestriction("voice", V | H | C)).toBeNull();
    // Sending text in the voice channel's chat is not what the row offers.
    expect(viewerRestriction("voice", V | M)).toBe("join");
  });
  it("text, announcement and forum need send_messages (the composer and the forum's new post)", () => {
    for (const kind of ["text", "announcement", "forum"]) {
      expect(viewerRestriction(kind, V | H | T | A)).toBe("read_only");
      expect(viewerRestriction(kind, V | M)).toBeNull();
    }
    // Announcement channels are read-only for members without manage_messages by design: no mark for that.
    expect(viewerRestriction("announcement", V | M)).toBeNull();
    expect(viewerRestriction("announcement", V | M | MM)).toBeNull();
  });
  it("files channels need attach_files (uploads)", () => {
    expect(viewerRestriction("files", V | M)).toBe("read_only");
    expect(viewerRestriction("files", V | A)).toBeNull();
  });
  it("nothing for the welcome channel (read-only for everybody), invisible channels or full rights", () => {
    expect(viewerRestriction("system", V | H)).toBeNull();
    expect(viewerRestriction("text", 0n)).toBeNull();
    expect(viewerRestriction("voice", 0n)).toBeNull();
    for (const kind of ["text", "announcement", "forum", "files", "voice"]) expect(viewerRestriction(kind, ALL_PERMISSIONS)).toBeNull();
  });
});

const channel = (id: string, kind: string, category_id: string | null = null) => ({ id, room_id: "r1", category_id, kind, name: id, topic: "", position: 0, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0 });
const room = (everyonePerms: bigint, overrides: RoomDetail["overrides"]): RoomDetail =>
  ({
    id: "r1", name: "R", owner_id: "owner", categories: [{ id: "staff", room_id: "r1", name: "Staff", position: 0, no_bots: false }],
    channels: [channel("text", "text"), channel("voice", "voice"), channel("staff-text", "text", "staff"), channel("staff-voice", "voice", "staff"), { ...channel("w", "system"), system_name: "welcome" }],
    roles: [
      { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: everyonePerms.toString(), hoist: false, mentionable: false, is_everyone: true },
      { id: "mods", room_id: "r1", name: "Mods", color: null, position: 1, permissions: (V | C | M).toString(), hoist: false, mentionable: false, is_everyone: false },
    ],
    overrides,
    // The viewer's own roles and ownership never matter for the structural mark.
    my_roles: ["mods"], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
  }) as unknown as RoomDetail;
const o = (id: string, target_type: string, target_id: string, subject_type: string, subject_id: string, allow: bigint, deny: bigint) => ({ id, target_type, target_id, subject_type, subject_id, allow: allow.toString(), deny: deny.toString() });

describe("channelPrivacy: what @everyone may do (role bits plus the category's and the channel's @everyone overrides)", () => {
  it("no mark when @everyone may view (and connect to voice)", () => {
    const r = room(V | H | C | M, []);
    for (const id of ["text", "voice", "staff-text", "staff-voice", "w"]) expect(channelPrivacy(r, id)).toBeNull();
  });
  it("private when the role lacks view_channel and no override allows it", () => {
    const r = room(M | C, [o("o1", "channel", "text", "role", "everyone", V, 0n)]);
    expect(channelPrivacy(r, "text")).toBeNull();
    expect(channelPrivacy(r, "voice")).toBe("private");
    expect(channelPrivacy(r, "staff-text")).toBe("private");
  });
  it("a channel override denying view to @everyone makes it private; the category's deny too, unless the channel allows it again", () => {
    const r = room(V | H | C | M, [
      o("o1", "channel", "text", "role", "everyone", 0n, V),
      o("o2", "category", "staff", "role", "everyone", 0n, V),
      o("o3", "channel", "staff-voice", "role", "everyone", V, 0n),
    ]);
    expect(channelPrivacy(r, "text")).toBe("private");
    expect(channelPrivacy(r, "staff-text")).toBe("private");
    expect(channelPrivacy(r, "staff-voice")).toBeNull();
  });
  it("other roles' and members' overrides are ignored: granting view to a role keeps the channel private", () => {
    const r = room(V | H | C | M, [
      o("o1", "channel", "text", "role", "everyone", 0n, V),
      o("o2", "channel", "text", "role", "mods", V, 0n),
      o("o3", "channel", "text", "member", "u1", V, 0n),
      o("o4", "channel", "voice", "member", "u1", 0n, V),
    ]);
    expect(channelPrivacy(r, "text")).toBe("private");
    expect(channelPrivacy(r, "voice")).toBeNull();
  });
  it("a voice channel @everyone may view but not join is join-private; text channels never are", () => {
    const r = room(V | H | C | M, [o("o1", "channel", "voice", "role", "everyone", 0n, C), o("o2", "channel", "text", "role", "everyone", 0n, M)]);
    expect(channelPrivacy(r, "voice")).toBe("join_private");
    expect(channelPrivacy(r, "text")).toBeNull();
    expect(channelPrivacy(room(V | H | M, []), "voice")).toBe("join_private");
  });
  it("the welcome channel is visible to everyone and never private", () => {
    expect(channelPrivacy(room(0n, [o("o1", "channel", "w", "role", "everyone", 0n, V)]), "w")).toBeNull();
  });
  it("no mark without an @everyone role (older nodes) or for an unknown channel", () => {
    const r = room(V, []);
    expect(channelPrivacy({ ...r, roles: r.roles.filter((x) => !x.is_everyone) }, "text")).toBeNull();
    expect(channelPrivacy(r, "nope")).toBeNull();
  });
});

describe("channelAccessMarks: both marks in display order", () => {
  it("private before restricted; nothing with full rights in an open channel", () => {
    const r = room(V | H | M, [o("o1", "channel", "text", "role", "everyone", 0n, V)]);
    expect(channelAccessMarks(r, "voice", V | H)).toEqual(["join_private", "restricted_join"]);
    expect(channelAccessMarks(r, "text", V | H)).toEqual(["private", "restricted_read"]);
    expect(channelAccessMarks(r, "text", ALL_PERMISSIONS)).toEqual(["private"]);
    expect(channelAccessMarks(room(V | H | C | M, []), "text", ALL_PERMISSIONS)).toEqual([]);
  });
});
