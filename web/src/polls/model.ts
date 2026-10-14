// SPDX-License-Identifier: Apache-2.0
/**
 * Polls and date polls (PROTOCOL.md §7g): the content shape, the composer's draft, its validation and the content it
 * becomes. The poll travels as message content (encrypted like any content in E2EE conversations); the close time is
 * the message's plaintext `poll_closes_at`.
 */
import { dayOf, isRfc3339, parseRfc3339, toRfc3339, zonedInstant } from "./time";

export const POLL_LIMITS = { question: 300, label: 100, minOptions: 2, maxOptions: 20, minSlots: 1, maxSlots: 60, id: 32 } as const;
/** The node accepts close times from a minute to a year ahead. */
export const CLOSE_MIN_MS = 60_000;
export const CLOSE_MAX_MS = 365 * 86_400_000;

export type PollKind = "choice" | "date";
export type ResultsVisible = "always" | "after_vote" | "after_close";
export type VotesVisible = "public" | "hidden_until_close";
export type Answer = "yes" | "maybe" | "no";
export const ANSWERS: readonly Answer[] = ["yes", "maybe", "no"];

export interface PollOption {
  id: string;
  label: string;
}
export interface PollSlot {
  id: string;
  start: string;
  end?: string;
  all_day?: boolean;
}
interface PollCommon {
  type: "poll";
  question: string;
  results_visible: ResultsVisible;
  votes_visible: VotesVisible;
}
export interface ChoicePoll extends PollCommon {
  kind: "choice";
  options: PollOption[];
  max_choices: number;
}
export interface DatePoll extends PollCommon {
  kind: "date";
  slots: PollSlot[];
}
export type PollContent = ChoicePoll | DatePoll;

const RESULTS: readonly ResultsVisible[] = ["always", "after_vote", "after_close"];
const VOTES: readonly VotesVisible[] = ["public", "hidden_until_close"];
const chars = (s: string) => Array.from(s).length;
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v);

/**
 * The poll in a (decrypted or plaintext) content object, or null when it is not a well-formed poll. Only the known
 * fields are kept (a renderer never shows anything else of it).
 */
export function parsePoll(c: unknown): PollContent | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  if (o.type !== "poll" || typeof o.question !== "string") return null;
  const question = o.question.trim();
  if (!question || chars(question) > POLL_LIMITS.question) return null;
  if (!RESULTS.includes(o.results_visible as ResultsVisible) || !VOTES.includes(o.votes_visible as VotesVisible)) return null;
  const common = { type: "poll" as const, question, results_visible: o.results_visible as ResultsVisible, votes_visible: o.votes_visible as VotesVisible };
  if (o.kind === "choice") {
    if (!Array.isArray(o.options) || o.options.length < POLL_LIMITS.minOptions || o.options.length > POLL_LIMITS.maxOptions) return null;
    const options: PollOption[] = [];
    for (const x of o.options as unknown[]) {
      const opt = x as Record<string, unknown> | null;
      if (!opt || !isId(opt.id) || typeof opt.label !== "string" || !opt.label.trim() || chars(opt.label) > POLL_LIMITS.label) return null;
      options.push({ id: opt.id, label: opt.label });
    }
    if (new Set(options.map((x) => x.id)).size !== options.length) return null;
    const max = o.max_choices;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > options.length) return null;
    return { ...common, kind: "choice", options, max_choices: max };
  }
  if (o.kind === "date") {
    if (!Array.isArray(o.slots) || o.slots.length < POLL_LIMITS.minSlots || o.slots.length > POLL_LIMITS.maxSlots) return null;
    const slots: PollSlot[] = [];
    for (const x of o.slots as unknown[]) {
      const s = x as Record<string, unknown> | null;
      if (!s || !isId(s.id) || !isRfc3339(s.start)) return null;
      if (s.end !== undefined && (!isRfc3339(s.end) || Date.parse(s.end) <= Date.parse(s.start))) return null;
      if (s.all_day !== undefined && typeof s.all_day !== "boolean") return null;
      slots.push({ id: s.id, start: s.start, ...(s.end !== undefined ? { end: s.end as string } : {}), ...(s.all_day ? { all_day: true } : {}) });
    }
    if (new Set(slots.map((x) => x.id)).size !== slots.length) return null;
    return { ...common, kind: "date", slots };
  }
  return null;
}

