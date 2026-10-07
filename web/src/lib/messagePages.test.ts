// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { MAX_CACHED, MESSAGE_QUERY_OPTIONS, PAGE, fetchPage, flatten, isDetached, mapMessages, newerParam, nextCursor, olderParam, prependMessage, trimPages, type MessagePages } from "./messagePages";

type M = { id: string; body?: string };
const page = (from: number, n: number): M[] => Array.from({ length: n }, (_, i) => ({ id: String(from - i).padStart(4, "0") }));
const data = (...pages: M[][]): InfiniteData<M[], string | undefined> => ({ pages, pageParams: pages.map((_, i) => (i === 0 ? undefined : pages[i - 1]!.at(-1)!.id)) });

describe("jumps into the history (around)", () => {
  const ids = (from: number, n: number) => page(from, n);
  it("an around page with a full newer half is detached; newer pages follow until one is not full", () => {
    // 25 newer messages (0126..0102), the target 0101 and 24 older ones.
    const around = ids(126, PAGE);
    expect(newerParam(around, { around: "0101" })).toEqual({ after: "0126" });
    expect(isDetached({ pages: [around], pageParams: [{ around: "0101" }] })).toBe(true);
    // Near the live end: fewer newer messages than half a page.
    expect(newerParam(ids(110, PAGE), { around: "0101" })).toBeUndefined();
    expect(newerParam(ids(200, PAGE), { after: "0150" })).toEqual({ after: "0200" });
    expect(newerParam(ids(160, 10), { after: "0150" })).toBeUndefined();
    // The newest page (no parameter) and older pages are never detached.
    expect(newerParam(ids(100, PAGE), undefined)).toBeUndefined();
    expect(newerParam(ids(100, PAGE), { before: "0101" })).toBeUndefined();
    expect(newerParam(ids(100, PAGE), "0101")).toBeUndefined();
    expect(newerParam([], { around: "0101" })).toBeUndefined();
    expect(olderParam(ids(100, PAGE))).toEqual({ before: String(100 - PAGE + 1).padStart(4, "0") });
    expect(olderParam(ids(100, 3))).toBeUndefined();
  });

  it("live messages are not prepended while detached", () => {
    const detached: MessagePages<M> = { pages: [ids(126, PAGE)], pageParams: [{ around: "0101" }] };
    expect(prependMessage(detached, { id: "0500" })).toBe(detached);
    const live: MessagePages<M> = { pages: [ids(110, PAGE)], pageParams: [{ around: "0101" }] };
    expect(flatten(prependMessage(live, { id: "0111" }))[0]!.id).toBe("0111");
  });

  it("fetches around, after (reversed to newest first) and before pages", async () => {
    const messages = vi.fn(async (_id: string, q: { after?: string }) => (q.after ? [{ id: "A1" }, { id: "A2" }] : [{ id: "X" }]));
    const api = { conversations: { messages } } as unknown as Parameters<typeof fetchPage>[0];
    expect(await fetchPage(api, "C", { after: "A0" })).toEqual([{ id: "A2" }, { id: "A1" }]);
    expect(messages).toHaveBeenLastCalledWith("C", { limit: PAGE, after: "A0" });
    await fetchPage(api, "C", { around: "T" });
    expect(messages).toHaveBeenLastCalledWith("C", { limit: PAGE, around: "T" });
    await fetchPage(api, "C", undefined);
    expect(messages).toHaveBeenLastCalledWith("C", { limit: PAGE, before: undefined });
  });
});

