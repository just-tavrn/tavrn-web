// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Coverage } from "@tavrn/e2ee";
import { FORWARD_EVERY_MS, parseCursor, pickJob } from "./sync";

const cov = (conversation: string, patch: Partial<Coverage> = {}): Coverage => ({
  conversation,
  count: 0,
  bytes: 0,
  oldest: null,
  newest: null,
  complete: false,
  sync: { done: false, cursor: null, reachedStart: false },
  ...patch,
});
const done = { done: true, cursor: null, reachedStart: true };

describe("search sync", () => {
  it("parses its cursor defensively", () => {
    expect(parseCursor(null)).toEqual({ b: null, f: null });
    expect(parseCursor("not json")).toEqual({ b: null, f: null });
    expect(parseCursor(JSON.stringify({ b: "B", f: 5, r: "R" }))).toEqual({ b: "B", f: null, r: "R" });
  });

  it("picks unfinished history first (full history before the window), then due forward rounds, only for member conversations", () => {
    const member = (q: string) => q !== "n/foreign";
    const now = 10 * FORWARD_EVERY_MS;
    const list = [cov("n/window"), cov("n/full", { complete: true }), cov("n/foreign", { complete: true }), cov("n/synced", { sync: done })];
    expect(pickJob(list, member, new Map(), now)).toEqual({ conversation: "n/full", direction: "back" });
    // A conversation in backoff waits.
    expect(pickJob(list, member, new Map(), now, new Map([["n/full", now + 1]]))).toEqual({ conversation: "n/window", direction: "back" });
    const synced = [cov("n/a", { sync: done }), cov("n/b", { sync: done })];
    expect(pickJob(synced, member, new Map([["n/a", now]]), now)).toEqual({ conversation: "n/b", direction: "forward" });
    expect(pickJob(synced, member, new Map([["n/a", now], ["n/b", now - 1]]), now)).toBeNull();
    expect(pickJob([cov("n/foreign")], member, new Map(), now)).toBeNull();
  });
});