// ---- the composer's draft

export interface DraftOption {
  key: string;
  label: string;
}
export interface DraftTime {
  key: string;
  /** `HH:MM` */
  start: string;
  /** `HH:MM` or empty (no end). */
  end: string;
}
export interface DraftDay {
  allDay: boolean;
  times: DraftTime[];
}
export type CloseChoice = "none" | "1h" | "1d" | "1w" | "custom";

export interface PollDraft {
  kind: PollKind;
  question: string;
  options: DraftOption[];
  multiple: boolean;
  /** Multiple choice: at most this many (≤ the number of options). */
  maxChoices: number;
  resultsVisible: ResultsVisible;
  votesVisible: VotesVisible;
  closes: CloseChoice;
  /** `datetime-local` value (the viewer's zone) for `closes = "custom"`. */
  closesCustom: string;
  /** Date polls: the selected days (`YYYY-MM-DD`) and their slots. */
  days: Record<string, DraftDay>;
}

let seq = 0;
/** A key for list items of the draft (stable across reordering). */
export const draftKey = (prefix: string) => `${prefix}${++seq}`;

export function emptyDraft(kind: PollKind = "choice"): PollDraft {
  return {
    kind,
    question: "",
    options: [
      { key: draftKey("o"), label: "" },
      { key: draftKey("o"), label: "" },
    ],
    multiple: false,
    maxChoices: 2,
    resultsVisible: "always",
    votesVisible: "public",
    closes: "none",
    closesCustom: "",
    days: {},
  };
}

/** A new time slot of a day: the next full hour after the last one (09:00 for the first). */
export function nextTime(day: DraftDay): DraftTime {
  const last = day.times.at(-1)?.start;
  const hour = last ? Math.min(23, Number(last.slice(0, 2)) + 1) : 9;
  return { key: draftKey("t"), start: `${String(hour).padStart(2, "0")}:00`, end: "" };
}

/** Number of slots the draft's days make (all-day days count once, otherwise one per time). */
export function slotCount(days: Record<string, DraftDay>): number {
  return Object.values(days).reduce((n, d) => n + (d.allDay ? 1 : d.times.length), 0);
}

/** Validation result: i18n keys under `polls.error.*` per field. */
export interface DraftErrors {
  question?: string;
  options?: string;
  /** Per option key. */
  option?: Record<string, string>;
  slots?: string;
  /** Per time key. */
  time?: Record<string, string>;
  closes?: string;
}

export const hasErrors = (e: DraftErrors) => Object.values(e).some((v) => v !== undefined && (typeof v === "string" || Object.keys(v).length > 0));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The close time of the draft (ISO, UTC) or null; `undefined` when the custom value is no valid time. */
export function closeTime(d: Pick<PollDraft, "closes" | "closesCustom">, now: number): string | null | undefined {
  switch (d.closes) {
    case "none":
      return null;
    case "1h":
      return new Date(now + 3_600_000).toISOString();
    case "1d":
      return new Date(now + 86_400_000).toISOString();
    case "1w":
      return new Date(now + 7 * 86_400_000).toISOString();
    case "custom": {
      // `datetime-local` is the viewer's wall time.
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(d.closesCustom);
      if (!m) return undefined;
      const ms = zonedInstant(m[1]!, m[2]!);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
    }
  }
}

