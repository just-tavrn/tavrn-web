// SPDX-License-Identifier: Apache-2.0
/**
 * A poll in the message list (PROTOCOL.md §7g). Choice polls: the options as radio buttons or checkboxes, results
 * bars with counts, percentages and (public votes) the voters. Date polls: per slot the viewer's yes / maybe / no and
 * the counts, the best slots on top and the full grid of answers on demand. Results and voters follow the poll's
 * cooperative flags; closed polls take no votes; the author or a moderator can close a poll early.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { Message } from "@tavrn/sdk";
import { pollVisibility, tallyPoll, type ChoicePoll, type DatePoll, type Poll, type PollAnswer as Answer, type PollTally } from "@tavrn/e2ee";
import { intlLocale, useLocale, useT } from "../i18n";
import { toastError } from "../stores/toasts";
import { usePollEnv } from "./context";
import { closeText, relativeUntil, slotText } from "./format";
import { usePollActions, usePollVotes } from "./votes";

/** Is the poll closed at `now`? */
export const isClosed = (closesAt: string | null | undefined, now: number) => !!closesAt && Date.parse(closesAt) <= now;

const ANSWER_ICON: Record<Answer, string> = { yes: "✓", maybe: "?", no: "✗" };
const ANSWER_CLASS: Record<Answer, string> = {
  yes: "border-ok bg-ok/15 text-fg-0",
  maybe: "border-warn bg-warn/15 text-fg-0",
  no: "border-danger bg-danger/10 text-fg-0",
};

/** Re-renders when a close time passes (once a minute while open). */
function useNow(closesAt: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!closesAt) return;
    const at = Date.parse(closesAt);
    const left = at - Date.now();
    // Closed meanwhile (closed early just now, or the tab slept): the stored clock is behind.
    if (left <= 0) {
      if (at > now) setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(left + 50, 60_000));
    return () => clearTimeout(timer);
  }, [closesAt, now]);
  return now;
}

