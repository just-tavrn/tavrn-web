// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkAssembler, LIMITS, RateBudget, Throttle, diffElements, isOwnerDevice, mayEdit, ordered, parseChunk, reconcile, sanitizeColor, sanitizeElements, sanitizeFiles, splitPayload, type WbElement } from "./sync";

const el = (id: string, version: number, versionNonce = version * 7, extra: Partial<WbElement> = {}): WbElement => ({ id, type: "rectangle", version, versionNonce, ...extra });

afterEach(() => vi.useRealTimers());

describe("element diffs", () => {
  it("reports only elements whose version or nonce changed and remembers them", () => {
    const known = new Map<string, string>();
    expect(diffElements([el("a", 1), el("b", 1)], known).map((e) => e.id)).toEqual(["a", "b"]);
    expect(diffElements([el("a", 1), el("b", 1)], known)).toEqual([]);
    expect(diffElements([el("a", 2), el("b", 1)], known).map((e) => e.id)).toEqual(["a"]);
    // Same version, other nonce (concurrent edit elsewhere) is a change as well.
    expect(diffElements([el("a", 2, 99)], known)).toHaveLength(1);
    // Deletions are element updates (isDeleted) with a new version.
    expect(diffElements([el("b", 2, 14, { isDeleted: true })], known)[0]!.isDeleted).toBe(true);
  });

  it("reconciles by version; ties go to the incoming state only when asked", () => {
    const local = new Map([["a", el("a", 3, 1)], ["b", el("b", 1, 1)]]);
    expect(reconcile(local, [el("a", 2, 5)], { incomingWinsTies: true })).toEqual([]);
    expect(reconcile(local, [el("a", 3, 9)], { incomingWinsTies: false })).toEqual([]);
    expect(reconcile(local, [el("a", 3, 9)], { incomingWinsTies: true })).toHaveLength(1);
    expect(local.get("a")!.versionNonce).toBe(9);
    expect(reconcile(local, [el("b", 2, 1), el("c", 1)], { incomingWinsTies: false }).map((e) => e.id)).toEqual(["b", "c"]);
    expect(local.size).toBe(3);
  });

  it("orders by fractional index and hides deleted elements unless asked", () => {
    const list = [el("x", 1, 1, { index: "a2" }), el("y", 1, 1, { index: "a0" }), el("z", 1, 1, { index: "a1", isDeleted: true }), el("w", 1, 1, { index: null })];
    expect(ordered(list).map((e) => e.id)).toEqual(["y", "x", "w"]);
    expect(ordered(list, { withDeleted: true }).map((e) => e.id)).toEqual(["y", "z", "x", "w"]);
  });
});

describe("untrusted payloads", () => {
  it("keeps only well-formed elements of known types", () => {
    const raw = [
      el("ok", 1),
      { id: "t", type: "script", version: 1, versionNonce: 1 },
      { id: "emb", type: "embeddable", version: 1, versionNonce: 1, link: "https://evil.example" },
      { id: "ifr", type: "iframe", version: 1, versionNonce: 1 },
      { id: 5, type: "rectangle", version: 1, versionNonce: 1 },
      { id: "v", type: "rectangle", version: "1", versionNonce: 1 },
      { id: "f", type: "rectangle", version: 1.5, versionNonce: 1 },
      { id: "x".repeat(65), type: "rectangle", version: 1, versionNonce: 1 },
      { id: "big", type: "freedraw", version: 1, versionNonce: 1, points: Array.from({ length: 40_000 }, (_, i) => [i, i]) },
      null,
      "string",
      [1, 2],
    ];
    expect(sanitizeElements(raw).map((e) => e.id)).toEqual(["ok"]);
    expect(sanitizeElements("not a list")).toEqual([]);
    expect(sanitizeElements(Array.from({ length: LIMITS.maxElements + 5 }, (_, i) => el(`e${i}`, 1)))).toHaveLength(LIMITS.maxElements);
  });

  it("accepts images only as data URLs of their declared image type", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const files = sanitizeFiles([
      { id: "a", mimeType: "image/png", dataURL: png, created: 1 },
      { id: "b", mimeType: "text/html", dataURL: "data:text/html;base64,PHNjcmlwdD4=" },
      { id: "c", mimeType: "image/png", dataURL: "javascript:alert(1)" },
      { id: "d", mimeType: "image/jpeg", dataURL: png },
      { id: "e", mimeType: "image/png", dataURL: `data:image/png;base64,${"A".repeat(LIMITS.maxFileChars)}` },
    ]);
    expect(files.map((f) => f.id)).toEqual(["a"]);
  });

  it("allows only plain colors as background", () => {
    expect(sanitizeColor("#ffeedd")).toBe("#ffeedd");
    expect(sanitizeColor("#abc")).toBe("#abc");
    expect(sanitizeColor("transparent")).toBe("transparent");
    for (const bad of ["red; background:url(x)", "url(javascript:1)", "#12345", 7, null]) expect(sanitizeColor(bad)).toBeNull();
  });
});

