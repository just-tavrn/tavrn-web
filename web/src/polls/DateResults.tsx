// SPDX-License-Identifier: Apache-2.0
/**
 * The results of a date poll, compact for many slots: the best slots summarised on top, then a grid with the days as
 * columns and the times as rows. Every slot is one cell with its yes / maybe counts (icon and number, never colour
 * alone), a totals bar (yes, maybe, no of all voters), ★ for the best and the viewer's own answer as a badge. The
 * grid is one tab stop (arrow keys, Home, End); Enter, Space or a click on a cell opens the answers of that slot (the
 * names with public votes; on hover the cell's title lists them too). Phones scroll the grid sideways with the times
 * sticky. "Show all answers" adds the table of members × slots.
 */
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { DatePoll, PollAnswer as Answer, PollTally } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { ANSWER_BAR, ANSWER_CLASS, ANSWER_ICON, ANSWER_TEXT, ANSWERS } from "./answers";
import { usePollEnv } from "./context";
import type { SlotText } from "./format";
import { dateGrid, moveInGrid } from "./grid";

/** How many best slots the summary lists before "and n more". */
const BEST_SHOWN = 3;

interface Props {
  poll: DatePoll;
  tally: PollTally | null;
  mine: Record<string, Answer>;
  show: { results: boolean; voters: boolean };
  texts: Record<string, SlotText>;
  /** `Fri, Nov 6, 19:00 – 22:00` */
  label: (slotId: string) => string;
  /** The action row; gets the "Show all answers" toggle to place in it. */
  children: (gridToggle: ReactNode) => ReactNode;
}