export function PollView({ poll, raw, m, own, canManage }: { poll: Poll; raw: Record<string, unknown>; m: Message; own: boolean; canManage: boolean }) {
  const t = useT();
  useLocale((s) => s.locale);
  const env = usePollEnv();
  const closesAt = m.poll_closes_at ?? null;
  const now = useNow(closesAt);
  const closed = isClosed(closesAt, now);
  const { checked, error } = usePollVotes(m, raw, poll);
  const actions = usePollActions(m, raw, poll);
  const tally = useMemo(() => (checked ? tallyPoll(poll, checked, { closesAt, now: new Date(now) }) : null), [checked, poll, closesAt, now]);
  const me = env?.me;
  const mine = me ? (tally?.byUser.get(me) ?? null) : null;
  // The viewer's newest record was cast on another version of the poll (an edited poll).
  const mineStale = !mine && !!me && !!checked?.some((c) => c.user === me && !c.check.ok && c.check.reason === "stale");
  const show = pollVisibility(poll, { closed }, !!mine);
  const canVote = !!env?.canVote && !!env.me && !closed;
  // Only a poll with a close time can be closed early (the node moves it earlier, never from none, §7g).
  const mayClose = !!env && !!closesAt && !closed && (own || canManage || env.canManage);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e, t("polls.error.vote_failed"));
    } finally {
      setBusy(false);
    }
  };
  const locale = intlLocale();
  const headingId = useId();

  return (
    <section className="mt-1 max-w-xl rounded-lg border border-line bg-bg-1 p-3" aria-labelledby={headingId} data-testid="poll" data-kind={poll.kind} data-closed={closed || undefined}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-bg-3 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-1" data-testid="poll-kind">
          <span aria-hidden="true">{poll.kind === "choice" ? "📊 " : "📅 "}</span>
          {t(poll.kind === "choice" ? (poll.max_choices > 1 ? "polls.kind.multiple" : "polls.kind.choice") : "polls.kind.date")}
        </span>
        {closed ? (
          <span className="rounded bg-bg-3 px-1.5 py-0.5 text-[11px] font-semibold text-fg-1" data-testid="poll-closed">
            🔒 {t("polls.closed")}
          </span>
        ) : (
          closesAt && (
            <span className="text-xs text-fg-2" title={closeText(closesAt, locale)} data-testid="poll-closes">
              {t("polls.closes_in", { when: relativeUntil(closesAt, now, locale) ?? "" })}
            </span>
          )
        )}
      </div>
      <h4 id={headingId} className="mb-2 break-words font-semibold text-fg-0" data-testid="poll-question">
        {poll.question}
      </h4>
      {poll.kind === "choice" ? (
        <ChoiceBody poll={poll} tally={tally} mine={mine && "choices" in mine ? mine.choices : null} show={show} canVote={canVote} busy={busy} onVote={(choices) => run(() => actions.vote({ choices }))} onRetract={() => run(actions.retract)} />
      ) : (
        <DateBody poll={poll} tally={tally} mine={mine && "answers" in mine ? mine.answers : null} show={show} canVote={canVote} busy={busy} onVote={(answers) => run(() => actions.vote({ answers }))} onRetract={() => run(actions.retract)} />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
        <span data-testid="poll-voters">{tally ? t(tally.voters === 1 ? "polls.voters_one" : "polls.voters_many", { n: tally.voters }) : error ? t("polls.error.votes_unavailable") : t("polls.loading")}</span>
        {!show.results && tally && <span data-testid="poll-results-hidden">{t(poll.results_visible === "after_vote" ? "polls.results_hidden_vote" : "polls.results_hidden_close")}</span>}
        {show.results && !show.voters && <span data-testid="poll-votes-hidden">{t("polls.votes_hidden")}</span>}
        {!!tally?.stale && (
          <span title={t("polls.stale_hint")} data-testid="poll-stale">
            {t("polls.stale", { n: tally.stale })}
          </span>
        )}
        {!!tally?.rejected && <span data-testid="poll-invalid">{t("polls.invalid", { n: tally.rejected })}</span>}
        {!!tally?.unverified && (
          <span title={t("polls.unverified_hint")} data-testid="poll-unverified">
            {t("polls.unverified", { n: tally.unverified })}
          </span>
        )}
        {!env && <span>{t("polls.read_only")}</span>}
        {mayClose && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t("polls.close_confirm"))) return;
              void run(actions.close);
            }}
            className="ml-auto min-h-11 rounded-md px-2 text-xs font-medium text-fg-1 hover:bg-bg-3 hover:text-fg-0"
            data-testid="poll-close-now"
          >
            {t("polls.close_now")}
          </button>
        )}
      </div>
      {mineStale && (
        <p className="mt-1 text-xs text-warn" data-testid="poll-mine-stale">
          ⚠ {t("polls.mine_stale")}
        </p>
      )}
    </section>
  );
}

interface BodyProps<P, C> {
  poll: P;
  tally: PollTally | null;
  /** The viewer's counted vote. */
  mine: C | null;
  show: { results: boolean; voters: boolean };
  canVote: boolean;
  busy: boolean;
  onVote: (choice: C) => void;
  onRetract: () => void;
}

function VoterNames({ users }: { users: string[] }) {
  const env = usePollEnv();
  const t = useT();
  const [all, setAll] = useState(false);
  if (!users.length) return null;
  const names = users.map((u) => env?.name(u) ?? u.split("@")[0] ?? u);
  const shown = all ? names : names.slice(0, 5);
  return (
    <p className="mt-0.5 text-xs text-fg-2" data-testid="poll-option-voters">
      {shown.join(", ")}
      {names.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="ml-1 min-h-6 underline hover:text-fg-0">
          {t("polls.more_voters", { n: names.length - shown.length })}
        </button>
      )}
    </p>
  );
}

