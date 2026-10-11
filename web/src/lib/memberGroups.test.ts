// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Member } from "@tavrn/sdk";
import { authorLooks, groupMembers, memberColor } from "./memberGroups";

const member = (name: string, roles: string[] = [], nickname: string | null = null): Member =>
  ({ user: { id: name, username: name, domain: "x", address: `${name}@x`, display_name: name, kind: "user", is_node_admin: false, created_at: "" }, joined_at: "", roles, nickname }) as Member;
const role = (id: string, position: number, hoist: boolean, color: string | null = null) => ({ id, name: id.toUpperCase(), position, hoist, color, is_everyone: false });

describe("groupMembers", () => {
  const roles = [role("admin", 10, true, "#ff0000"), role("mod", 5, true), role("vip", 7, false, "#00ff00"), { ...role("everyone", 0, false), is_everyone: true }];
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
    expect(memberColor({ roles: ["vip", "admin"] }, roles)).toBe("#ff0000");
    expect(memberColor({ roles: ["vip", "mod"] }, roles)).toBe("#00ff00");
    expect(memberColor({ roles: [] }, roles)).toBeNull();
  });
});

describe("authorLooks: names of message authors like the member list (design note 4.13 item 3)", () => {
  it("rooms: nickname, then display name, with the role colour", () => {
    const roles = [{ id: "r1", name: "Mod", color: "#ff0000", position: 2, is_everyone: false }];
    const looks = authorLooks({ roomMembers: [{ nickname: "Mimi", roles: ["r1"], user: { address: "mira@t.local", display_name: "Mira Kowalski" } }], roles });
    expect(looks?.get("mira@t.local")).toEqual({ name: "Mimi", color: "#ff0000" });
  });

  it("DMs and group DMs: the members' display names, as in the header and the member list", () => {
    const looks = authorLooks({ people: [{ address: "mira@t.local", display_name: "Mira Kowalski" }, { address: "lena@t.local", display_name: "" }] });
    expect(looks?.get("mira@t.local")).toEqual({ name: "Mira Kowalski", color: null });
    // No display name: no entry, the row falls back to the address's local part.
    expect(looks?.has("lena@t.local")).toBe(false);
  });

  it("names lose bidi controls and colours other than #rrggbb are ignored", () => {
    const roles = [{ id: "r1", name: "Mod", color: "url(https://tracker.example/x)", position: 2, is_everyone: false }];
    const looks = authorLooks({ roomMembers: [{ nickname: "Eve\u202Enimda", roles: ["r1"], user: { address: "eve@t.local", display_name: "Eve" } }], roles });
    expect(looks?.get("eve@t.local")).toEqual({ name: "Evenimda", color: null });
    expect(authorLooks({ people: [{ address: "eve@t.local", display_name: "\u2067Eve" }] })?.get("eve@t.local")?.name).toBe("Eve");
  });

  it("nothing known: no map (the rows show the local part)", () => {
    expect(authorLooks({})).toBeUndefined();
  });
});
