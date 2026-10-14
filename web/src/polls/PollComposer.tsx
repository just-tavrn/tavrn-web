// SPDX-License-Identifier: Apache-2.0
/**
 * The poll composer (PROTOCOL.md §7g): a choice poll (2–20 options, single or multiple choice) or a date poll (days of
 * a calendar, each all day or with time slots in the creator's zone), the visibility of results and votes and an
 * optional close time. Opened by `/poll` and the composer's ＋ menu.
 */
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { intlLocale, useLocale, useT } from "../i18n";
import { Dialog, ErrorText } from "../components/ui";
import { Calendar, todayLocal } from "./Calendar";
import { POLL_LIMITS, buildPoll, draftKey, emptyDraft, hasErrors, nextTime, slotCount, validateDraft, type CloseChoice, type DraftErrors, type PollContent, type PollDraft, type PollKind, type ResultsVisible, type VotesVisible } from "./model";
import { offsetMinutes, offsetText, zoneName } from "./time";

const input = "min-h-11 w-full rounded-md border border-line-strong bg-bg-0 px-3 text-sm text-fg-0 outline-none placeholder:text-fg-2 focus:border-accent";
const select = "min-h-11 w-full rounded-md border border-line-strong bg-bg-0 px-2 text-sm text-fg-0 outline-none focus:border-accent";
const iconButton = "flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-30";

export interface PollComposerProps {
  open: boolean;
  kind?: PollKind;
  /** The question typed after `/poll`. */
  question?: string;
  onClose: () => void;
  /** Sends the poll; rejects with an error that was shown already (the dialog stays open). */
  onCreate: (content: PollContent, closesAt: string | null) => Promise<void>;
  /** Tests: a fixed clock. */
  now?: () => number;
}

export function PollComposer({ open, kind = "choice", question = "", onClose, onCreate, now = Date.now }: PollComposerProps) {
  const t = useT();
  if (!open) return null;
  return (
    <Dialog title={t("polls.composer.title")} open onClose={onClose}>
      <ComposerForm initialKind={kind} question={question} onClose={onClose} onCreate={onCreate} now={now} />
    </Dialog>
  );
}

