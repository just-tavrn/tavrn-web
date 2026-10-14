// SPDX-License-Identifier: Apache-2.0
/**
 * A month calendar for date polls: several days can be selected. A grid (WAI-ARIA date grid pattern) with one tab stop:
 * arrow keys move by day and week, Home/End to the start and end of the week, Page Up/Down by month (with Shift by
 * year), Enter or Space selects or deselects the focused day. Days before `min` cannot be selected.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../i18n";
import { addDays, addMonths, firstDayOfWeek, weekday } from "./time";

const pad = (n: number) => String(n).padStart(2, "0");
const monthOf = (day: string) => day.slice(0, 7);

/** The weeks shown for the month of `day`: rows of seven `YYYY-MM-DD` or null (days of other months). */
export function monthGrid(day: string, firstDay: number): (string | null)[][] {
  const first = `${monthOf(day)}-01`;
  const lead = (weekday(first) - firstDay + 7) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; monthOf(d) === monthOf(day); d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export function Calendar({ selected, onToggle, min, locale, label }: { selected: ReadonlySet<string>; onToggle: (day: string) => void; min: string; locale: string; label: string }) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const [focus, setFocus] = useState(() => [...selected].sort()[0] ?? min);
  const grid = useRef<HTMLTableElement>(null);
  const moved = useRef(false);
  const firstDay = useMemo(() => firstDayOfWeek(locale), [locale]);
  const rows = useMemo(() => monthGrid(focus, firstDay), [focus, firstDay]);
  const [y, m] = focus.split("-").map(Number) as [number, number];
  const monthTitle = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 1)));
  const dayLabel = (day: string) => {
    const [yy, mm, dd] = day.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(Date.UTC(yy, mm - 1, dd)));
  };
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    // 2024-01-01 was a Monday.
    const d = new Date(Date.UTC(2024, 0, ((firstDay - 1 + i) % 7) + 1));
    return { short: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(d), long: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" }).format(d) };
  });
  const clamp = (day: string) => (day < min ? min : day);
  const move = (day: string) => {
    moved.current = true;
    setFocus(clamp(day));
  };
  // Keyboard moves keep the focus on the grid's current day (also across months).
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      Home: () => addDays(focus, -((weekday(focus) - firstDay + 7) % 7)),
      End: () => addDays(focus, 6 - ((weekday(focus) - firstDay + 7) % 7)),
      PageUp: () => addMonths(focus, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, e.shiftKey ? 12 : 1),
    };
    if (keys[e.key]) {
      e.preventDefault();
      move(keys[e.key]!());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (focus >= min) onToggle(focus);
    }
  };
  const atFirstMonth = monthOf(focus) <= monthOf(min);

  return (
    <div className="rounded-lg border border-line bg-bg-0 p-2" data-testid="poll-calendar">
      <div className="mb-1 flex items-center justify-between gap-2">
        <button type="button" onClick={() => setFocus(clamp(addMonths(focus, -1)))} disabled={atFirstMonth} aria-label={t("polls.calendar.previous")} className="flex h-11 w-11 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3 disabled:opacity-40">
          <span aria-hidden="true">‹</span>
        </button>
        <h3 id={titleId} className="text-sm font-semibold text-fg-0" aria-live="polite">
          {monthTitle}
        </h3>
        <button type="button" onClick={() => setFocus(addMonths(focus, 1))} aria-label={t("polls.calendar.next")} className="flex h-11 w-11 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3">
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <table ref={grid} role="grid" aria-labelledby={titleId} aria-multiselectable="true" aria-describedby={hintId} className="w-full table-fixed border-collapse text-center text-sm" onKeyDown={onKey}>
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th key={w.long} scope="col" abbr={w.long} className="pb-1 text-xs font-medium text-fg-2">
                {w.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((day, j) =>
                day ? (
                  <td
                    key={day}
                    role="gridcell"
                    data-day={day}
                    tabIndex={day === focus ? 0 : -1}
                    aria-selected={selected.has(day)}
                    aria-disabled={day < min || undefined}
                    aria-current={day === min ? "date" : undefined}
                    aria-label={dayLabel(day)}
                    onClick={() => {
                      setFocus(day);
                      if (day >= min) onToggle(day);
                    }}
                    className={`relative h-11 cursor-pointer select-none rounded-md p-0 align-middle ${day < min ? "cursor-not-allowed text-fg-2 opacity-60" : selected.has(day) ? "bg-accent font-semibold text-accent-text" : "text-fg-0 hover:bg-bg-3"} ${day === min ? "underline decoration-2 underline-offset-4" : ""}`}
                    data-testid="calendar-day"
                  >
                    {Number(day.slice(8))}
                    {selected.has(day) && (
                      <span aria-hidden="true" className="absolute right-0.5 top-0 text-[10px] leading-none">
                        ✓
                      </span>
                    )}
                  </td>
                ) : (
                  <td key={`e${i}-${j}`} role="gridcell" aria-hidden="true" />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p id={hintId} className="sr-only">
        {label}
      </p>
    </div>
  );
}

/** `YYYY-MM-DD` of today in the device's zone. */
export function todayLocal(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
