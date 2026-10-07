// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Member } from "@tavrn/sdk";
import { groupMembers, memberColor } from "./memberGroups";

const member = (name: string, roles: string[] = [], nickname: string | null = null): Member =>
  ({ user: { id: name, username: name, domain: "x", address: `${name}@x`, display_name: name, kind: "user", is_node_admin: false, created_at: "" }, joined_at: "", roles, nickname }) as Member;
const role = (id: string, position: number, hoist: boolean, color: string | null = null) => ({ id, name: id.toUpperCase(), position, hoist, color, is_everyone: false });

describe("groupMembers", () => {
  const roles = [role("admin", 10, true, "#f00"), role("mod", 5, true), role("vip", 7, false, "#0f0"), { ...role("everyone", 0, false), is_everyone: true }];
  const online = new Set(["anna@x", "bert@x", "cleo@x", "dora@x", "emil@x"]);

  it("sections by hoisted roles (position order), then online, then offline", () => {
    const sections = groupMembers(
      [member("emil", ["vip"]), member("dora"), member("cleo", ["mod"]), member("bert", ["mod", "admin"]), member("anna", ["mod"]), member("fritz", ["admin"]), member("gina")],
      roles,
      (a) => online.has(a),
    );
    expect(sections.map((s) => [s.id, s.members.map((m) => m.user.username)])).toEqual([
      ["role-admin", ["bert"]],
      ["role-mod", ["anna", "cleo"]],
      ["online", ["dora", "emil"]],
      ["offline", ["fritz", "gina"]],
    ]);
  });

  it("sorts by nickname when there is one and drops empty sections", () => {
    const sections = groupMembers([member("anna", [], "Zora"), member("bert")], roles, () => true);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.members.map((m) => m.user.username)).toEqual(["bert", "anna"]);
  });

  it("colors names by the highest colored role", () => {
    expect(memberColor({ roles: ["vip", "admin"] }, roles)).toBe("#f00");
    expect(memberColor({ roles: ["vip", "mod"] }, roles)).toBe("#0f0");
    expect(memberColor({ roles: [] }, roles)).toBeNull();
  });
});
