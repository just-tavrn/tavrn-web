// SPDX-License-Identifier: Apache-2.0
// "View the room as a role" (docs/CLIENT.md): the room detail as a member holding only the chosen roles sees it,
// derived with the shared permission evaluation, and the encrypted history window of a new member with those roles.
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { channelAccessMarks, channelPermissions } from "./channelPermissions";
import { cutHistory, isPreviewRoom, previewHides, previewHistoryStart, previewKeepsHit, previewRoleIds, previewRoom } from "./previewRoom";

const { VIEW_CHANNEL: V, READ_HISTORY: H, CONNECT: C, SEND_MESSAGES: M, MANAGE_ROLES: MR, ADMINISTRATOR: ADMIN, KICK_MEMBERS: K } = Permission;
const DAY = 24 * 3600 * 1000;

const channel = (id: string, kind: string, category_id: string | null = null, extra: object = {}) => ({ id, room_id: "r1", category_id, kind, name: id, topic: "", position: 0, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, ...extra });
const o = (id: string, target_type: string, target_id: string, subject_type: string, subject_id: string, allow: bigint, deny: bigint) => ({ id, target_type, target_id, subject_type, subject_id, allow: allow.toString(), deny: deny.toString() });

/** The owner's view of a room: a private "staff" category for the Mods, a read-only "news" channel for @everyone. */
function room(): RoomDetail {
  return {
    id: "r1", name: "R", owner_id: "owner",
    categories: [
      { id: "staff", room_id: "r1", name: "Staff", position: 0, no_bots: false },
      { id: "empty", room_id: "r1", name: "Empty", position: 1, no_bots: false },
    ],
    channels: [
      channel("general", "text"),
      channel("news", "text"),
      channel("lounge", "voice"),
      channel("staff-text", "text", "staff"),
      channel("staff-voice", "voice", "staff"),
      { ...channel("w", "system"), system_name: "welcome" },
    ],
    roles: [
      { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: (V | H | C | M).toString(), hoist: false, mentionable: false, is_everyone: true },
      { id: "mods", room_id: "r1", name: "Mods", color: null, position: 2, permissions: (K | MR).toString(), hoist: false, mentionable: false, is_everyone: false },
      { id: "admins", room_id: "r1", name: "Admins", color: null, position: 3, permissions: ADMIN.toString(), hoist: false, mentionable: false, is_everyone: false },
    ],
    overrides: [
      o("o1", "category", "staff", "role", "everyone", 0n, V),
      o("o2", "category", "staff", "role", "mods", V, 0n),
      o("o3", "channel", "news", "role", "everyone", 0n, M),
      // The viewer's own member override: never part of the simulation.
      o("o4", "channel", "general", "member", "me", 0n, V),
      o("o5", "channel", "staff-voice", "role", "mods", 0n, C),
    ],
    my_roles: ["admins"], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true,
    read_states: [{ conversation_id: "general", unread: 3, mentions: 1 }],
  } as unknown as RoomDetail;
}
const ids = (r: RoomDetail) => r.channels.map((c) => c.id);