function ChoiceBody({ poll, tally, mine: counted, show, canVote, busy, onVote, onRetract }: BodyProps<ChoicePoll, string[]>) {
  const t = useT();
  const id = useId();
  const mine = useMemo(() => counted ?? [], [counted]);
  const [draft, setDraft] = useState<string[] | null>(null);
  const picked = draft ?? mine;
  const multiple = poll.max_choices > 1;
  const changed = picked.length > 0 && (picked.length !== mine.length || picked.some((x) => !mine.includes(x)));
  const total = tally?.voters ?? 0;
  const toggle = (optionId: string) => {
    if (!multiple) return setDraft([optionId]);
    setDraft(picked.includes(optionId) ? picked.filter((x) => x !== optionId) : picked.length < poll.max_choices ? [...picked, optionId] : picked);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) {
          onVote(picked);
          setDraft(null);
        }
      }}
    >
      <fieldset disabled={!canVote || busy}>
        <legend className="sr-only">{poll.question}</legend>
        {multiple && <p className="mb-1 text-xs text-fg-2">{t("polls.choose_up_to", { n: poll.max_choices })}</p>}
        <ul className="space-y-1.5" data-testid="poll-options">
          {poll.options.map((o) => {
            const option = tally?.options.find((x) => x.id === o.id);
            const count = option?.count ?? 0;
            const pct = total ? Math.round((count / total) * 100) : 0;
            const isMine = mine.includes(o.id);
            const checked = picked.includes(o.id);
            return (
              <li key={o.id} data-testid="poll-option" data-option={o.id} data-mine={isMine || undefined}>
                <label className={`relative flex min-h-11 cursor-pointer items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 ${checked ? "border-accent" : "border-line"} ${canVote ? "hover:bg-bg-3" : "cursor-default"}`}>
                  {show.results && <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-accent-soft transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} data-testid="poll-bar" />}
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={`${id}-choice`}
                    checked={checked}
                    onChange={() => toggle(o.id)}
                    disabled={multiple && !checked && picked.length >= poll.max_choices}
                    className="relative h-5 w-5 shrink-0 accent-accent"
                  />
                  <span className="relative min-w-0 flex-1 break-words text-sm text-fg-0">{o.label}</span>
                  {isMine && (
                    <span className="relative shrink-0 text-xs font-medium text-accent" data-testid="poll-mine">
                      ✓ {t("polls.your_vote")}
                    </span>
                  )}
                  {show.results && (
                    <span className="relative shrink-0 text-xs tabular-nums text-fg-1" data-testid="poll-count">
                      {t("polls.count", { n: count, pct })}
                    </span>
                  )}
                </label>
                {show.voters && <VoterNames users={option?.voters ?? []} />}
              </li>
            );
          })}
        </ul>
      </fieldset>
      {canVote && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="submit" disabled={!changed || busy} className="min-h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-text hover:bg-accent-hover disabled:opacity-50" data-testid="poll-vote">
            {mine.length ? t("polls.change_vote") : t("polls.vote")}
          </button>
          {mine.length > 0 && (
            <button type="button" disabled={busy} onClick={() => { setDraft(null); onRetract(); }} className="min-h-11 rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3" data-testid="poll-retract">
              {t("polls.retract")}
            </button>
          )}
        </div>
      )}
    </form>
  );
}

