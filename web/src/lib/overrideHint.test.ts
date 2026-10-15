// SPDX-License-Identifier: Apache-2.0
// The input of the override editors' hint (inheritedOverrideValue): roles, the category below a channel, the edited
// layer, and a member subject's roles.
import { describe, expect, it } from "vitest";
import { Permission, inheritedOverrideValue, type RoomDetail } from "@tavrn/sdk";
import { overrideHintInput } from "./overrideHint";

const { VIEW_CHANNEL: V, SEND_MESSAGES: S, ATTACH_FILES: A } = Permission;
const role = (id: string, name: string, permissions: bigint, is_everyone = false) => ({ id, room_id: "r1", name, color: null, position: is_everyone ? 0 : 1, permissions: permissions.toString(), hoist: false, mentionable: false, is_everyone });
const override = (id: string, target_type: "category" | "channel", target_id: string, subject_type: "role" | "member", subject_id: string, allow: bigint, deny: bigint) => ({ id, target_type, target_id, subject_type, subject_id, allow: allow.toString(), deny: deny.toString() });
const room = {
  id: "r1",
  categories: [{ id: "team", room_id: "r1", name: "Team", position: 0, no_bots: false }],
  channels: [{ id: "c1", room_id: "r1", category_id: "team", kind: "text", name: "allgemein" }],
  roles: [role("everyone", "@everyone", V | S, true), role("mod", "Moderator", 0n), role("files", "Dateien", A)],
  overrides: [
    override("o1", "category", "team", "role", "everyone", 0n, V),
    override("o2", "category", "team", "role", "mod", V, 0n),
    override("o3", "category", "team", "member", "u1", 0n, S),
    override("o4", "channel", "c1", "role", "files", 0n, A),
  ],
} as unknown as RoomDetail;

describe("overrideHintInput", () => {
  it("the category editor: no category below, the category's overrides are the edited layer", () => {
    const input = overrideHintInput(room, { type: "category", id: "team" }, { type: "role", id: "files" });
    expect(input.category_overrides).toBeNull();
    expect(input.layer_overrides.map((o) => o.subject_id)).toEqual(["everyone", "mod", "u1"]);
    expect(input.roles).toEqual([["mod", "0"], ["files", A.toString()]]);
    expect(inheritedOverrideValue(input, V)).toEqual({ allowed: false, source: "everyone" });
  });

  it("the channel editor: the category below, the channel's overrides as the edited layer", () => {
    const input = overrideHintInput(room, { type: "channel", id: "c1" }, { type: "role", id: "files" });
    expect(input.category_overrides?.map((o) => o.subject_id)).toEqual(["everyone", "mod", "u1"]);
    expect(input.layer_overrides.map((o) => o.subject_id)).toEqual(["files"]);
    // The role's own channel override is skipped.
    expect(inheritedOverrideValue(input, A)).toEqual({ allowed: true, source: "role" });
  });

  it("a member subject gets their roles: base and the role overrides of the edited layer", () => {
    const withRoles = overrideHintInput(room, { type: "category", id: "team" }, { type: "member", id: "u1", roles: ["mod", "files"] });
    // @everyone hides the category, the member's role Moderator shows it again.
    expect(inheritedOverrideValue(withRoles, V)).toEqual({ allowed: true, source: "roles" });
    expect(inheritedOverrideValue(withRoles, A)).toEqual({ allowed: true, source: "role" });
    // The member's own override is the edited one and is skipped.
    expect(inheritedOverrideValue(withRoles, S)).toEqual({ allowed: true, source: "role" });
    // Until the member's roles are loaded the hint shows @everyone's view.
    const loading = overrideHintInput(room, { type: "category", id: "team" }, { type: "member", id: "u1", roles: [] });
    expect(inheritedOverrideValue(loading, V)).toEqual({ allowed: false, source: "everyone" });
    expect(inheritedOverrideValue(loading, A)).toEqual({ allowed: false, source: "role" });
  });
});
