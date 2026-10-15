// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { channelGroup, isFixedChannel, planCategoryMove, planChannelMove, planDrop, type RoomOrder } from "./channelOrder";

const ch = (id: string, category_id: string | null, position: number, kind = "text") => ({ id, kind, position, category_id });

// The welcome channel at -1 without category; "a" holds a1 a2 a3, "b" holds b1, two channels without category.
const room: RoomOrder = {
  categories: [
    { id: "a", position: 0 },
    { id: "b", position: 1 },
    { id: "c", position: 2 },
  ],
  channels: [ch("welcome", null, -1, "system"), ch("a1", "a", 0), ch("a2", "a", 1), ch("a3", "a", 2), ch("b1", "b", 0), ch("n1", null, 0), ch("n2", null, 1)],
};

describe("channelGroup and isFixedChannel", () => {
  it("lists the movable channels of a group by position, then id, without the welcome channel", () => {
    expect(channelGroup(room, null).map((c) => c.id)).toEqual(["n1", "n2"]);
    const tied: RoomOrder = { categories: [], channels: [ch("z", null, 3), ch("y", null, 3), ch("x", null, 1)] };
    expect(channelGroup(tied, null).map((c) => c.id)).toEqual(["x", "y", "z"]);
  });

  it("the system channel and negative positions are fixed", () => {
    expect(isFixedChannel({ kind: "system", position: 4 })).toBe(true);
    expect(isFixedChannel({ kind: "text", position: -1 })).toBe(true);
    expect(isFixedChannel({ kind: "voice", position: 0 })).toBe(false);
  });
});