function DateBody({ poll, tally, mine: counted, show, canVote, busy, onVote, onRetract }: BodyProps<DatePoll, Record<string, Answer>>) {
  const t = useT();
  const locale = intlLocale();
  const env = usePollEnv();
  const id = useId();
  const mine = useMemo(() => counted ?? {}, [counted]);
  const [draft, setDraft] = useState<Record<string, Answer> | null>(null);
  const answers = draft ?? mine;
  const [grid, setGrid] = useState(false);
  const texts = useMemo(() => Object.fromEntries(poll.slots.map((s) => [s.id, slotText(s, locale)])), [poll.slots, locale]);
  const changed = Object.keys(answers).length > 0 && JSON.stringify(Object.entries(answers).sort()) !== JSON.stringify(Object.entries(mine).sort());
  const label = (slotId: string) => {
    const x = texts[slotId]!;
    return x.allDay ? `${x.date}, ${t("polls.all_day")}` : `${x.date}, ${x.time}`;
  };
  const voters = useMemo(() => {
    const set = new Set<string>();
    for (const s of tally?.slots ?? []) for (const a of ["yes", "maybe", "no"] as const) for (const u of s.voters[a]) set.add(u);
    return [...set];
  }, [tally]);
  const answerOf = (user: string, slotId: string): Answer | null => {
    const v = tally?.slots.find((x) => x.id === slotId)?.voters;
    return v?.yes.includes(user) ? "yes" : v?.maybe.includes(user) ? "maybe" : v?.no.includes(user) ? "no" : null;
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) {
          onVote(answers);
          setDraft(null);
        }
      }}
    >
      {show.results && tally && tally.best.length > 0 && (
        <p className="mb-2 rounded-md bg-accent-soft px-2 py-1.5 text-sm text-fg-0" data-testid="poll-best">
          <span aria-hidden="true">★ </span>
          {t(tally.best.length === 1 ? "polls.best_one" : "polls.best_many", { slots: tally.best.map(label).join("; ") })}
        </p>
      )}
      <ul className="space-y-1.5" data-testid="poll-slots">
        {poll.slots.map((s) => {
          const x = texts[s.id]!;
          const a = tally?.slots.find((x) => x.id === s.id);
          const best = show.results && !!tally?.best.includes(s.id);
          return (
            <li key={s.id} className={`rounded-md border px-2 py-1.5 ${best ? "border-accent" : "border-line"}`} data-testid="poll-slot" data-slot={s.id} data-best={best || undefined}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-sm text-fg-0">
                  <span className="font-medium">{x.date}</span> <span className="text-fg-1">{x.allDay ? t("polls.all_day") : x.time}</span>
                  {x.creator && (
                    <span className="ml-1 text-xs text-fg-2" title={t("polls.creator_time_hint")} data-testid="poll-creator-time">
                      ({t("polls.creator_time", { time: x.creator })})
                    </span>
                  )}
                  {best && <span className="ml-1 text-xs font-semibold text-accent">★ {t("polls.best")}</span>}
                </span>
                {show.results && a && (
                  <span className="text-xs tabular-nums text-fg-1" data-testid="poll-slot-count">
                    {t("polls.slot_count", { yes: a.yes, maybe: a.maybe })}
                  </span>
                )}
              </div>
              <fieldset disabled={!canVote || busy} className="mt-1">
                <legend className="sr-only">{t("polls.your_answer", { slot: label(s.id) })}</legend>
                <div className="flex gap-1">
                  {(["yes", "maybe", "no"] as const).map((ans) => {
                    const on = answers[s.id] === ans;
                    return (
                      <label key={ans} className={`flex min-h-11 flex-1 cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent items-center justify-center gap-1 rounded-md border text-sm ${on ? ANSWER_CLASS[ans] + " font-semibold" : "border-line text-fg-1 hover:bg-bg-3"} ${canVote ? "" : "cursor-default opacity-80"}`}>
                        <input type="radio" name={`${id}-${s.id}`} value={ans} checked={on} onChange={() => setDraft({ ...answers, [s.id]: ans })} className="sr-only" data-testid={`poll-answer-${ans}`} />
                        <span aria-hidden="true">{ANSWER_ICON[ans]}</span>
                        {t(`polls.answer.${ans}`)}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        {canVote && (
          <>
            <button type="submit" disabled={!changed || busy} className="min-h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-text hover:bg-accent-hover disabled:opacity-50" data-testid="poll-vote">
              {Object.keys(mine).length ? t("polls.change_vote") : t("polls.vote")}
            </button>
            {Object.keys(mine).length > 0 && (
              <button type="button" disabled={busy} onClick={() => { setDraft(null); onRetract(); }} className="min-h-11 rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3" data-testid="poll-retract">
                {t("polls.retract")}
              </button>
            )}
          </>
        )}
        {show.voters && voters.length > 0 && (
          <button type="button" aria-expanded={grid} onClick={() => setGrid((v) => !v)} className="min-h-11 rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3" data-testid="poll-grid-toggle">
            {t(grid ? "polls.grid_hide" : "polls.grid_show")}
          </button>
        )}
      </div>
      {grid && show.voters && (
        <div className="mt-2 max-w-full overflow-x-auto" data-testid="poll-grid">
          <table className="border-collapse text-xs">
            <caption className="sr-only">{t("polls.grid_caption", { question: poll.question })}</caption>
            <thead>
              <tr>
                <th scope="col" className="p-1 text-left font-medium text-fg-2">
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
                  <th scope="row" className="whitespace-nowrap p-1 text-left font-medium text-fg-0">
                    {env?.name(u) ?? u}
                  </th>
                  {poll.slots.map((s) => {
                    const ans = answerOf(u, s.id);
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
    </form>
  );
}

/** An encrypted poll this member cannot read (from before they joined): the voter count only. */
export function UnreadablePoll({ m }: { m: Message }) {
  const t = useT();
  const { records } = usePollVotes(m, null, null);
  return (
    <p className="mt-1 rounded-md border border-line bg-bg-1 px-3 py-2 text-sm italic text-fg-2" data-testid="poll-before-join">
      <span aria-hidden="true">📊 </span>
      {t("polls.before_join")}
      {records && <> · {t(records.length === 1 ? "polls.voters_one" : "polls.voters_many", { n: records.length })}</>}
    </p>
  );
}
