// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { TavrnApiError, type SearchResponse } from "@tavrn/sdk";
import type { Coverage, LocalHit, SearchIndex } from "@tavrn/e2ee";
import { localStatus, mergeRows, nodeQuery, runSearch, searchable, snippetParts, type RoomRef, type SearchRow } from "./combined";

const cov = (conversation: string, patch: Partial<Coverage> = {}): Coverage => ({
  conversation,
  count: 1,
  bytes: 10,
  oldest: 0,
  newest: 0,
  complete: false,
  sync: { done: true, cursor: null, reachedStart: false },
  ...patch,
});

const nodeResponse = (ids: [string, string][]): SearchResponse => ({
  results: ids.map(([id, at]) => ({
    message: { id, conversation_id: "CH1", author: "alice@n.example", author_id: "u", created_at: at, encrypted: false, content: { type: "text", body: "x" }, attachments: [] } as never,
    snippet: `\u0001x\u0002 ${id}`,
    rank: 0,
  })),
  next_cursor: null,
  searched: { kind: "node", channels: 2 },
});

describe("combined search", () => {
  it("builds node queries from the filters (inclusive end date) and knows when there is nothing to search", () => {
    expect(nodeQuery("  hello  ", {})).toEqual({ limit: 50, q: "hello" });
    expect(nodeQuery("", { channel: "C", author: " bob@n ", from: "2026-10-01", to: "2026-10-05", hasFile: true })).toEqual({
      limit: 50,
      channel: "C",
      author: "bob@n",
      after: "2026-10-01",
      before: "2026-10-06",
      has: "file",
    });
    expect(nodeQuery("x".repeat(300), {}).q).toHaveLength(256);
    expect(searchable("", {})).toBe(false);
    expect(searchable("  '()*  ", {})).toBe(false);
    expect(searchable("ö", {})).toBe(true);
    expect(searchable("", { hasFile: true })).toBe(true);
    expect(searchable("", { author: "a@b" })).toBe(true);
  });

  it("merges newest first and shows a message found twice once", () => {
    const row = (key: string, messageId: string, ts: number, source: "node" | "local" = "node"): SearchRow => ({ key, source, node: "n", conversationId: "c", messageId, author: "a", ts, snippet: "", files: [] });
    const merged = mergeRows([[row("1", "A", 10), row("2", "B", 30)], [row("3", "C", 20, "local"), row("4", "A", 10, "local")]]);
    expect(merged.map((r) => r.messageId)).toEqual(["B", "C", "A"]);
  });

  it("counts what the local index covers: window synced, complete, not synced yet", () => {
    const coverage = { "n/A": cov("n/A"), "n/B": cov("n/B", { complete: true, sync: { done: false, cursor: null, reachedStart: true } }), "n/C": cov("n/C", { sync: { done: false, cursor: null, reachedStart: false } }) };
    expect(localStatus([{ node: "n", conversationId: "A" }, { node: "n", conversationId: "B" }, { node: "n", conversationId: "C" }, { node: "n", conversationId: "D" }], coverage)).toEqual({
      localSearched: 2,
      localComplete: 1,
      localNotSynced: 2,
    });
    expect(localStatus(null, coverage).localSearched).toBe(2);
  });

  it("splits snippets at the markers (never markup)", () => {
    expect(snippetParts("a \u0001b\u0002 c <em>d</em>")).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
      { text: " c <em>d</em>", match: false },
    ]);
    expect(snippetParts("")).toEqual([]);
  });

  it("runs the node per room and the local index, merges, and reports honestly", async () => {
    const ok: RoomRef = { node: "n.example", roomId: "R1", api: { search: { room: vi.fn(async () => nodeResponse([["M1", "2026-10-06T10:00:00Z"]])) } } as never };
    const down: RoomRef = { node: "m.example", roomId: "R2", api: { search: { room: vi.fn(async () => Promise.reject(new Error("offline"))) } } as never };
    const hits: LocalHit[] = [{ conversation: "n.example/CH2", id: "M2", ts: Date.parse("2026-10-06T11:00:00Z"), author: "bob@n.example", snippet: "\u0001x\u0002", files: ["a.pdf"] }];
    const search = vi.fn(async () => hits);
    const index = { search } as unknown as SearchIndex;
    const { rows, status } = await runSearch(
      { query: "x", filters: { from: "2026-10-01", hasFile: true }, rooms: [ok, down], local: [{ node: "n.example", conversationId: "CH2", roomId: "R1" }], roomsSkipped: 3 },
      index,
      { "n.example/CH2": cov("n.example/CH2") },
    );
    expect(rows.map((r) => [r.source, r.messageId, r.roomId])).toEqual([
      ["local", "M2", "R1"],
      ["node", "M1", "R1"],
    ]);
    expect(search).toHaveBeenCalledWith("x", expect.objectContaining({ conversations: ["n.example/CH2"], hasFile: true, after: Date.parse("2026-10-01T00:00:00Z") - 1 }));
    expect(status).toMatchObject({ nodeChannels: 2, nodeRooms: 1, nodeFailed: 1, roomsSkipped: 3, localSearched: 1, localNotSynced: 0, localLocked: false });
  });

  it("without the local index (locked) only the node answers, and says so", async () => {
    const ok: RoomRef = { node: "n", roomId: "R", api: { search: { room: async () => nodeResponse([]) } } as never };
    const { status } = await runSearch({ query: "x", filters: {}, rooms: [ok], local: [{ node: "n", conversationId: "E" }] }, null, {});
    expect(status.localLocked).toBe(true);
    // A query the node calls empty is not a failure.
    const empty: RoomRef = { node: "n", roomId: "R", api: { search: { room: async () => Promise.reject(new TavrnApiError({ status: 400, code: "search.query_empty", title: "", detail: "", type: "" } as never)) } } as never };
    expect((await runSearch({ query: "x", filters: {}, rooms: [empty], local: [] }, null, {})).status.nodeFailed).toBe(0);
  });
});

describe("search latency", () => {
  it("the node and the local index are searched at the same time", async () => {
    vi.useFakeTimers();
    try {
      const wait = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
      const room: RoomRef = { node: "n", roomId: "R1", api: { search: { room: () => wait(300, nodeResponse([["N1", "2026-10-01T00:00:00Z"]])) } } as never };
      const index = { search: () => wait(200, [] as LocalHit[]) } as unknown as SearchIndex;
      let done = false;
      const run = runSearch({ query: "x", filters: {}, rooms: [room], local: null }, index, {}).then((r) => ((done = true), r));
      await vi.advanceTimersByTimeAsync(310);
      expect(done).toBe(true);
      expect((await run).rows.map((r) => r.messageId)).toEqual(["N1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("node requests run in a pool: one slow room does not hold back the next ones", async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const room = (id: string, ms: number): RoomRef => ({ node: "n", roomId: id, api: { search: { room: () => (started.push(id), new Promise((r) => setTimeout(() => r(nodeResponse([])), ms))) } } as never });
      const rooms = [room("slow", 1000), room("a", 10), room("b", 10), room("c", 10), room("d", 10), room("e", 10)];
      const run = runSearch({ query: "x", filters: {}, rooms, local: [] }, null, {});
      await vi.advanceTimersByTimeAsync(50);
      expect(started).toEqual(["slow", "a", "b", "c", "d", "e"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await run).status.nodeRooms).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
