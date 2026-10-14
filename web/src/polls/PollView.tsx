// SPDX-License-Identifier: Apache-2.0
/**
 * A poll in the message list (PROTOCOL.md §7g). Two views: the vote form and the results. Members see the form until
 * they voted and the results afterwards, with "Change vote" back to the form (prefilled with the own vote; "Keep" or
 * "Save" return to the results, "Retract vote" stays in the form); closed polls and members who cannot vote see the
 * results only. Choice polls: options with bars, counts, shares and (public votes) the voters, the own vote marked.
 * Date polls: the best slots on top and a compact grid of the slots (`DateResults.tsx`). Results and voters follow
 * the poll's cooperative flags; the author or a moderator can close a poll early.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { Message } from "@tavrn/sdk";
import { pollVisibility, tallyPoll, type ChoicePoll, type DatePoll, type Poll, type PollAnswer as Answer, type PollTally } from "@tavrn/e2ee";
import { intlLocale, useLocale, useT } from "../i18n";
import { toastError } from "../stores/toasts";
import { ANSWER_CLASS, ANSWER_ICON, ANSWERS } from "./answers";
import { usePollEnv } from "./context";
import { DateResults } from "./DateResults";
import { closeText, relativeUntil, slotText, type SlotText } from "./format";
import { pollMode, type PollModeRequest } from "./grid";
import { usePollActions, usePollVotes } from "./votes";

/** Is the poll closed at `now`? */
export const isClosed = (closesAt: string | null | undefined, now: number) => !!closesAt && Date.parse(closesAt) <= now;

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
  // The author always sees the results of their own poll ("after voting" applies to the other members).
  const show = pollVisibility(poll, { closed }, !!mine || own);
  const canVote = !!env?.canVote && !!env.me && !closed;
  // The author or a moderator closes an open poll (with or without a close time) at once (§7g).
  const mayClose = !!env && !closed && (own || canManage || env.canManage);
  const [request, setRequest] = useState<PollModeRequest>("auto");
  const mode = pollMode(request, { closed, canVote, voted: !!mine });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      toastError(e, t("polls.error.vote_failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const locale = intlLocale();
  const headingId = useId();
  const body: Omit<BodyProps<never, never>, "poll" | "mine" | "onVote"> = { tally, show, mode, setRequest, canVote, busy, onRetract: () => run(actions.retract) };

  return (
    <section className="mt-1 max-w-xl rounded-lg border border-line bg-bg-1 p-3" aria-labelledby={headingId} data-testid="poll" data-kind={poll.kind} data-closed={closed || undefined} data-view={mode}>
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
        <ChoiceBody {...body} poll={poll} mine={mine && "choices" in mine ? mine.choices : null} onVote={(choices) => run(() => actions.vote({ choices }))} />
      ) : (
        <DateBody {...body} poll={poll} mine={mine && "answers" in mine ? mine.answers : null} onVote={(answers) => run(() => actions.vote({ answers }))} />
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
  mode: "form" | "results";
  setRequest: (r: PollModeRequest) => void;
  canVote: boolean;
  busy: boolean;
  /** Resolves to whether the node took the vote (a refused vote is rolled back and toasted). */
  onVote: (choice: C) => Promise<boolean>;
  onRetract: () => Promise<boolean>;
}

/**
 * The draft of the vote form and its transitions: "Change vote" opens the form prefilled with the own vote, "Keep"
 * and an unchanged "Save" return to the results, a saved vote shows the results at once (the own vote is applied
 * optimistically) and a refused one reopens the form with the draft kept.
 */
function useVoteForm<C>({ mine, setRequest, onVote, onRetract }: Pick<BodyProps<unknown, C>, "mine" | "setRequest" | "onVote" | "onRetract">, changed: (draft: C) => boolean) {
  const [draft, setDraft] = useState<C | null>(null);
  return {
    draft,
    setDraft,
    edit: () => {
      setDraft(null);
      setRequest("form");
    },
    keep: () => {
      setDraft(null);
      setRequest("auto");
    },
    save: async (picked: C) => {
      if (mine && !changed(picked)) {
        setDraft(null);
        setRequest("auto");
        return;
      }
      setRequest("auto");
      if (await onVote(picked)) setDraft(null);
      else setRequest("form");
    },
    retract: () => {
      setDraft(null);
      setRequest("auto");
      void onRetract();
    },
  };
}

/** The buttons under the form or the results. */
function Actions({ mode, canVote, busy, voted, canSave, showResults, onEdit, onKeep, onRetract, onShowResults, children }: { mode: "form" | "results"; canVote: boolean; busy: boolean; voted: boolean; canSave: boolean; showResults: boolean; onEdit: () => void; onKeep: () => void; onRetract: () => void; onShowResults: () => void; children?: React.ReactNode }) {
  const t = useT();
  const primary = "min-h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-text hover:bg-accent-hover disabled:opacity-50";
  const secondary = "min-h-11 rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3 hover:text-fg-0";
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {canVote && mode === "form" && (
        <>
          <button type="submit" disabled={!canSave || busy} className={primary} data-testid="poll-vote">
            {t(voted ? "polls.save" : "polls.vote")}
          </button>
          {voted && (
            <button type="button" disabled={busy} onClick={onKeep} className={secondary} data-testid="poll-keep">
              {t("polls.keep")}
            </button>
          )}
          {voted && (
            <button type="button" disabled={busy} onClick={onRetract} className={secondary} data-testid="poll-retract">
              {t("polls.retract")}
            </button>
          )}
          {!voted && showResults && (
            <button type="button" onClick={onShowResults} className={secondary} data-testid="poll-show-results">
              {t("polls.show_results")}
            </button>
          )}
        </>
      )}
      {canVote && mode === "results" && (
        <button type="button" disabled={busy} onClick={onEdit} className={voted ? "min-h-11 rounded-md border border-line-strong px-3 text-sm font-medium text-fg-0 hover:bg-bg-3" : primary} data-testid="poll-change">
          {t(voted ? "polls.change_vote" : "polls.vote")}
        </button>
      )}
      {children}
    </div>
  );
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

const sameChoices = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function ChoiceBody(props: BodyProps<ChoicePoll, string[]>) {
  const { poll, tally, mine: counted, show, mode, canVote, busy } = props;
  const t = useT();
  const id = useId();
  const mine = useMemo(() => counted ?? [], [counted]);
  const form = useVoteForm(props, (picked) => !sameChoices(picked, mine));
  const picked = form.draft ?? mine;
  const multiple = poll.max_choices > 1;
  const total = tally?.voters ?? 0;
  const toggle = (optionId: string) => {
    if (!multiple) return form.setDraft([optionId]);
    form.setDraft(picked.includes(optionId) ? picked.filter((x) => x !== optionId) : picked.length < poll.max_choices ? [...picked, optionId] : picked);
  };
  const results = mode === "results";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.length) void form.save(picked);
      }}
    >
      {!results && multiple && <p className="mb-1 text-xs text-fg-2">{t("polls.choose_up_to", { n: poll.max_choices })}</p>}
      {results ? (
        <ul className="space-y-1.5" data-testid="poll-options" aria-label={poll.question}>
          {poll.options.map((o) => {
            const option = tally?.options.find((x) => x.id === o.id);
            const count = option?.count ?? 0;
            const pct = total ? Math.round((count / total) * 100) : 0;
            const isMine = mine.includes(o.id);
            return (
              <li key={o.id} data-testid="poll-option" data-option={o.id} data-mine={isMine || undefined}>
                <div className={`relative flex min-h-11 items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 ${isMine ? "border-2 border-accent" : "border border-line"}`}>
                  {show.results && <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-accent-soft transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} data-testid="poll-bar" />}
                  <span aria-hidden="true" className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${isMine ? "bg-accent text-accent-text" : "border border-line-strong"}`}>
                    {isMine ? "✓" : ""}
                  </span>
                  <span className={`relative min-w-0 flex-1 break-words text-sm text-fg-0 ${isMine ? "font-semibold" : ""}`}>{o.label}</span>
                  {isMine && (
                    <span className="relative shrink-0 rounded bg-bg-1 px-1 text-xs font-semibold text-accent" data-testid="poll-mine">
                      {t("polls.your_vote")}
                    </span>
                  )}
                  {show.results && (
                    <span className="relative shrink-0 text-xs tabular-nums text-fg-1" data-testid="poll-count">
                      {t("polls.count", { n: count, pct })}
                    </span>
                  )}
                </div>
                {show.voters && <VoterNames users={option?.voters ?? []} />}
              </li>
            );
          })}
        </ul>
      ) : (
        <fieldset disabled={!canVote || busy}>
          <legend className="sr-only">{poll.question}</legend>
          <ul className="space-y-1.5" data-testid="poll-options">
            {poll.options.map((o) => {
              const option = tally?.options.find((x) => x.id === o.id);
              const count = option?.count ?? 0;
              const pct = total ? Math.round((count / total) * 100) : 0;
              const isMine = mine.includes(o.id);
              const checked = picked.includes(o.id);
              return (
                <li key={o.id} data-testid="poll-option" data-option={o.id} data-mine={isMine || undefined}>
                  <label className={`relative flex min-h-11 cursor-pointer items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 hover:bg-bg-3 ${checked ? "border-accent" : "border-line"}`}>
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
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <Actions mode={mode} canVote={canVote} busy={busy} voted={mine.length > 0} canSave={picked.length > 0} showResults={show.voters && total > 0} onEdit={form.edit} onKeep={form.keep} onRetract={form.retract} onShowResults={() => props.setRequest("results")} />
    </form>
  );
}

const sameAnswers = (a: Record<string, Answer>, b: Record<string, Answer>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** The slots of a date poll grouped by the viewer's day (the order of the poll: by start). */
function byDay(slots: DatePoll["slots"], texts: Record<string, SlotText>): { day: string; label: string; slots: DatePoll["slots"] }[] {
  const out: { day: string; label: string; slots: DatePoll["slots"] }[] = [];
  for (const s of [...slots].sort((a, b) => texts[a.id]!.day.localeCompare(texts[b.id]!.day) || texts[a.id]!.minutes - texts[b.id]!.minutes)) {
    const x = texts[s.id]!;
    const last = out.at(-1);
    if (last?.day === x.day) last.slots.push(s);
    else out.push({ day: x.day, label: x.date, slots: [s] });
  }
  return out;
}

function DateBody(props: BodyProps<DatePoll, Record<string, Answer>>) {
  const { poll, tally, mine: counted, show, mode, canVote, busy } = props;
  const t = useT();
  const locale = intlLocale();
  const id = useId();
  const mine = useMemo(() => counted ?? {}, [counted]);
  const form = useVoteForm(props, (draft) => !sameAnswers(draft, mine));
  const answers = form.draft ?? mine;
  const voted = Object.keys(mine).length > 0;
  const texts = useMemo(() => Object.fromEntries(poll.slots.map((s) => [s.id, slotText(s, locale)])), [poll.slots, locale]);
  const days = useMemo(() => byDay(poll.slots, texts), [poll.slots, texts]);
  const label = (slotId: string) => {
    const x = texts[slotId]!;
    return x.allDay ? `${x.date}, ${t("polls.all_day")}` : `${x.date}, ${x.time}`;
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (Object.keys(answers).length) void form.save(answers);
      }}
    >
      {mode === "results" ? (
        <DateResults poll={poll} tally={tally} mine={mine} show={show} texts={texts} label={label}>
          {(grid) => <Actions mode={mode} canVote={canVote} busy={busy} voted={voted} canSave={false} showResults={false} onEdit={form.edit} onKeep={form.keep} onRetract={form.retract} onShowResults={() => {}}>{grid}</Actions>}
        </DateResults>
      ) : (
        <>
          <div className="space-y-2" data-testid="poll-slots">
            {days.map((d) => (
              <div key={d.day} role="group" aria-label={d.label}>
                <p aria-hidden="true" className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-1">
                  {d.label}
                </p>
                <ul className="space-y-1">
                  {d.slots.map((s) => {
                    const x = texts[s.id]!;
                    return (
                      <li key={s.id} className="rounded-md border border-line px-2 py-1" data-testid="poll-slot" data-slot={s.id}>
                        <fieldset disabled={!canVote || busy} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <legend className="sr-only">{t("polls.your_answer", { slot: label(s.id) })}</legend>
                          <span className="min-w-[6.5rem] flex-1 text-sm text-fg-0">
                            {x.allDay ? t("polls.all_day") : x.time}
                            {x.creator && (
                              <span className="ml-1 text-xs text-fg-2" title={t("polls.creator_time_hint")} data-testid="poll-creator-time">
                                ({t("polls.creator_time", { time: x.creator })})
                              </span>
                            )}
                          </span>
                          <span className="flex w-full gap-1 sm:w-auto">
                            {ANSWERS.map((ans) => {
                              const on = answers[s.id] === ans;
                              return (
                                <label key={ans} className={`flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border px-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent sm:min-w-[5.5rem] sm:flex-none ${on ? ANSWER_CLASS[ans] + " font-semibold" : "border-line text-fg-1 hover:bg-bg-3"}`}>
                                  <input type="radio" name={`${id}-${s.id}`} value={ans} checked={on} onChange={() => form.setDraft({ ...answers, [s.id]: ans })} className="sr-only" data-testid={`poll-answer-${ans}`} />
                                  <span aria-hidden="true">{ANSWER_ICON[ans]}</span>
                                  {t(`polls.answer.${ans}`)}
                                </label>
                              );
                            })}
                          </span>
                        </fieldset>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          <Actions mode={mode} canVote={canVote} busy={busy} voted={voted} canSave={Object.keys(answers).length > 0} showResults={show.results && (tally?.voters ?? 0) > 0} onEdit={form.edit} onKeep={form.keep} onRetract={form.retract} onShowResults={() => props.setRequest("results")} />
        </>
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