describe("message pages (newest first)", () => {
  it("flattens newest first and pages with the oldest id as `before` cursor", () => {
    const d = data(page(100, 3), page(97, 2));
    expect(flatten(d).map((m) => m.id)).toEqual(["0100", "0099", "0098", "0097", "0096"]);
    expect(nextCursor(page(100, PAGE))).toBe(String(100 - PAGE + 1).padStart(4, "0"));
    expect(nextCursor(page(100, PAGE - 1))).toBeUndefined();
    expect(flatten(undefined)).toEqual([]);
  });

  it("prepends live messages to the newest page once", () => {
    const d = data(page(100, 2));
    const once = prependMessage(d, { id: "0101" });
    expect(flatten(once).map((m) => m.id)).toEqual(["0101", "0100", "0099"]);
    expect(prependMessage(once, { id: "0101" })).toBe(once);
    expect(prependMessage(undefined, { id: "0101" })).toBeUndefined();
  });

  it("maps and filters across all pages", () => {
    const d = data(page(100, 2), page(98, 2));
    const edited = mapMessages(d, (ms) => ms.map((m) => (m.id === "0097" ? { ...m, body: "neu" } : m)));
    expect(flatten(edited).find((m) => m.id === "0097")?.body).toBe("neu");
    const removed = mapMessages(d, (ms) => ms.filter((m) => m.id !== "0099"));
    expect(flatten(removed).map((m) => m.id)).toEqual(["0100", "0098", "0097"]);
    expect(removed?.pageParams).toEqual(d.pageParams);
  });

  it("evicts the oldest pages beyond the cache bound and keeps the cursors consistent", () => {
    const pages = [page(1000, PAGE), page(950, PAGE), page(900, PAGE), page(850, PAGE), page(800, PAGE), page(750, PAGE)];
    const d: MessagePages<M> = data(...pages);
    const trimmed = trimPages(d, MAX_CACHED)!;
    expect(flatten(trimmed)).toHaveLength(MAX_CACHED);
    expect(trimmed.pages).toHaveLength(MAX_CACHED / PAGE);
    expect(trimmed.pageParams).toEqual(d.pageParams.slice(0, MAX_CACHED / PAGE));
    expect(trimPages(trimmed, MAX_CACHED)).toBe(trimmed);
    // A newest page that grew beyond the bound by live messages is cut, older pages go.
    const grown = data(page(2000, MAX_CACHED + 30), page(1000 + 0, PAGE));
    const cut = trimPages(grown, MAX_CACHED)!;
    expect(cut.pages).toHaveLength(1);
    expect(cut.pages[0]).toHaveLength(MAX_CACHED);
    expect(cut.pages[0]![0]!.id).toBe("2000");
  });
});

describe("message pages in the query cache", () => {
  /** Loads one page through an observer with `options` (as useInfiniteQuery does), prepends a live message, edits one. */
  async function throughCache(options: object) {
    const client = new QueryClient();
    const queryKey = ["messages", "c1"];
    const observer = new InfiniteQueryObserver<M[], Error, MessagePages<M>, string[], string | undefined>(client, {
      queryKey,
      queryFn: async () => page(50, 50),
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
      ...options,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(client.getQueryData(queryKey)).toBeDefined());
    const before = flatten(client.getQueryData<MessagePages<M>>(queryKey));
    client.setQueryData<MessagePages<M>>(queryKey, (d) => prependMessage(d, { id: "0051" }));
    const after = flatten(client.getQueryData<MessagePages<M>>(queryKey));
    client.setQueryData<MessagePages<M>>(queryKey, (d) => mapMessages(d, (p) => p.map((m) => (m.id === "0040" ? { ...m, body: "edited" } : m))));
    const edited = flatten(client.getQueryData<MessagePages<M>>(queryKey));
    unsubscribe();
    client.clear();
    return { before, after, edited };
  }

  it("keeps the identity of every loaded message when a live message arrives or one is edited", async () => {
    const { before, after, edited } = await throughCache(MESSAGE_QUERY_OPTIONS);
    expect(after).toHaveLength(51);
    expect(after.slice(1).every((m, i) => m === before[i])).toBe(true);
    expect(edited.filter((m, i) => m !== after[i]).map((m) => m.id)).toEqual(["0040"]);
  });

  it("(why) structural sharing would copy every message on a prepend", async () => {
    const { before, after } = await throughCache({});
    expect(after.slice(1).filter((m, i) => m !== before[i]).length).toBeGreaterThan(40);
  });
});
