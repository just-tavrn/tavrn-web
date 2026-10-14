// SPDX-License-Identifier: Apache-2.0
/**
 * Counting the votes of a poll (PROTOCOL.md §7g) after they were verified: one vote per member (the newest), votes on
 * another version of the poll (`poll_hash` mismatch) and votes after the close time are never counted, choices outside
 * the poll are dropped. Date polls: the best slots have the most "yes" answers, then the most "maybe" answers.
 */
import { ANSWERS, type Answer, type PollContent } from "./model";

/** A vote as the client could read it. `stale`: cast on another version of the poll; `invalid`: unreadable or forged. */
export interface OpenedVote {
  user: string;
  status: "ok" | "stale" | "invalid";
  choices?: string[];
  answers?: Record<string, Answer>;
  /** When the node stored it (late votes are judged by it). */
  updatedAt: string;
  /** This device's vote that the node has not confirmed yet. */
  pending?: boolean;
}

export interface PollTally {
  /** Members whose vote counts. */
  voters: number;
  stale: number;
  invalid: number;
  late: number;
  /** Choice polls: per option id. */
  options: Record<string, { count: number; voters: string[] }>;
  /** Date polls: per slot id, the members per answer. */
  slots: Record<string, Record<Answer, string[]>>;
  /** Date polls: the slot ids with the best answers (empty without any yes or maybe). */
  best: string[];
  /** The viewer's counted vote. */
  mine: OpenedVote | null;
  /** The viewer voted on another version of the poll. */
  mineStale: boolean;
}

export function tallyVotes(poll: PollContent, votes: readonly OpenedVote[], opts: { me?: string; closesAt?: string | null }): PollTally {
  const closes = opts.closesAt ? Date.parse(opts.closesAt) : null;
  // One vote per member: the newest record (the node keeps one per user; a pending local vote replaces it).
  const latest = new Map<string, OpenedVote>();
  for (const v of votes) {
    const prev = latest.get(v.user);
    if (!prev || v.pending || (!prev.pending && v.updatedAt > prev.updatedAt)) latest.set(v.user, v);
  }
  const out: PollTally = { voters: 0, stale: 0, invalid: 0, late: 0, options: {}, slots: {}, best: [], mine: null, mineStale: false };
  if (poll.kind === "choice") for (const o of poll.options) out.options[o.id] = { count: 0, voters: [] };
  else for (const s of poll.slots) out.slots[s.id] = { yes: [], maybe: [], no: [] };
  for (const v of latest.values()) {
    if (v.status === "stale") {
      out.stale++;
      if (v.user === opts.me) out.mineStale = true;
      continue;
    }
    if (v.status === "invalid") {
      out.invalid++;
      continue;
    }
    if (closes !== null && !v.pending && Date.parse(v.updatedAt) > closes) {
      out.late++;
      continue;
    }
    let counted = false;
    if (poll.kind === "choice") {
      const ids = [...new Set(v.choices ?? [])].filter((id) => id in out.options);
      if (ids.length === 0 || ids.length > poll.max_choices) {
        out.invalid++;
        continue;
      }
      for (const id of ids) {
        out.options[id]!.count++;
        out.options[id]!.voters.push(v.user);
      }
      counted = true;
    } else {
      for (const [slot, answer] of Object.entries(v.answers ?? {})) {
        if (!(slot in out.slots) || !ANSWERS.includes(answer)) continue;
        out.slots[slot]![answer].push(v.user);
        counted = true;
      }
      if (!counted) {
        out.invalid++;
        continue;
      }
    }
    out.voters++;
    if (v.user === opts.me) out.mine = v;
  }
  if (poll.kind === "date") {
    let top = [0, 0];
    for (const s of poll.slots) {
      const a = out.slots[s.id]!;
      const score = [a.yes.length, a.maybe.length];
      if (score[0]! + score[1]! === 0) continue;
      if (score[0]! > top[0]! || (score[0] === top[0] && score[1]! > top[1]!)) {
        top = score;
        out.best = [s.id];
      } else if (score[0] === top[0] && score[1] === top[1]) out.best.push(s.id);
    }
  }
  return out;
}

/** Is the poll closed at `now`? */
export const isClosed = (closesAt: string | null | undefined, now: number) => !!closesAt && Date.parse(closesAt) <= now;

/** Who may see what (cooperative flags inside the poll, PROTOCOL.md §7g). */
export function visibility(poll: PollContent, opts: { closed: boolean; voted: boolean }): { results: boolean; voters: boolean } {
  const results = poll.results_visible === "always" || (poll.results_visible === "after_vote" && (opts.voted || opts.closed)) || (poll.results_visible === "after_close" && opts.closed);
  return { results, voters: results && (poll.votes_visible === "public" || opts.closed) };
}
