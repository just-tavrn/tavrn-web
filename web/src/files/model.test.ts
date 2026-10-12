// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { FileEntry } from "@tavrn/sdk";
import { EMPTY_SELECTION, canModify, externalBackend, needsStore, entryIcon, extensionOf, formatBytes, moveFocus, precheck, pruneSelection, selectAll, selectWith, sortEntries, totalProgress, uploadsReducer, usageFraction, validName } from "./model";

const entry = (name: string, kind: "file" | "folder" = "file", extra: Partial<FileEntry> = {}): FileEntry => ({
  id: name,
  channel_id: "C",
  parent_id: null,
  kind,
  name,
  mime: kind === "folder" ? "" : "application/octet-stream",
  thumbnail_size: 0,
  size: 0,
  sha256: "",
  created_by: "u1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...extra,
});

describe("sorting", () => {
  it("keeps folders first and sorts naturally", () => {
    const list = [entry("b10.txt"), entry("Zeta", "folder"), entry("b2.txt"), entry("alpha", "folder"), entry("A.txt")];
    expect(sortEntries(list, { key: "name", dir: "asc" }).map((e) => e.name)).toEqual(["alpha", "Zeta", "A.txt", "b2.txt", "b10.txt"]);
    expect(sortEntries(list, { key: "name", dir: "desc" }).map((e) => e.name)).toEqual(["Zeta", "alpha", "b10.txt", "b2.txt", "A.txt"]);
  });

  it("sorts by size, date and type with the name as tie breaker", () => {
    const list = [entry("a.zip", "file", { size: 30 }), entry("b.txt", "file", { size: 10, updated_at: "2026-03-01T00:00:00Z" }), entry("c.txt", "file", { size: 20 })];
    expect(sortEntries(list, { key: "size", dir: "asc" }).map((e) => e.name)).toEqual(["b.txt", "c.txt", "a.zip"]);
    expect(sortEntries(list, { key: "modified", dir: "desc" })[0]!.name).toBe("b.txt");
    expect(sortEntries(list, { key: "type", dir: "asc" }).map((e) => e.name)).toEqual(["b.txt", "c.txt", "a.zip"]);
  });
});

describe("names", () => {
  it("mirror the node's rules", () => {
    for (const ok of ["report.pdf", "  spaced  ", "..hidden", "ünïcødé 名前", "x".repeat(255)]) expect(validName(ok), ok).toBe(true);
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "tab\tname", "evil‮gpj.exe", "x".repeat(256)]) expect(validName(bad), JSON.stringify(bad)).toBe(false);
  });

  it("finds extensions", () => {
    expect(extensionOf("a.tar.GZ")).toBe("gz");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("README")).toBe("");
  });
});

describe("selection", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("selects one, toggles with Ctrl and extends ranges with Shift", () => {
    let s = selectWith(EMPTY_SELECTION, order, "b");
    expect([...s.ids]).toEqual(["b"]);
    s = selectWith(s, order, "d", { shift: true });
    expect([...s.ids]).toEqual(["b", "c", "d"]);
    s = selectWith(s, order, "a", { shift: true });
    expect([...s.ids]).toEqual(["a", "b"]);
    s = selectWith(s, order, "e", { ctrl: true });
    expect([...s.ids].sort()).toEqual(["a", "b", "e"]);
    s = selectWith(s, order, "a", { ctrl: true });
    expect([...s.ids].sort()).toEqual(["b", "e"]);
    expect(s.anchor).toBe("a");
    s = selectWith(s, order, "c", { ctrl: true, shift: true });
    expect([...s.ids].sort()).toEqual(["a", "b", "c", "e"]);
    expect([...selectAll(order).ids]).toEqual(order);
  });

  it("forgets entries that disappeared", () => {
    const s = selectWith(selectWith(EMPTY_SELECTION, ["a", "b"], "a"), ["a", "b"], "b", { ctrl: true });
    const pruned = pruneSelection(s, ["a"]);
    expect([...pruned.ids]).toEqual(["a"]);
    expect(pruned.anchor).toBeNull();
    expect(pruneSelection(pruned, ["a"])).toBe(pruned);
  });

  it("moves the focus in lists and grids", () => {
    expect(moveFocus(order, null, "ArrowDown")).toBe("a");
    expect(moveFocus(order, null, "End")).toBe("e");
    expect(moveFocus(order, "a", "ArrowDown")).toBe("b");
    expect(moveFocus(order, "a", "ArrowUp")).toBe("a");
    expect(moveFocus(order, "b", "End")).toBe("e");
    expect(moveFocus(order, "d", "Home")).toBe("a");
    expect(moveFocus(order, "a", "ArrowRight")).toBe("a");
    expect(moveFocus(order, "a", "ArrowDown", 3)).toBe("d");
    expect(moveFocus(order, "d", "ArrowRight", 3)).toBe("e");
    expect(moveFocus(order, "c", "PageDown", 1, 10)).toBe("e");
    expect(moveFocus([], "a", "ArrowDown")).toBeNull();
  });
});