export function DateResults({ poll, tally, mine, show, texts, label, children }: Props) {
  const t = useT();
  const env = usePollEnv();
  const id = useId();
  const grid = useMemo(() => dateGrid(poll.slots, texts), [poll.slots, texts]);
  const slots = useMemo(() => new Map((tally?.slots ?? []).map((s) => [s.id, s])), [tally]);
  const total = tally?.voters ?? 0;
  const best = show.results ? (tally?.best ?? []) : [];
  const name = (u: string) => env?.name(u) ?? u.split("@")[0] ?? u;
  const [open, setOpen] = useState<string | null>(null);
  const [members, setMembers] = useState(false);
  // The roving tab stop: the first best slot, else the first slot.
  const firstBest = best[0];
  const start = useMemo((): [number, number] => {
    const cells = grid.cells.flatMap((row, r) => row.map((slot, c) => ({ slot, at: [r, c] as [number, number] })));
    return (cells.find((x) => x.slot && x.slot === firstBest) ?? cells.find((x) => x.slot))?.at ?? [0, 0];
  }, [grid, firstBest]);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const at = focus && grid.cells[focus[0]]?.[focus[1]] ? focus : start;
  const table = useRef<HTMLTableElement>(null);
  const voters = useMemo(() => {
    const set = new Set<string>();
    for (const s of tally?.slots ?? []) for (const a of ANSWERS) for (const u of s.voters[a]) set.add(u);
    return [...set];
  }, [tally]);

  const onKey = (e: React.KeyboardEvent) => {
    const next = moveInGrid(grid.cells, at, e.key);
    if (!next) return;
    e.preventDefault();
    setFocus(next);
    table.current?.querySelector<HTMLButtonElement>(`[data-pos="${next[0]}-${next[1]}"]`)?.focus();
  };

  const counts = (slotId: string) => {
    const s = slots.get(slotId);
    return { yes: s?.yes ?? 0, maybe: s?.maybe ?? 0, no: s?.no ?? 0 };
  };
  const detail = open ? slots.get(open) : null;
  const detailId = `${id}-detail`;
  const hintId = `${id}-hint`;

  return (
    <div>
      {best.length > 0 && (
        <div className="mb-2 rounded-md border border-accent bg-accent-soft px-2 py-1.5 text-sm text-fg-0" data-testid="poll-best">
          <p className="font-semibold">
            <span aria-hidden="true">★ </span>
            {t(best.length === 1 ? "polls.best_title_one" : "polls.best_title_many")}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {best.slice(0, BEST_SHOWN).map((s) => {
              const c = counts(s);
              return (
                <li key={s} className="flex flex-wrap items-baseline gap-x-2" data-testid="poll-best-slot">
                  <span>{label(s)}</span>
                  <span className="text-xs tabular-nums text-fg-1">{t("polls.cell_counts", c)}</span>
                </li>
              );
            })}
          </ul>
          {best.length > BEST_SHOWN && <p className="mt-0.5 text-xs text-fg-1">{t("polls.best_more", { n: best.length - BEST_SHOWN })}</p>}
        </div>
      )}
      <p id={hintId} className="sr-only">
        {t("polls.grid_hint")}
      </p>
      <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1" data-testid="poll-results">
        <table ref={table} role="grid" aria-label={t("polls.results_grid", { question: poll.question })} aria-describedby={hintId} className="border-separate border-spacing-1 text-xs" onKeyDown={onKey}>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-bg-1 p-1 text-left font-medium text-fg-2">
                <span className="sr-only">{t("polls.grid_time")}</span>
              </th>
              {grid.days.map((d) => (
                <th key={d.day} scope="col" className="whitespace-nowrap px-1 pb-0.5 text-center font-semibold text-fg-1">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={row.key}>
                <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-bg-1 pr-1 text-left font-medium tabular-nums text-fg-1">
                  {row.allDay ? t("polls.all_day") : row.label}
                </th>
                {grid.days.map((d, c) => {
                  const slotId = grid.cells[r]![c];
                  if (!slotId)
                    return (
                      <td key={d.day} className="text-center text-fg-2">
                        <span aria-hidden="true">·</span>
                      </td>
                    );
                  const n = counts(slotId);
                  const isBest = best.includes(slotId);
                  const own = mine[slotId];
                  const s = slots.get(slotId);
                  const names = show.voters && s ? ANSWERS.filter((a) => s.voters[a].length).map((a) => `${ANSWER_ICON[a]} ${s.voters[a].map(name).join(", ")}`).join(" · ") : undefined;
                  const spoken = [label(slotId), show.results ? t("polls.cell_counts", n) : null, isBest ? t("polls.cell_best") : null, own ? t("polls.cell_mine", { answer: t(`polls.answer.${own}`) }) : null].filter(Boolean).join(". ");
                  const focused = at[0] === r && at[1] === c;
                  return (
                    <td key={d.day} className="p-0">
                      <button
                        type="button"
                        tabIndex={focused ? 0 : -1}
                        data-pos={`${r}-${c}`}
                        aria-expanded={open === slotId}
                        aria-controls={detailId}
                        title={names}
                        onClick={() => {
                          setFocus([r, c]);
                          setOpen(open === slotId ? null : slotId);
                        }}
                        className={`flex h-12 w-full min-w-[5rem] flex-col justify-between gap-1 rounded-md border px-1.5 py-1 text-left hover:bg-bg-3 aria-expanded:bg-bg-3 ${isBest ? "border-accent bg-accent-soft" : "border-line"} ${open === slotId ? "ring-1 ring-accent" : ""}`}
                        data-testid="poll-cell"
                        data-slot={slotId}
                        data-best={isBest || undefined}
                        data-mine={own}
                      >
                        <span aria-hidden="true" className="flex w-full items-center gap-1 tabular-nums text-fg-0">
                          {isBest && <span className="text-accent">★</span>}
                          {show.results && (
                            <>
                              <span>
                                <span className={ANSWER_TEXT.yes}>✓</span>
                                {n.yes}
                              </span>
                              <span>
                                <span className={ANSWER_TEXT.maybe}>?</span>
                                {n.maybe}
                              </span>
                            </>
                          )}
                          {own && <span className={`ml-auto inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-bold ring-1 ring-fg-0 ${ANSWER_CLASS[own]}`}>{ANSWER_ICON[own]}</span>}
                        </span>
                        {show.results && (
                          <span aria-hidden="true" className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-3" data-testid="poll-cell-bar">
                            {total > 0 && ANSWERS.map((a) => <span key={a} className={ANSWER_BAR[a]} style={{ width: `${(n[a] / total) * 100}%` }} />)}
                          </span>
                        )}
                        <span className="sr-only">{spoken}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p aria-hidden="true" className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-2" data-testid="poll-legend">
        {ANSWERS.map((a) => (
          <span key={a}>
            <span className={ANSWER_TEXT[a]}>{ANSWER_ICON[a]}</span> {t(`polls.answer.${a}`)}
          </span>
        ))}
        <span>
          <span className="inline-block h-3 w-3 rounded-full border border-fg-1 align-[-2px] ring-1 ring-fg-0" /> {t("polls.legend_mine")}
        </span>
        {show.results && (
          <span>
            <span className="text-accent">★</span> {t("polls.best")}
          </span>
        )}
      </p>
      <div id={detailId} aria-live="polite">
        {open && (
          <div className="mt-2 rounded-md border border-line bg-bg-2 p-2 text-sm" data-testid="poll-slot-detail">
            <p className="font-medium text-fg-0">
              {label(open)}
              {best.includes(open) && <span className="ml-1 text-xs font-semibold text-accent">★ {t("polls.best")}</span>}
            </p>
            {texts[open]?.creator && (
              <p className="text-xs text-fg-2" title={t("polls.creator_time_hint")}>
                {t("polls.creator_time", { time: texts[open]!.creator! })}
              </p>
            )}
            {show.results && (
              <ul className="mt-1 space-y-0.5 text-xs text-fg-1">
                {ANSWERS.map((a) => (
                  <li key={a} className="flex gap-1.5" data-testid={`poll-detail-${a}`}>
                    <span aria-hidden="true" className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${ANSWER_CLASS[a]}`}>
                      {ANSWER_ICON[a]}
                    </span>
                    <span className="min-w-0 break-words">
                      <span className="font-medium text-fg-0">
                        {t(`polls.answer.${a}`)} ({detail?.[a] ?? 0})
                      </span>
                      {show.voters && !!detail?.voters[a].length && `: ${detail.voters[a].map(name).join(", ")}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {mine[open] && <p className="mt-1 text-xs text-fg-1">{t("polls.mine_answer", { answer: t(`polls.answer.${mine[open]!}`) })}</p>}
          </div>
        )}
      </div>
      {children(
        show.voters && voters.length > 0 ? (
          <button type="button" aria-expanded={members} onClick={() => setMembers((v) => !v)} className="min-h-11 rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3 hover:text-fg-0" data-testid="poll-grid-toggle">
            {t(members ? "polls.grid_hide" : "polls.grid_show")}
          </button>
        ) : null,
      )}
      {members && show.voters && (
        <div className="mt-2 max-w-full overflow-x-auto" data-testid="poll-grid">
          <table className="border-collapse text-xs">
            <caption className="sr-only">{t("polls.grid_caption", { question: poll.question })}</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-bg-1 p-1 text-left font-medium text-fg-2">
                  {t("polls.grid_member")}
                </th>
                {poll.slots.map((s) => (
                  <th key={s.id} scope="col" className="min-w-16 p-1 text-center font-medium text-fg-1">
                    {texts[s.id]!.date}
                    <br />
                    {texts[s.id]!.allDay ? t("polls.all_day") : texts[s.id]!.time}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {voters.map((u) => (
                <tr key={u} className="border-t border-line">
                  <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-bg-1 p-1 text-left font-medium text-fg-0">
                    {name(u)}
                  </th>
                  {poll.slots.map((s) => {
                    const v = slots.get(s.id)?.voters;
                    const ans = ANSWERS.find((a) => v?.[a].includes(u)) ?? null;
                    return (
                      <td key={s.id} className="p-1 text-center">
                        {ans ? (
                          <span className={`inline-flex h-7 w-7 items-center justify-center rounded border ${ANSWER_CLASS[ans]}`}>
                            <span aria-hidden="true">{ANSWER_ICON[ans]}</span>
                            <span className="sr-only">{t(`polls.answer.${ans}`)}</span>
                          </span>
                        ) : (
                          <span className="text-fg-2">
                            <span aria-hidden="true">–</span>
                            <span className="sr-only">{t("polls.answer.none")}</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
