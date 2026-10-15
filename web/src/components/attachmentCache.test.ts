// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { AttachmentCache } from "./attachmentCache";

const MB = 1024 * 1024;
const blobOf = (size: number) => new Blob([new Uint8Array(size)]);
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(budget = 3 * MB, maxEntries = 100) {
  const revoked: string[] = [];
  let n = 0;
  const cache = new AttachmentCache({ budget, maxEntries, createUrl: () => `blob:${++n}`, revokeUrl: (u) => revoked.push(u) });
  return { cache, revoked };
}

describe("AttachmentCache", () => {
  it("shares one load per key", async () => {
    const { cache } = setup();
    const load = vi.fn(async () => blobOf(10));
    const a = cache.blob("k", 10, load);
    const b = cache.blob("k", 10, load);
    expect(a).toBe(b);
    await a;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops the least recently used unused entries over the byte budget and revokes their URLs", async () => {
    const { cache, revoked } = setup(3 * MB);
    const urls: string[] = [];
    for (const k of ["a", "b", "c"]) {
      const held = cache.acquireUrl(k, MB, async () => blobOf(MB));
      urls.push(await held.url);
      held.release();
    }
    await flush();
    expect(cache.bytes).toBe(3 * MB);
    // "a" is used again: "b" is now the oldest.
    await cache.blob("a", MB, async () => blobOf(MB));
    const d = cache.acquireUrl("d", MB, async () => blobOf(MB));
    await d.url;
    await flush();
    expect(revoked).toEqual([urls[1]]);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.bytes).toBe(3 * MB);
    d.release();
  });

  it("never drops an entry that is in use, however far over the budget", async () => {
    const { cache, revoked } = setup(1 * MB);
    const big = cache.acquireUrl("big", 5 * MB, async () => blobOf(5 * MB));
    await big.url;
    await flush();
    expect(cache.has("big")).toBe(true);
    expect(revoked).toEqual([]);
    big.release();
    big.release(); // a second release is ignored
    await flush();
    expect(cache.has("big")).toBe(false);
    expect(revoked).toEqual(["blob:1"]);
  });

  it("an entry released and acquired again in one go (remount) keeps its URL", async () => {
    const { cache, revoked } = setup(1 * MB);
    const first = cache.acquireUrl("x", 2 * MB, async () => blobOf(2 * MB));
    const url = await first.url;
    first.release();
    const again = cache.acquireUrl("x", 2 * MB, async () => blobOf(2 * MB));
    await flush();
    expect(await again.url).toBe(url);
    expect(revoked).toEqual([]);
    again.release();
  });

  it("bounds the number of entries too", async () => {
    const { cache } = setup(100 * MB, 3);
    for (const k of ["a", "b", "c", "d", "e"]) await cache.blob(k, 1, async () => blobOf(1));
    await flush();
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
  });

  it("forgets failed loads and clears everything on sign-out", async () => {
    const { cache, revoked } = setup();
    await expect(cache.blob("bad", 1, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(cache.has("bad")).toBe(false);
    const held = cache.acquireUrl("ok", 1, async () => blobOf(1));
    await held.url;
    cache.clear();
    await flush();
    expect(cache.size).toBe(0);
    expect(revoked).toEqual(["blob:1"]);
  });
});