describe("uploads", () => {
  it("tracks the queue and the weighted progress", () => {
    let q = uploadsReducer([], { type: "add", items: [{ key: "1", name: "a", size: 100 }, { key: "2", name: "b", size: 300 }] });
    expect(totalProgress(q)).toBe(0);
    q = uploadsReducer(q, { type: "start", key: "1" });
    q = uploadsReducer(q, { type: "progress", key: "1", progress: 0.5 });
    expect(totalProgress(q)).toBeCloseTo(50 / 400);
    q = uploadsReducer(q, { type: "done", key: "1" });
    q = uploadsReducer(q, { type: "error", key: "2", error: "too large" });
    expect(totalProgress(q)).toBeNull();
    expect(q[1]!.error).toBe("too large");
    expect(uploadsReducer(q, { type: "clear" })).toEqual([]);
    expect(uploadsReducer(q, { type: "progress", key: "1", progress: 7 })[0]!.progress).toBe(1);
  });

  it("prechecks size and quota", () => {
    const info = { max_upload_bytes: 100, limit_bytes: 500, used_bytes: 450 };
    expect(precheck({ name: "a", size: 101 }, info)).toBe("too_large");
    expect(precheck({ name: "a", size: 60 }, info)).toBe("quota");
    expect(precheck({ name: "a", size: 50 }, info)).toBeNull();
    expect(precheck({ name: "a", size: 10_000 }, { max_upload_bytes: 0, limit_bytes: 0, used_bytes: 0 })).toBeNull();
  });
});

describe("formatting and rights", () => {
  it("formats sizes and the meter", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300 MB");
    expect(usageFraction(50, 0)).toBeNull();
    expect(usageFraction(50, 200)).toBe(0.25);
    expect(usageFraction(500, 200)).toBe(1);
  });

  it("picks icons and decides who may modify", () => {
    expect(entryIcon(entry("x", "folder"))).toBe("📁");
    expect(entryIcon(entry("a.png", "file", { mime: "image/png" }))).toBe("🖼");
    expect(entryIcon(entry("a.svg", "file", { mime: "image/svg+xml" }))).toBe("📄");
    expect(entryIcon(entry("a.zip"))).toBe("🗜");
    const mine = entry("a", "file", { created_by: "me" });
    expect(canModify(mine, "me", { can_manage: false, can_attach: true })).toBe(true);
    expect(canModify(mine, "other", { can_manage: false, can_attach: true })).toBe(false);
    expect(canModify(mine, "me", { can_manage: false, can_attach: false })).toBe(false);
    expect(canModify(mine, "other", { can_manage: true, can_attach: false })).toBe(true);
  });
});

describe("store of a files channel", () => {
  it("knows external stores and channels that still need one (FILES.md §5)", () => {
    expect([externalBackend("webdav"), externalBackend("s3"), externalBackend("internal"), externalBackend("none")]).toEqual([true, true, false, false]);
    expect(needsStore({ backend: "none" })).toBe(true);
    expect(needsStore({ backend: "internal" })).toBe(false);
    expect(needsStore({ backend: "webdav" })).toBe(false);
    expect(needsStore(undefined)).toBe(false);
  });
});