describe("permissions", () => {
  const session = { owner: "alice@n.test", device_id: "DA", open_for_all: false, grants: ["bob@n.test"] };
  it("lets the owner, granted users or everyone (when open) edit", () => {
    expect(mayEdit(session, "alice@n.test")).toBe(true);
    expect(mayEdit(session, "Bob@N.test")).toBe(true);
    expect(mayEdit(session, "carol@n.test")).toBe(false);
    expect(mayEdit({ ...session, open_for_all: true }, "carol@n.test")).toBe(true);
    expect(mayEdit(null, "alice@n.test")).toBe(false);
  });

  it("knows the presenting device", () => {
    expect(isOwnerDevice(session, "alice@n.test", "DA")).toBe(true);
    expect(isOwnerDevice(session, "alice@n.test", "OTHER")).toBe(false);
    expect(isOwnerDevice(session, "bob@n.test", "DA")).toBe(false);
  });
});

describe("throttling and the send budget", () => {
  it("runs the first call at once and collapses the rest of the window into one trailing call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = new Throttle(50, fn);
    for (let i = 0; i < 10; i++) t.schedule();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(49);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    // 20 calls per second at most for a 50 ms window.
    for (let i = 0; i < 100; i++) {
      t.schedule();
      vi.advanceTimersByTime(10);
    }
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2 + 21);
    t.cancel();
  });

  it("limits events per second and keeps a reserve for important ones", () => {
    let now = 0;
    const b = new RateBudget(10, () => now);
    let taken = 0;
    while (b.take()) taken++;
    expect(taken).toBe(10);
    expect(b.wait()).toBe(100);
    now += 500;
    expect(b.take(4)).toBe(true); // 5 tokens back, one taken with 4 in reserve
    expect(b.take(4)).toBe(false);
    expect(b.take()).toBe(true);
  });
});

describe("chunks", () => {
  it("splits large payloads and reassembles them in any order", () => {
    const json = JSON.stringify({ type: "whiteboard.snapshot", text: "äöü ✓ ".repeat(20_000) });
    const parts = splitPayload(json, 30_000);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(40_000);
    const a = new ChunkAssembler();
    const order = parts.map((_, i) => i).reverse();
    let out: string | null = null;
    for (const i of order) out = a.add("alice/D1", { id: "c1", index: i, total: parts.length, data: parts[i]! }) ?? out;
    expect(out).toBe(json);
    expect(a.pending).toBe(0);
  });

  it("bounds what a sender can make the receiver keep", () => {
    let now = 0;
    const a = new ChunkAssembler(() => now);
    for (let i = 0; i < LIMITS.maxAssembliesPerSender; i++) expect(a.add("m/D", { id: `x${i}`, index: 0, total: 2, data: "AA" })).toBeNull();
    a.add("m/D", { id: "over", index: 0, total: 2, data: "AA" });
    expect(a.pending).toBe(LIMITS.maxAssembliesPerSender);
    // Duplicates and mismatching totals are ignored; stale assemblies time out.
    expect(a.add("m/D", { id: "x0", index: 0, total: 2, data: "AA" })).toBeNull();
    now += LIMITS.chunkTimeoutMs + 1;
    a.prune();
    expect(a.pending).toBe(0);
    expect(parseChunk({ id: "a", index: 2, total: 2, data: "" })).toBeNull();
    expect(parseChunk({ id: "a", index: 0, total: 100_000, data: "" })).toBeNull();
    expect(parseChunk({ id: "a", index: 0, total: 1, data: "x".repeat(50_000) })).toBeNull();
    expect(parseChunk({ id: "a", index: 0, total: 1, data: "AA" })).toEqual({ id: "a", index: 0, total: 1, data: "AA" });
  });

  it("bounds the bytes one sender can keep across all of its assemblies", () => {
    const a = new ChunkAssembler();
    const data = splitPayload("x".repeat(LIMITS.chunkBytes))[0]!;
    const total = Math.ceil(LIMITS.maxAssembledBytes / LIMITS.chunkBytes);
    // Four assemblies of almost 16 MiB each are never completed: together they may not hold more than the budget.
    let kept = 0;
    for (let n = 0; n < LIMITS.maxAssembliesPerSender; n++) {
      for (let i = 0; i < total - 1; i++) a.add("m/D", { id: `big${n}`, index: i, total, data });
    }
    kept = a.bytesOf("m/D");
    expect(kept).toBeLessThanOrEqual(LIMITS.maxSenderBytes);
    // Another sender is not affected.
    expect(a.add("o/D", { id: "small", index: 0, total: 1, data: splitPayload("{}")[0]! })).toBe("{}");
  });
});
