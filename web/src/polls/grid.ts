// SPDX-License-Identifier: Apache-2.0
/**
 * The poll view's state and the date poll's results grid (PROTOCOL.md §7g, docs/CLIENT.md "Polls"): who sees the
 * vote form and who the results, and the compact matrix of a date poll's slots (days in columns, times in rows).
 */
import type { SlotText } from "./format";

// ---- vote form or results

/**
 * What the viewer asked for: `auto` (the default: the results once they voted, the form before), `form` ("Change
 * vote") or `results` ("Show results" before voting).
 */
export type PollModeRequest = "auto" | "form" | "results";

/** The view a poll shows: closed polls and members who cannot vote only ever see the results. */
export function pollMode(request: PollModeRequest, s: { closed: boolean; canVote: boolean; voted: boolean }): "form" | "results" {
  if (s.closed || !s.canVote) return "results";
  if (request === "auto") return s.voted ? "results" : "form";
  return request;
}

// ---- the date poll's results grid

export interface GridDay {
  /** The viewer's `YYYY-MM-DD`. */
  day: string;
  label: string;
}

export interface GridRow {
  key: string;
  /** The time (`19:00 – 22:00`), empty for the all-day row. */
  label: string;
  allDay: boolean;
}

export interface DateGrid {
  days: GridDay[];
  rows: GridRow[];
  /** `cells[row][day]`: the slot id, or null where that day has no slot at that time. */
  cells: (string | null)[][];
}

/**
 * Days as columns, times as rows (all day first, then by the start in the viewer's zone). Two slots of one day with
 * the same time (a poll of another client) get a row each.
 */
export function dateGrid(slots: ReadonlyArray<{ id: string }>, texts: Record<string, SlotText>): DateGrid {
  const days = [...new Set(slots.map((s) => texts[s.id]!.day))].sort();
  const col = new Map(days.map((d, i) => [d, i]));
  const rows = new Map<string, GridRow & { minutes: number; n: number; at: Map<number, string> }>();
  for (const s of slots) {
    const x = texts[s.id]!;
    const base = x.allDay ? "all-day" : `${x.minutes}|${x.time}`;
    const c = col.get(x.day)!;
    for (let n = 1; ; n++) {
      const key = n === 1 ? base : `${base}#${n}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { key, label: x.allDay ? "" : x.time, allDay: x.allDay, minutes: x.minutes, n, at: new Map() }));
      if (row.at.has(c)) continue;
      row.at.set(c, s.id);
      break;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.minutes - b.minutes || a.label.localeCompare(b.label) || a.n - b.n);
  return {
    days: days.map((day) => {
      const id = slots.find((s) => texts[s.id]!.day === day)!.id;
      return { day, label: texts[id]!.date };
    }),
    rows: sorted.map(({ key, label, allDay }) => ({ key, label, allDay })),
    cells: sorted.map((r) => days.map((_, c) => r.at.get(c) ?? null)),
  };
}

/**
 * The cell the focus moves to from `[row, col]` for a key of the grid (arrows, Home, End), skipping cells without
 * a slot; the same cell at an edge; null for other keys.
 */
export function moveInGrid(cells: (string | null)[][], [r, c]: [number, number], key: string): [number, number] | null {
  const width = cells[0]?.length ?? 0;
  const scan = (dr: number, dc: number, from: [number, number]): [number, number] => {
    for (let y = from[0] + dr, x = from[1] + dc; y >= 0 && y < cells.length && x >= 0 && x < width; y += dr, x += dc) {
      if (cells[y]![x]) return [y, x];
    }
    return [r, c];
  };
  switch (key) {
    case "ArrowRight":
      return scan(0, 1, [r, c]);
    case "ArrowLeft":
      return scan(0, -1, [r, c]);
    case "ArrowDown":
      return scan(1, 0, [r, c]);
    case "ArrowUp":
      return scan(-1, 0, [r, c]);
    case "Home":
      return scan(0, 1, [r, -1]);
    case "End":
      return scan(0, -1, [r, width]);
    default:
      return null;
  }
}
