// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { slotText } from "./format";
import { dateGrid, moveInGrid, pollMode } from "./grid";
import type { PollSlot } from "./model";

const texts = (slots: PollSlot[], zone = "Europe/Berlin") => Object.fromEntries(slots.map((s) => [s.id, slotText(s, "de-DE", zone)]));

describe("the date poll's results grid", () => {
  const slots: PollSlot[] = [
    { id: "s1", start: "2026-11-06T19:00:00+01:00", end: "2026-11-06T22:00:00+01:00" },
    { id: "s2", start: "2026-11-06T12:00:00+01:00" },
    { id: "s3", start: "2026-11-07T00:00:00+01:00", all_day: true },
    { id: "s4", start: "2026-11-08T19:00:00+01:00", end: "2026-11-08T22:00:00+01:00" },
    { id: "s5", start: "2026-11-08T12:00:00+01:00" },
  ];

  it("puts days in columns and times in rows (all day first, then by the start in the viewer's zone)", () => {
    const g = dateGrid(slots, texts(slots));
    expect(g.days.map((d) => d.day)).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(g.days[0]!.label).toBe("Fr., 6. Nov.");
    expect(g.rows.map((r) => [r.allDay, r.label])).toEqual([
      [true, ""],
      [false, "12:00"],
      [false, "19:00 – 22:00"],
    ]);
    expect(g.cells).toEqual([
      [null, "s3", null],
      ["s2", null, "s5"],
      ["s1", null, "s4"],
    ]);
  });

  it("follows the viewer's zone (a slot can move to the next day) and never loses a slot of the same time", () => {
    const g = dateGrid(slots, texts(slots, "Asia/Tokyo"));
    // 19:00 in Berlin is 03:00 the next day in Tokyo; the all-day slot keeps its date.
    expect(g.days.map((d) => d.day)).toEqual(["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    expect(g.cells.flat().filter(Boolean).sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    // Two slots of one viewer day with the same time text (a poll of another client): two rows.
    const twin: PollSlot[] = [
      { id: "a", start: "2026-11-06T19:00:00+01:00" },
      { id: "b", start: "2026-11-06T19:00:00+01:00" },
    ];
    const t = dateGrid(twin, texts(twin));
    expect(t.rows).toHaveLength(2);
    expect(t.cells).toEqual([["a"], ["b"]]);
  });

  it("arrow keys move between the slots and skip empty cells, Home and End go to the row's ends", () => {
    const { cells } = dateGrid(slots, texts(slots));
    expect(moveInGrid(cells, [1, 0], "ArrowRight")).toEqual([1, 2]);
    expect(moveInGrid(cells, [1, 2], "ArrowRight")).toEqual([1, 2]);
    expect(moveInGrid(cells, [1, 0], "ArrowDown")).toEqual([2, 0]);
    expect(moveInGrid(cells, [1, 0], "ArrowUp")).toEqual([1, 0]);
    expect(moveInGrid(cells, [0, 1], "ArrowDown")).toEqual([0, 1]);
    expect(moveInGrid(cells, [2, 2], "ArrowLeft")).toEqual([2, 0]);
    expect(moveInGrid(cells, [2, 2], "Home")).toEqual([2, 0]);
    expect(moveInGrid(cells, [1, 0], "End")).toEqual([1, 2]);
    expect(moveInGrid(cells, [1, 0], "Tab")).toBeNull();
  });
});

describe("the poll's view: vote form or results", () => {
  const open = { closed: false, canVote: true };

  it("vote → results → change → form → keep or save → results; retracted → form", () => {
    // Not voted yet: the form.
    expect(pollMode("auto", { ...open, voted: false })).toBe("form");
    // Voted (also right away, the own vote is applied optimistically): the results.
    expect(pollMode("auto", { ...open, voted: true })).toBe("results");
    // "Change vote" opens the form; "Keep" and "Save" return to "auto", the results.
    expect(pollMode("form", { ...open, voted: true })).toBe("form");
    // Retracted: back to the form.
    expect(pollMode("auto", { ...open, voted: false })).toBe("form");
    // Before voting the results can be looked at ("Show results") and left again.
    expect(pollMode("results", { ...open, voted: false })).toBe("results");
  });

  it("closed polls and members who cannot vote see the results only", () => {
    for (const mode of ["auto", "form", "results"] as const) {
      expect(pollMode(mode, { closed: true, canVote: true, voted: true })).toBe("results");
      expect(pollMode(mode, { closed: true, canVote: true, voted: false })).toBe("results");
      expect(pollMode(mode, { closed: false, canVote: false, voted: false })).toBe("results");
    }
  });
});
