// SPDX-License-Identifier: Apache-2.0
// Proactive MLS group joins (ENCRYPTION.md §7b): a loaded room's encrypted channels are joined one after the other,
// never created, each at most once per retry interval, so the gap between the room join and the first leaf stays small.
import { describe, expect, it } from "vitest";
import type { MlsManager } from "@tavrn/e2ee";
import { JOINABLE_KINDS, createGroupJoiner } from "./groupJoins";

const ch = (id: string, kind = "text", encrypted = true) => ({ id, kind, encrypted });

/** A session manager that records joins, how many run at once and answers per conversation. */
function fakeMls(answers: Record<string, "joined" | "no_group" | "fail"> = {}, has: string[] = []) {
  const groups = new Set(has);
  const calls: { q: string; canCreate: boolean }[] = [];
  let active = 0;
  let maxActive = 0;
  const mls = {
    hasGroup: (q: string) => groups.has(q),
    ensureJoined: async (q: string, opts: { canCreate: boolean }) => {
      calls.push({ q, canCreate: opts.canCreate });
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      const a = answers[q] ?? "joined";
      if (a === "fail") throw new Error("403");
      if (a === "joined") groups.add(q);
      return a;
    },
  } as unknown as MlsManager;
  return { mls, calls, maxActive: () => maxActive };
}

function joiner(mls: MlsManager | null, t = { now: 0 }) {
  const pauses: number[] = [];
  const j = createGroupJoiner({ mls: async () => mls, pauseMs: 400, retryMs: 1000, now: () => t.now, sleep: async (ms) => void pauses.push(ms) });
  return { j, pauses, t };
}

describe("createGroupJoiner", () => {
  it("joins the encrypted channels with content one after the other, never creating a group", async () => {
    const f = fakeMls();
    const { j, pauses } = joiner(f.mls);
    await j.enqueue("node.example", [ch("a"), ch("v", "voice"), ch("s", "system"), ch("p", "text", false), ch("f", "files"), ch("n", "announcement"), ch("o", "forum")]);
    expect(f.calls.map((c) => c.q)).toEqual(["node.example/a", "node.example/f", "node.example/n", "node.example/o"]);
    expect(f.calls.every((c) => !c.canCreate)).toBe(true);
    expect(f.maxActive()).toBe(1);
    // A pause between two joins, none before the first.
    expect(pauses).toEqual([400, 400, 400]);
    expect([...JOINABLE_KINDS].sort()).toEqual(["announcement", "files", "forum", "text"]);
  });

  it("skips groups this device is in and asks again only after the retry interval", async () => {
    const f = fakeMls({ "d/none": "no_group", "d/err": "fail" }, ["d/in"]);
    const { j, t } = joiner(f.mls);
    await j.enqueue("d", [ch("in"), ch("none"), ch("err"), ch("ok")]);
    expect(f.calls.map((c) => c.q)).toEqual(["d/none", "d/err", "d/ok"]);
    // Loaded again: joined and in-group channels cost nothing, failed ones wait for the interval.
    await j.enqueue("d", [ch("in"), ch("none"), ch("err"), ch("ok")]);
    expect(f.calls).toHaveLength(3);
    t.now = 1001;
    await j.enqueue("d", [ch("in"), ch("none"), ch("err"), ch("ok")]);
    expect(f.calls.map((c) => c.q).slice(3)).toEqual(["d/none", "d/err"]);
  });

  it("queues channels of rooms loaded while joins run, once each", async () => {
    const f = fakeMls();
    const { j } = joiner(f.mls);
    const first = j.enqueue("d", [ch("a"), ch("b")]);
    const second = j.enqueue("d", [ch("b"), ch("c")]);
    await Promise.all([first, second]);
    expect(f.calls.map((c) => c.q)).toEqual(["d/a", "d/b", "d/c"]);
    expect(f.maxActive()).toBe(1);
  });

  it("does nothing while the device is locked and forgets everything on reset", async () => {
    const locked = joiner(null);
    await locked.j.enqueue("d", [ch("a")]);
    const f = fakeMls({ "d/a": "no_group" });
    const { j } = joiner(f.mls);
    await j.enqueue("d", [ch("a")]);
    j.reset();
    await j.enqueue("d", [ch("a")]);
    expect(f.calls).toHaveLength(2);
  });
});

describe("the group joins pause while a voice join runs", () => {
  it("no probe starts while a hold is pending; they go on once it settled", async () => {
    const f = fakeMls();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const holds = new Set<Promise<unknown>>([hold]);
    const j = createGroupJoiner({ mls: async () => f.mls, pauseMs: 0, sleep: async () => undefined, held: async () => void (await Promise.all(holds)) });
    const done = j.enqueue("t.local", [ch("c1"), ch("c2")]);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls).toEqual([]);
    release();
    await done;
    expect(f.calls.map((c) => c.q)).toEqual(["t.local/c1", "t.local/c2"]);
  });

  it("holdGroupJoins: a failed join releases the hold too", async () => {
    const { holdGroupJoins, groupJoinsHeld } = await import("./groupJoins");
    let fail!: (e: Error) => void;
    holdGroupJoins(new Promise((_, rej) => (fail = rej)));
    let free = false;
    const waiting = groupJoinsHeld().then(() => (free = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(free).toBe(false);
    fail(new Error("no_group"));
    await waiting;
    expect(free).toBe(true);
  });
});
