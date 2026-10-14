// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ChoicePoll, DatePoll } from "./model";
import { tallyVotes, visibility, type OpenedVote } from "./tally";

const choice: ChoicePoll = { type: "poll", kind: "choice", question: "Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], max_choices: 2, results_visible: "always", votes_visible: "public" };
const date: DatePoll = { type: "poll", kind: "date", question: "Q", slots: [{ id: "s1", start: "2026-11-06T19:00:00+01:00" }, { id: "s2", start: "2026-11-07T19:00:00+01:00" }, { id: "s3", start: "2026-11-08T19:00:00+01:00" }], results_visible: "always", votes_visible: "public" };
const v = (user: string, x: Partial<OpenedVote>): OpenedVote => ({ user, status: "ok", updatedAt: "2026-10-14T10:00:00Z", ...x });

describe("tallyVotes", () => {
  it("counts one vote per member, the newest, and drops unknown or too many choices", () => {
    const t = tallyVotes(
      choice,
      [
        v("alice", { choices: ["a"], updatedAt: "2026-10-14T09:00:00Z" }),
        v("alice", { choices: ["b"], updatedAt: "2026-10-14T09:30:00Z" }),
        v("bob", { choices: ["b", "c", "x"] }),
        v("carol", { choices: ["a", "b", "c"] }),
        v("dave", { choices: ["x"] }),
      ],
      { me: "alice" },
    );
    expect(t.options).toEqual({ a: { count: 0, voters: [] }, b: { count: 2, voters: ["alice", "bob"] }, c: { count: 1, voters: ["bob"] } });
    expect(t.voters).toBe(2);
    expect(t.invalid).toBe(2);
    expect(t.mine?.choices).toEqual(["b"]);
  });

  it("never counts stale, unverifiable or late votes; a pending own vote replaces the stored one", () => {
    const t = tallyVotes(
      choice,
      [
        v("alice", { status: "stale", choices: ["a"] }),
        v("bob", { status: "invalid" }),
        v("carol", { choices: ["a"], updatedAt: "2026-10-14T12:00:01Z" }),
        v("dave", { choices: ["a"], updatedAt: "2026-10-14T13:00:00Z" }),
        v("dave", { choices: ["c"], pending: true, updatedAt: "2026-10-14T11:00:00Z" }),
      ],
      { me: "alice", closesAt: "2026-10-14T12:00:00Z" },
    );
    expect(t).toMatchObject({ voters: 1, stale: 1, invalid: 1, late: 1, mine: null, mineStale: true });
    expect(t.options.c!.voters).toEqual(["dave"]);
  });

  it("date polls: answers per slot and the best slots (most yes, then most maybe)", () => {
    const t = tallyVotes(
      date,
      [v("a", { answers: { s1: "yes", s2: "yes", s3: "no" } }), v("b", { answers: { s1: "maybe", s2: "yes" } }), v("c", { answers: { s1: "yes", s2: "maybe", zz: "yes" } }), v("d", { answers: { s1: "perhaps" as never } })],
      {},
    );
    expect(t.slots.s1).toEqual({ yes: ["a", "c"], maybe: ["b"], no: [] });
    expect(t.best).toEqual(["s1", "s2"]);
    expect(t.voters).toBe(3);
    expect(t.invalid).toBe(1);
    expect(tallyVotes(date, [v("a", { answers: { s1: "no" } })], {}).best).toEqual([]);
  });

  it("visibility follows the cooperative flags", () => {
    expect(visibility(choice, { closed: false, voted: false })).toEqual({ results: true, voters: true });
    expect(visibility({ ...choice, results_visible: "after_vote" }, { closed: false, voted: false })).toEqual({ results: false, voters: false });
    expect(visibility({ ...choice, results_visible: "after_vote" }, { closed: false, voted: true }).results).toBe(true);
    expect(visibility({ ...choice, results_visible: "after_close" }, { closed: false, voted: true }).results).toBe(false);
    expect(visibility({ ...choice, votes_visible: "hidden_until_close" }, { closed: false, voted: true })).toEqual({ results: true, voters: false });
    expect(visibility({ ...choice, votes_visible: "hidden_until_close" }, { closed: true, voted: false })).toEqual({ results: true, voters: true });
  });
});
