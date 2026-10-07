// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Member } from "@tavrn/sdk";
import { localPart, lookOf, memberLooks, sortByRank, stableOrder } from "./order";

const roles = [
  { id: "everyone", name: "@everyone", color: null, position: 0, is_everyone: true },
  { id: "mod", name: "Mod", color: "#e67e22", position: 5, is_everyone: false },
  { id: "raider", name: "Raider", color: "#3498db", position: 2, is_everyone: false },
  { id: "plain", name: "Plain", color: null, position: 8, is_everyone: false },
];
const member = (address: string, display: string, memberRoles: string[], nickname?: string): Member =>
  ({ user: { address, display_name: display, id: address }, roles: memberRoles, nickname: nickname ?? null, joined_at: "", room_avatar_animated: false }) as unknown as Member;

const members = [
  member("zoe@n", "Zoe", ["raider"]),
  member("adam@n", "Adam", []),
  member("bert@n", "Bert", ["mod"], "Admiral"),
  member("carl@n", "Carl", ["plain", "raider"]),
  member("ann@n", "ann", ["mod"]),
];

describe("voice participant order and colours (design note 4.13 item 3)", () => {
  const looks = memberLooks(members, roles);

  it("names: nickname, then display name; colours: highest coloured role", () => {
    expect(lookOf(looks, "bert@n")).toEqual({ name: "Admiral", color: "#e67e22", top: 5 });
    expect(lookOf(looks, "carl@n")).toEqual({ name: "Carl", color: "#3498db", top: 8 });
    expect(lookOf(looks, "adam@n")).toEqual({ name: "Adam", color: null, top: 0 });
    // Not in the member list (not loaded, other node): the local part, no colour, last.
    expect(lookOf(looks, "guest@other.example")).toEqual({ name: "guest", color: null, top: 0 });
    expect(localPart("x@y@z")).toBe("x@y");
  });

  it("sorts by the highest role position, then name (collator: case-insensitive, numeric)", () => {
    const ids = ["zoe@n", "adam@n", "guest@o", "bert@n", "carl@n", "ann@n"];
    const sorted = sortByRank(
      ids,
      (a) => lookOf(looks, a),
      (a) => a,
      "en",
    );
    expect(sorted).toEqual(["carl@n", "bert@n", "ann@n", "zoe@n", "adam@n", "guest@o"]);
    const numeric = sortByRank(
      ["p10", "p9", "P1"],
      (n) => ({ name: n, color: null, top: 0 }),
      (n) => n,
      "en",
    );
    expect(numeric).toEqual(["P1", "p9", "p10"]);
  });

  it("keeps the stage order while the membership stays the same", () => {
    let sorts = 0;
    const sort = () => {
      sorts++;
      return ["b", "a"];
    };
    const first = stableOrder(null, ["a", "b"], sort);
    expect(first).toEqual(["b", "a"]);
    // Speaking or a role change: same identities, same order, no new sort.
    expect(stableOrder(first, ["b", "a"], () => ["a", "b"])).toBe(first);
    expect(sorts).toBe(1);
    // Somebody joined: sorted again.
    expect(stableOrder(first, ["a", "b", "c"], () => ["c", "b", "a"])).toEqual(["c", "b", "a"]);
    expect(stableOrder(first, ["a", "c"], () => ["c", "a"])).toEqual(["c", "a"]);
  });
});