describe("planChannelMove", () => {
  it("within a group: only the swapped channels are sent, the moved one first", () => {
    expect(planChannelMove(room, "a1", "a", 1)).toEqual({ ok: true, updates: [{ id: "a1", position: 1 }, { id: "a2", position: 0 }] });
    expect(planChannelMove(room, "a3", "a", 0)).toEqual({ ok: true, updates: [{ id: "a3", position: 0 }, { id: "a1", position: 1 }, { id: "a2", position: 2 }] });
  });

  it("to the first and the last place, with clamped indexes", () => {
    expect(planChannelMove(room, "a2", "a", -5)).toEqual({ ok: true, updates: [{ id: "a2", position: 0 }, { id: "a1", position: 1 }] });
    expect(planChannelMove(room, "a1", "a", Number.POSITIVE_INFINITY)).toEqual({ ok: true, updates: [{ id: "a1", position: 2 }, { id: "a2", position: 0 }, { id: "a3", position: 1 }] });
  });

  it("its own place is a no-op, also when the positions have gaps", () => {
    expect(planChannelMove(room, "a2", "a", 1)).toEqual({ ok: true, updates: [] });
    const gaps: RoomOrder = { categories: [], channels: [ch("x", null, 4), ch("y", null, 9)] };
    expect(planChannelMove(gaps, "y", null, 1)).toEqual({ ok: true, updates: [] });
  });

  it("across groups: the moved channel carries its new category, both groups are renumbered minimally", () => {
    expect(planChannelMove(room, "a1", "b", 0)).toEqual({
      ok: true,
      updates: [
        { id: "a1", position: 0, category_id: "b" },
        { id: "b1", position: 1 },
        { id: "a2", position: 0 },
        { id: "a3", position: 1 },
      ],
    });
  });

  it("appending to another group keeps an unchanged position but still sends the category", () => {
    expect(planChannelMove(room, "a3", "b", Number.POSITIVE_INFINITY)).toEqual({ ok: true, updates: [{ id: "a3", position: 1, category_id: "b" }] });
    expect(planChannelMove(room, "b1", "c", 0)).toEqual({ ok: true, updates: [{ id: "b1", position: 0, category_id: "c" }] });
  });

  it("to no category: after the welcome channel, which keeps its position", () => {
    const plan = planChannelMove(room, "a2", null, 0);
    expect(plan).toEqual({
      ok: true,
      updates: [
        { id: "a2", position: 0, category_id: null },
        { id: "n1", position: 1 },
        { id: "n2", position: 2 },
        { id: "a3", position: 1 },
      ],
    });
    expect(plan.ok && plan.updates.some((u) => u.id === "welcome")).toBe(false);
  });

  it("out of no category into a category", () => {
    expect(planChannelMove(room, "n1", "a", 1)).toEqual({
      ok: true,
      updates: [
        { id: "n1", position: 1, category_id: "a" },
        { id: "a2", position: 2 },
        { id: "a3", position: 3 },
        { id: "n2", position: 0 },
      ],
    });
  });

  it("every movable channel of a touched group ends with a distinct position (the node's ORDER BY position, id)", () => {
    const messy: RoomOrder = { categories: [{ id: "a", position: 0 }], channels: [ch("p", "a", 5), ch("q", "a", 5), ch("r", "a", 2), ch("s", null, 5)] };
    const plan = planChannelMove(messy, "s", "a", 1);
    expect(plan.ok).toBe(true);
    const after = new Map(messy.channels.filter((c) => c.category_id === "a").map((c) => [c.id, c.position]));
    after.set("s", 0);
    for (const u of plan.ok ? plan.updates : []) after.set(u.id, u.position);
    expect([...after.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id)).toEqual(["r", "s", "p", "q"]);
    expect(new Set(after.values()).size).toBe(after.size);
  });

  it("the welcome channel, pinned channels and unknown targets are refused", () => {
    expect(planChannelMove(room, "welcome", null, 1)).toEqual({ ok: false, reason: "fixed" });
    expect(planChannelMove({ categories: [], channels: [ch("pin", null, -1)] }, "pin", null, 0)).toEqual({ ok: false, reason: "fixed" });
    expect(planChannelMove(room, "nope", null, 0)).toEqual({ ok: false, reason: "unknown" });
    expect(planChannelMove(room, "a1", "gone", 0)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("planCategoryMove", () => {
  it("moves a category up and down with the minimal updates", () => {
    expect(planCategoryMove(room, "c", 1)).toEqual({ ok: true, updates: [{ id: "c", position: 1 }, { id: "b", position: 2 }] });
    expect(planCategoryMove(room, "a", 2)).toEqual({ ok: true, updates: [{ id: "a", position: 2 }, { id: "b", position: 0 }, { id: "c", position: 1 }] });
  });

  it("its own place is a no-op; unknown categories are refused", () => {
    expect(planCategoryMove(room, "b", 1)).toEqual({ ok: true, updates: [] });
    expect(planCategoryMove(room, "a", -1)).toEqual({ ok: true, updates: [] });
    expect(planCategoryMove(room, "x", 0)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("planDrop", () => {
  it("a channel dropped on a row takes its place: below when dragged down, above when dragged up", () => {
    expect(planDrop(room, { type: "channel", id: "a1" }, { type: "channel", id: "a2" })).toEqual(planChannelMove(room, "a1", "a", 1));
    expect(planDrop(room, { type: "channel", id: "a3" }, { type: "channel", id: "a1" })).toEqual(planChannelMove(room, "a3", "a", 0));
    expect(planDrop(room, { type: "channel", id: "a2" }, { type: "channel", id: "a2" })).toEqual({ ok: true, updates: [] });
  });

  it("a channel dropped on a row of another group goes before it", () => {
    expect(planDrop(room, { type: "channel", id: "a1" }, { type: "channel", id: "b1" })).toEqual(planChannelMove(room, "a1", "b", 0));
  });

  it("a channel dropped on a category header or a group's end goes to the end of that group", () => {
    expect(planDrop(room, { type: "channel", id: "n1" }, { type: "category", id: "b" })).toEqual(planChannelMove(room, "n1", "b", Number.POSITIVE_INFINITY));
    expect(planDrop(room, { type: "channel", id: "a1" }, { type: "group_end", categoryId: null })).toEqual(planChannelMove(room, "a1", null, Number.POSITIVE_INFINITY));
  });

  it("nothing goes onto the welcome channel", () => {
    expect(planDrop(room, { type: "channel", id: "n2" }, { type: "channel", id: "welcome" })).toEqual({ ok: false, reason: "fixed" });
  });

  it("a category takes another category's place but never goes into a category or between channels", () => {
    expect(planDrop(room, { type: "category", id: "a" }, { type: "category", id: "b" })).toEqual(planCategoryMove(room, "a", 1));
    expect(planDrop(room, { type: "category", id: "a" }, { type: "channel", id: "b1" })).toEqual({ ok: false, reason: "invalid_target" });
    expect(planDrop(room, { type: "category", id: "a" }, { type: "group_end", categoryId: "b" })).toEqual({ ok: false, reason: "invalid_target" });
  });
});