export function validateDraft(d: PollDraft, now: number, timeZone?: string): DraftErrors {
  const e: DraftErrors = {};
  const q = d.question.trim();
  if (!q) e.question = "polls.error.question_empty";
  else if (chars(q) > POLL_LIMITS.question) e.question = "polls.error.question_long";
  if (d.kind === "choice") {
    const option: Record<string, string> = {};
    const seen = new Map<string, string>();
    for (const o of d.options) {
      const label = o.label.trim();
      if (!label) option[o.key] = "polls.error.option_empty";
      else if (chars(label) > POLL_LIMITS.label) option[o.key] = "polls.error.option_long";
      else if (seen.has(label.toLowerCase())) option[o.key] = "polls.error.option_duplicate";
      else seen.set(label.toLowerCase(), o.key);
    }
    if (Object.keys(option).length) e.option = option;
    if (d.options.length < POLL_LIMITS.minOptions) e.options = "polls.error.options_few";
    else if (d.options.length > POLL_LIMITS.maxOptions) e.options = "polls.error.options_many";
  } else {
    const time: Record<string, string> = {};
    const today = dayOf(now, timeZone);
    for (const [day, entry] of Object.entries(d.days)) {
      if (entry.allDay) continue;
      const starts = new Set<string>();
      for (const t of entry.times) {
        if (!TIME.test(t.start)) time[t.key] = "polls.error.time_invalid";
        else if (t.end && !TIME.test(t.end)) time[t.key] = "polls.error.time_invalid";
        else if (t.end && t.end <= t.start) time[t.key] = "polls.error.time_end_before";
        else if (starts.has(t.start)) time[t.key] = "polls.error.time_duplicate";
        else if (day === today && zonedInstant(day, t.start, timeZone) <= now) time[t.key] = "polls.error.time_past";
        starts.add(t.start);
      }
    }
    if (Object.keys(time).length) e.time = time;
    const n = slotCount(d.days);
    if (Object.keys(d.days).length === 0) e.slots = "polls.error.slots_none";
    else if (Object.values(d.days).some((x) => !x.allDay && x.times.length === 0)) e.slots = "polls.error.day_no_time";
    else if (n > POLL_LIMITS.maxSlots) e.slots = "polls.error.slots_many";
  }
  const closes = closeTime(d, now);
  if (closes === undefined) e.closes = "polls.error.close_invalid";
  else if (closes !== null) {
    const ms = Date.parse(closes);
    if (ms < now + CLOSE_MIN_MS) e.closes = "polls.error.close_soon";
    else if (ms > now + CLOSE_MAX_MS) e.closes = "polls.error.close_far";
  }
  return e;
}

/**
 * The poll content and close time of a valid draft. Slots carry the creator's offset (RFC 3339), all-day slots start
 * at the creator's midnight and are sorted by start. `timeZone`: the creator's zone (tests; default the device's).
 */
export function buildPoll(d: PollDraft, now: number, timeZone?: string): { content: PollContent; closesAt: string | null } {
  const common = { type: "poll" as const, question: d.question.trim(), results_visible: d.resultsVisible, votes_visible: d.votesVisible };
  const closesAt = closeTime(d, now) ?? null;
  if (d.kind === "choice") {
    const options = d.options.map((o, i) => ({ id: `o${i + 1}`, label: o.label.trim() }));
    const max = d.multiple ? Math.min(Math.max(2, d.maxChoices), options.length) : 1;
    return { content: { ...common, kind: "choice", options, max_choices: max }, closesAt };
  }
  const raw: Omit<PollSlot, "id">[] = [];
  for (const day of Object.keys(d.days).sort()) {
    const entry = d.days[day]!;
    if (entry.allDay) {
      raw.push({ start: toRfc3339(zonedInstant(day, "00:00", timeZone), timeZone), all_day: true });
      continue;
    }
    for (const t of [...entry.times].sort((a, b) => a.start.localeCompare(b.start))) {
      const start = zonedInstant(day, t.start, timeZone);
      const slot: Omit<PollSlot, "id"> = { start: toRfc3339(start, timeZone) };
      if (t.end) slot.end = toRfc3339(zonedInstant(day, t.end, timeZone), timeZone);
      raw.push(slot);
    }
  }
  const slots = raw.map((s, i) => ({ id: `s${i + 1}`, ...s }));
  return { content: { ...common, kind: "date", slots }, closesAt };
}

/** The calendar day of an all-day slot as its creator wrote it (never shifted by time zones). */
export function allDayDate(slot: PollSlot): string {
  return parseRfc3339(slot.start)?.date ?? slot.start.slice(0, 10);
}

/** The days a calendar may still offer: today and later. */
export const isPastDay = (day: string, now: number, timeZone?: string) => day < dayOf(now, timeZone);

