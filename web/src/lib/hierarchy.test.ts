// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { canManageRole, outranks, planRoleReorder, sortRoles, topPosition } from "./hierarchy";

const role = (id: string, position: number, name = id, is_everyone = false) => ({ id, position, name, is_everyone });
const roles = [role("everyone", 0, "@everyone", true), role("admin", 10, "Admin"), role("mod", 5, "Mod"), role("helper", 3, "Helper"), role("member", 1, "Member")];

describe("hierarchy", () => {
  it("takes the highest role position, the owner ranks above all", () => {
    expect(topPosition(roles, ["mod", "helper"])).toBe(5);
    expect(topPosition(roles, [])).toBe(0);
    expect(topPosition(roles, ["everyone"])).toBe(0);
    expect(topPosition(roles, [], true)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("acts only on lower members, never on oneself or the owner", () => {
    expect(outranks({ top: 5, isOwner: false }, { top: 3, isOwner: false }, false)).toBe(true);
    expect(outranks({ top: 5, isOwner: false }, { top: 5, isOwner: false }, false)).toBe(false);
    expect(outranks({ top: 5, isOwner: false }, { top: 0, isOwner: true }, false)).toBe(false);
    expect(outranks({ top: 0, isOwner: true }, { top: 99, isOwner: false }, false)).toBe(true);
    expect(outranks({ top: 0, isOwner: true }, { top: 0, isOwner: true }, true)).toBe(false);
    expect(canManageRole(4, 5)).toBe(true);
    expect(canManageRole(5, 5)).toBe(false);
  });

  it("sorts by position, then name", () => {
    expect(sortRoles([role("b", 1, "B"), role("a", 1, "A"), role("c", 2, "C")]).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("planRoleReorder", () => {
  it("lets the owner move any role and renumbers compactly", () => {
    const r = planRoleReorder(roles, "member", 0, Number.MAX_SAFE_INTEGER);
    expect(r).toMatchObject({ ok: true, order: ["member", "admin", "mod", "helper"] });
    if (!r.ok) throw new Error();
    expect(r.updates).toEqual([
      { id: "member", position: 4 },
      { id: "admin", position: 3 },
      { id: "mod", position: 2 },
      { id: "helper", position: 1 },
    ]);
  });

  it("never moves a role at or above the own highest one, nor anything above it", () => {
    // A moderator (top 5): admin and mod are locked.
    expect(planRoleReorder(roles, "admin", 3, 5)).toEqual({ ok: false, reason: "hierarchy" });
    expect(planRoleReorder(roles, "mod", 3, 5)).toEqual({ ok: false, reason: "hierarchy" });
    expect(planRoleReorder(roles, "member", 1, 5)).toEqual({ ok: false, reason: "hierarchy" });
    const r = planRoleReorder(roles, "member", 2, 5);
    expect(r).toMatchObject({ ok: true, order: ["admin", "mod", "member", "helper"] });
    if (!r.ok) throw new Error();
    // Only changed positions, all below 5.
    expect(r.updates).toEqual([{ id: "member", position: 2 }, { id: "helper", position: 1 }]);
    expect(r.updates.every((u) => u.position < 5)).toBe(true);
  });

  it("reports when the movable roles do not fit below the own role", () => {
    const crowded = [role("me", 2), role("a", 1), role("b", 1), role("c", 1)];
    expect(planRoleReorder(crowded, "c", 1, 2)).toEqual({ ok: false, reason: "no_room" });
  });

  it("returns no updates when nothing changes", () => {
    const r = planRoleReorder([role("a", 2), role("b", 1)], "a", 0, Number.MAX_SAFE_INTEGER);
    expect(r).toMatchObject({ ok: true, updates: [] });
  });
});