function ComposerForm({ initialKind, question, onClose, onCreate, now }: { initialKind: PollKind; question: string; onClose: () => void; onCreate: PollComposerProps["onCreate"]; now: () => number }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const intl = intlLocale();
  const id = useId();
  const [draft, setDraft] = useState<PollDraft>(() => ({ ...emptyDraft(initialKind), question }));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const errors = useMemo(() => validateDraft(draft, now()), [draft, now]);
  const shown: DraftErrors = showErrors ? errors : {};
  const set = (patch: Partial<PollDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const today = todayLocal(now());
  const zone = `${zoneName(now(), intl)} (UTC${offsetText(offsetMinutes(now()))})`;

  const submit = async () => {
    setShowErrors(true);
    if (hasErrors(errors) || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const { content, closesAt } = buildPoll(draft, now());
      await onCreate(content, closesAt);
      onClose();
    } catch (e) {
      setFailed(e instanceof Error && e.message ? e.message : t("polls.error.send_failed"));
    } finally {
      setBusy(false);
    }
  };

  const errorText = (key: string | undefined) => (key ? t(key, { max: key.includes("question") ? POLL_LIMITS.question : key.includes("option") ? POLL_LIMITS.label : POLL_LIMITS.maxSlots }) : null);
  const summary = showErrors && hasErrors(errors) ? t("polls.error.summary") : null;

  return (
    <form
      className="space-y-4"
      data-testid="poll-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend className="mb-1 text-sm text-fg-1">{t("polls.composer.kind")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["choice", "date"] as const).map((k) => (
            <label key={k} className={`flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border px-2 text-sm ${draft.kind === k ? "border-accent bg-accent-soft font-medium text-fg-0" : "border-line-strong text-fg-1 hover:bg-bg-3"}`}>
              <input type="radio" name={`${id}-kind`} value={k} checked={draft.kind === k} onChange={() => set({ kind: k })} className="h-5 w-5 accent-accent" />
              <span aria-hidden="true">{k === "choice" ? "📊" : "📅"}</span>
              {t(k === "choice" ? "polls.kind.choice" : "polls.kind.date")}
            </label>
          ))}
        </div>
      </fieldset>

      <Labeled label={t("polls.composer.question")} htmlFor={`${id}-q`} error={errorText(shown.question)} errorId={`${id}-q-err`}>
        <textarea
          id={`${id}-q`}
          rows={2}
          value={draft.question}
          maxLength={POLL_LIMITS.question * 2}
          onChange={(e) => set({ question: e.target.value })}
          placeholder={t(draft.kind === "choice" ? "polls.composer.question_placeholder" : "polls.composer.question_placeholder_date")}
          aria-invalid={!!shown.question || undefined}
          aria-describedby={shown.question ? `${id}-q-err` : undefined}
          className={`${input} py-2`}
          data-testid="poll-question"
        />
      </Labeled>

      {draft.kind === "choice" ? <ChoiceOptions draft={draft} set={set} errors={shown} errorText={errorText} /> : <DateSlots draft={draft} setDraft={setDraft} errors={shown} today={today} locale={intl} zone={zone} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label={t("polls.composer.results")} htmlFor={`${id}-results`}>
          <select id={`${id}-results`} value={draft.resultsVisible} onChange={(e) => set({ resultsVisible: e.target.value as ResultsVisible })} className={select} data-testid="poll-results-visible">
            <option value="always">{t("polls.results.always")}</option>
            <option value="after_vote">{t("polls.results.after_vote")}</option>
            <option value="after_close">{t("polls.results.after_close")}</option>
          </select>
        </Labeled>
        <Labeled label={t("polls.composer.votes")} htmlFor={`${id}-votes`}>
          <select id={`${id}-votes`} value={draft.votesVisible} onChange={(e) => set({ votesVisible: e.target.value as VotesVisible })} className={select} data-testid="poll-votes-visible">
            <option value="public">{t("polls.votes.public")}</option>
            <option value="hidden_until_close">{t("polls.votes.hidden_until_close")}</option>
          </select>
        </Labeled>
      </div>
      {(draft.votesVisible === "hidden_until_close" || draft.resultsVisible !== "always") && <p className="text-xs text-fg-2">{t("polls.composer.cooperative_hint")}</p>}

      <fieldset>
        <legend className="mb-1 text-sm text-fg-1">{t("polls.composer.closes")}</legend>
        <div className="flex flex-wrap gap-2">
          {(["none", "1h", "1d", "1w", "custom"] as CloseChoice[]).map((c) => (
            <label key={c} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${draft.closes === c ? "border-accent bg-accent-soft text-fg-0" : "border-line-strong text-fg-1 hover:bg-bg-3"}`}>
              <input type="radio" name={`${id}-closes`} value={c} checked={draft.closes === c} onChange={() => set({ closes: c })} className="h-5 w-5 accent-accent" />
              {t(`polls.close.${c}`)}
            </label>
          ))}
        </div>
        {draft.closes === "custom" && (
          <div className="mt-2">
            <label htmlFor={`${id}-close-at`} className="sr-only">
              {t("polls.composer.close_at")}
            </label>
            <input
              id={`${id}-close-at`}
              type="datetime-local"
              value={draft.closesCustom}
              onChange={(e) => set({ closesCustom: e.target.value })}
              aria-invalid={!!shown.closes || undefined}
              aria-describedby={shown.closes ? `${id}-close-err` : undefined}
              className={input}
              data-testid="poll-close-at"
            />
          </div>
        )}
        {shown.closes && (
          <p id={`${id}-close-err`} className="mt-1 text-xs text-danger">
            {t(shown.closes)}
          </p>
        )}
      </fieldset>

      <ErrorText>{failed ?? summary}</ErrorText>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3">
          {t("common.cancel")}
        </button>
        <button type="submit" disabled={busy} className="min-h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-text hover:bg-accent-hover disabled:opacity-50" data-testid="poll-create">
          {busy ? t("polls.composer.sending") : t("polls.composer.create")}
        </button>
      </div>
    </form>
  );
}

function Labeled({ label, htmlFor, error, errorId, children }: { label: string; htmlFor: string; error?: string | null; errorId?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm text-fg-1">
        {label}
      </label>
      {children}
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ChoiceOptions({ draft, set, errors, errorText }: { draft: PollDraft; set: (p: Partial<PollDraft>) => void; errors: DraftErrors; errorText: (k: string | undefined) => string | null }) {
  const t = useT();
  const id = useId();
  const { options } = draft;
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set({ options: next });
    // The moved option keeps the focus (keyboard reordering).
    requestAnimationFrame(() => document.getElementById(`${id}-${next[j]!.key}`)?.focus());
  };
  const add = (after = options.length - 1) => {
    if (options.length >= POLL_LIMITS.maxOptions) return;
    const o = { key: draftKey("o"), label: "" };
    const next = [...options.slice(0, after + 1), o, ...options.slice(after + 1)];
    set({ options: next, maxChoices: Math.min(Math.max(draft.maxChoices, 2), next.length) });
    requestAnimationFrame(() => document.getElementById(`${id}-${o.key}`)?.focus());
  };
  const remove = (i: number) => {
    if (options.length <= POLL_LIMITS.minOptions) return;
    const next = options.filter((_, k) => k !== i);
    set({ options: next, maxChoices: Math.min(draft.maxChoices, next.length) });
    requestAnimationFrame(() => document.getElementById(`${id}-${next[Math.min(i, next.length - 1)]!.key}`)?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      add(i);
    }
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm text-fg-1">{t("polls.composer.options")}</legend>
      <p id={`${id}-hint`} className="text-xs text-fg-2">
        {t("polls.composer.options_hint", { max: POLL_LIMITS.maxOptions })}
      </p>
      <ol className="space-y-2" data-testid="poll-options">
        {options.map((o, i) => {
          const err = errors.option?.[o.key];
          const n = i + 1;
          return (
            <li key={o.key}>
              <div className="flex items-center gap-1">
                <label htmlFor={`${id}-${o.key}`} className="sr-only">
                  {t("polls.composer.option", { n })}
                </label>
                <input
                  id={`${id}-${o.key}`}
                  value={o.label}
                  onChange={(e) => set({ options: options.map((x) => (x.key === o.key ? { ...x, label: e.target.value } : x)) })}
                  onKeyDown={(e) => onKey(e, i)}
                  placeholder={t("polls.composer.option", { n })}
                  aria-invalid={!!err || undefined}
                  aria-describedby={[`${id}-hint`, err ? `${id}-${o.key}-err` : ""].filter(Boolean).join(" ")}
                  className={`${input} flex-1`}
                  data-testid="poll-option"
                />
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t("polls.composer.option_up", { n })} className={iconButton}>
                  <span aria-hidden="true">↑</span>
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === options.length - 1} aria-label={t("polls.composer.option_down", { n })} className={iconButton}>
                  <span aria-hidden="true">↓</span>
                </button>
                <button type="button" onClick={() => remove(i)} disabled={options.length <= POLL_LIMITS.minOptions} aria-label={t("polls.composer.option_remove", { n })} className={iconButton}>
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              {err && (
                <p id={`${id}-${o.key}-err`} className="mt-1 text-xs text-danger">
                  {errorText(err)}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {errors.options && <p className="text-xs text-danger">{t(errors.options, { max: POLL_LIMITS.maxOptions })}</p>}
      <button type="button" onClick={() => add()} disabled={options.length >= POLL_LIMITS.maxOptions} className="min-h-11 rounded-md border border-dashed border-line-strong px-3 text-sm text-fg-1 hover:bg-bg-3 disabled:opacity-40" data-testid="poll-add-option">
        ＋ {t("polls.composer.add_option")}
      </button>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg-1">
          <input type="checkbox" checked={draft.multiple} onChange={(e) => set({ multiple: e.target.checked, maxChoices: e.target.checked ? options.length : draft.maxChoices })} className="h-5 w-5 accent-accent" data-testid="poll-multiple" />
          {t("polls.composer.multiple")}
        </label>
        {draft.multiple && (
          <label className="flex items-center gap-2 text-sm text-fg-1">
            {t("polls.composer.max_choices")}
            <select value={Math.min(draft.maxChoices, options.length)} onChange={(e) => set({ maxChoices: Number(e.target.value) })} className={`${select} w-20`} data-testid="poll-max-choices">
              {Array.from({ length: Math.max(0, options.length - 1) }, (_, k) => k + 2).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </fieldset>
  );
}

function DateSlots({ draft, setDraft, errors, today, locale, zone }: { draft: PollDraft; setDraft: (fn: (d: PollDraft) => PollDraft) => void; errors: DraftErrors; today: string; locale: string; zone: string }) {
  const t = useT();
  const id = useId();
  const selected = useMemo(() => new Set(Object.keys(draft.days)), [draft.days]);
  const days = [...selected].sort();
  const count = slotCount(draft.days);
  const toggle = (day: string) =>
    setDraft((d) => {
      const next = { ...d.days };
      if (next[day]) delete next[day];
      else next[day] = { allDay: true, times: [] };
      return { ...d, days: next };
    });
  const update = (day: string, fn: (x: PollDraft["days"][string]) => PollDraft["days"][string]) => setDraft((d) => (d.days[day] ? { ...d, days: { ...d.days, [day]: fn(d.days[day]!) } } : d));
  const dayName = (day: string) => {
    const [y, m, dd] = day.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "long" }).format(new Date(Date.UTC(y, m - 1, dd)));
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm text-fg-1">{t("polls.composer.days")}</legend>
      <Calendar selected={selected} onToggle={toggle} min={today} locale={locale} label={t("polls.calendar.hint")} />
      <p className="text-xs text-fg-2" data-testid="poll-zone">
        {t("polls.composer.zone", { zone })} · {t("polls.composer.slot_count", { n: count, max: POLL_LIMITS.maxSlots })}
      </p>
      {errors.slots && <p className="text-xs text-danger">{t(errors.slots, { max: POLL_LIMITS.maxSlots })}</p>}
      <ul className="space-y-2" data-testid="poll-days">
        {days.map((day) => {
          const entry = draft.days[day]!;
          const name = dayName(day);
          return (
            <li key={day} className="rounded-md border border-line p-2" data-testid="poll-day" data-day={day}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1 text-sm font-medium text-fg-0">{name}</span>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg-1">
                  <input
                    type="checkbox"
                    checked={entry.allDay}
                    onChange={(e) => update(day, (x) => ({ allDay: e.target.checked, times: e.target.checked ? x.times : x.times.length ? x.times : [nextTime(x)] }))}
                    className="h-5 w-5 accent-accent"
                    data-testid="poll-all-day"
                  />
                  {t("polls.composer.all_day")}
                </label>
                <button type="button" onClick={() => toggle(day)} aria-label={t("polls.composer.day_remove", { day: name })} className={iconButton}>
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              {!entry.allDay && (
                <ul className="mt-1 space-y-1">
                  {entry.times.map((time, k) => {
                    const err = errors.time?.[time.key];
                    return (
                      <li key={time.key}>
                        <div className="flex items-center gap-1">
                          <label className="sr-only" htmlFor={`${id}-${time.key}-s`}>
                            {t("polls.composer.start", { day: name, n: k + 1 })}
                          </label>
                          <input id={`${id}-${time.key}-s`} type="time" value={time.start} onChange={(e) => update(day, (x) => ({ ...x, times: x.times.map((y) => (y.key === time.key ? { ...y, start: e.target.value } : y)) }))} aria-invalid={!!err || undefined} className={`${input} flex-1`} data-testid="poll-time-start" />
                          <span aria-hidden="true" className="text-fg-2">
                            –
                          </span>
                          <label className="sr-only" htmlFor={`${id}-${time.key}-e`}>
                            {t("polls.composer.end", { day: name, n: k + 1 })}
                          </label>
                          <input id={`${id}-${time.key}-e`} type="time" value={time.end} onChange={(e) => update(day, (x) => ({ ...x, times: x.times.map((y) => (y.key === time.key ? { ...y, end: e.target.value } : y)) }))} aria-invalid={!!err || undefined} className={`${input} flex-1`} data-testid="poll-time-end" />
                          <button type="button" onClick={() => update(day, (x) => ({ ...x, times: x.times.filter((y) => y.key !== time.key) }))} aria-label={t("polls.composer.time_remove", { day: name, n: k + 1 })} className={iconButton}>
                            <span aria-hidden="true">×</span>
                          </button>
                        </div>
                        {err && <p className="mt-0.5 text-xs text-danger">{t(err)}</p>}
                      </li>
                    );
                  })}
                  <li>
                    <button type="button" onClick={() => update(day, (x) => ({ ...x, times: [...x.times, nextTime(x)] }))} className="min-h-11 rounded-md px-2 text-sm text-accent hover:bg-accent-soft" data-testid="poll-add-time">
                      ＋ {t("polls.composer.add_time")}
                    </button>
                  </li>
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