describe("previewRoom: the room as the chosen roles see it", () => {
  it("@everyone alone: the private category and its channels are gone, the empty category too", () => {
    const shown = previewRoom(room(), []);
    expect(ids(shown)).toEqual(["general", "news", "lounge", "w"]);
    expect(shown.categories).toEqual([]);
    expect(shown.overrides.map((x) => x.id)).toEqual(["o3"]);
    expect(shown.is_owner).toBe(false);
    expect(shown.my_roles).toEqual([]);
    expect(parsePermissions(shown.my_permissions)).toBe(V | H | C | M);
    expect(shown.read_states).toEqual([]);
    expect(isPreviewRoom(shown)).toBe(true);
    expect(isPreviewRoom(room())).toBe(false);
  });

  it("a role with the category allowed sees it with its channels; the voice deny of the role shows as restricted", () => {
    const r = room();
    const shown = previewRoom(r, ["mods"]);
    expect(ids(shown)).toEqual(["general", "news", "lounge", "staff-text", "staff-voice", "w"]);
    expect(shown.categories.map((c) => c.id)).toEqual(["staff"]);
    expect(shown.my_roles).toEqual(["mods"]);
    expect(parsePermissions(shown.my_permissions)).toBe(V | H | C | M | K | MR);
    expect(channelAccessMarks(shown, "staff-voice", channelPermissions(shown, "staff-voice", "me"))).toEqual(["private", "restricted_join"]);
    expect(channelAccessMarks(shown, "staff-text", channelPermissions(shown, "staff-text", "me"))).toEqual(["private"]);
  });

  it("read-only channel marks follow the role: @everyone may not send in news", () => {
    const shown = previewRoom(room(), []);
    const perms = channelPermissions(shown, "news", "me");
    expect(hasPermission(perms, M)).toBe(false);
    expect(channelAccessMarks(shown, "news", perms)).toEqual(["restricted_read"]);
    expect(channelAccessMarks(shown, "general", channelPermissions(shown, "general", "me"))).toEqual([]);
  });

  it("owner vs role: the owner's own detail keeps everything, an administrator role sees everything as well", () => {
    const r = room();
    expect(hasPermission(channelPermissions(r, "staff-text", "me"), V)).toBe(true);
    const admin = previewRoom(r, ["admins"]);
    expect(ids(admin)).toEqual(ids(r));
    expect(admin.is_owner).toBe(false);
    expect(parsePermissions(admin.my_permissions)).toBe(ALL_PERMISSIONS);
  });

  it("the viewer's member overrides never count (a new member has none)", () => {
    const r = room();
    // As the real viewer, "general" is hidden by the member override o4 if they were not the owner.
    const notOwner = { ...r, is_owner: false, my_roles: [] } as RoomDetail;
    expect(hasPermission(channelPermissions(notOwner, "general", "me"), V)).toBe(false);
    expect(previewRoom(r, []).channels.some((c) => c.id === "general")).toBe(true);
    expect(previewRoom(r, []).overrides.some((x) => x.subject_type === "member")).toBe(false);
  });

  it("unknown role ids and @everyone are ignored; the result is memoized per detail and role set", () => {
    const r = room();
    expect(previewRoleIds(r, ["everyone", "nope", "mods", "mods"])).toEqual(["mods"]);
    expect(previewRoom(r, ["mods"])).toBe(previewRoom(r, ["mods", "nope"]));
    expect(previewRoom(r, ["mods"])).not.toBe(previewRoom(r, []));
  });

  it("the viewer's moved voice participation does not count in the preview", () => {
    const r = room();
    const shown = previewRoom(r, ["mods"]);
    // Mods are denied connect in staff-voice; the real viewer's session there would add it, the preview does not.
    expect(hasPermission(channelPermissions(shown, "staff-voice", "me", "staff-voice"), C)).toBe(false);
  });

  it("previewHides: real channels the roles cannot view", () => {
    const r = room();
    expect(previewHides(r, [], "staff-text")).toBe(true);
    expect(previewHides(r, ["mods"], "staff-text")).toBe(false);
    expect(previewHides(r, [], "general")).toBe(false);
    expect(previewHides(r, [], "unknown")).toBe(false);
  });
});

describe("previewHistoryStart and cutHistory: the encrypted history window of a new member", () => {
  const joined = Date.parse("2026-10-14T12:00:00Z");
  it("plaintext channels are never cut, encrypted ones by the policy from the join", () => {
    expect(previewHistoryStart({ encrypted: false, kind: "text", history_for_new_members: "since_join" }, V | H, joined)).toBeNull();
    expect(previewHistoryStart({ encrypted: true, kind: "text", history_for_new_members: "since_join" }, V | H, joined)).toBe(joined);
    expect(previewHistoryStart({ encrypted: true, kind: "text", history_for_new_members: "days:7" }, V | H, joined)).toBe(joined - 7 * DAY);
    expect(previewHistoryStart({ encrypted: true, kind: "text", history_for_new_members: "all" }, V | H, joined)).toBeNull();
    // Unknown values are since_join (the safe default).
    expect(previewHistoryStart({ encrypted: true, kind: "forum", history_for_new_members: "bogus" }, V | H, joined)).toBe(joined);
  });
  it("without read_history the history starts at the join whatever the policy", () => {
    expect(previewHistoryStart({ encrypted: true, kind: "text", history_for_new_members: "all" }, V, joined)).toBe(joined);
    expect(previewHistoryStart({ encrypted: true, kind: "files", history_for_new_members: "days:30" }, V | M, joined)).toBe(joined);
  });
  it("cuts only encrypted items older than the start; plaintext items stay", () => {
    const items = [
      { id: "new", created_at: "2026-10-14T13:00:00Z", encrypted: true },
      { id: "notice", created_at: "2026-10-01T00:00:00Z", encrypted: false },
      { id: "old", created_at: "2026-10-01T00:00:00Z", encrypted: true },
      { id: "record", created_at: "2026-10-01T00:00:00Z" },
    ];
    const res = cutHistory(items, joined);
    expect(res.items.map((m) => m.id)).toEqual(["new", "notice"]);
    expect(res.cut).toBe(true);
    expect(cutHistory(items, null)).toEqual({ items, cut: false });
    expect(cutHistory(items.slice(0, 2), joined).cut).toBe(false);
  });
  it("search hits: only visible channels, encrypted ones inside the window", () => {
    const r = room();
    const at = (iso: string) => Date.parse(iso);
    expect(previewKeepsHit(r, [], joined, { conversationId: "staff-text", ts: at("2026-10-14T13:00:00Z"), encrypted: false })).toBe(false);
    expect(previewKeepsHit(r, [], joined, { conversationId: "general", ts: at("2026-10-01T00:00:00Z"), encrypted: false })).toBe(true);
    expect(previewKeepsHit(r, [], joined, { conversationId: "general", ts: at("2026-10-01T00:00:00Z"), encrypted: true })).toBe(false);
    expect(previewKeepsHit(r, [], joined, { conversationId: "general", ts: at("2026-10-14T13:00:00Z"), encrypted: true })).toBe(true);
  });
});
