// SPDX-License-Identifier: Apache-2.0
// What the shells' platforms share (shellGlue.ts, files.ts `chunkedSaveFile`, appSession.ts `nodePageAuth`) and the
// rule that the Electron platform loads no Tauri module (docs/DESKTOP.md "The Linux shell (Electron)").
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chunkedSaveFile } from "./files";
import { isClientPath, isTrayAction, trayStatusOf, updaterOf } from "./shellGlue";

/** The local modules `entry` imports, transitively (relative imports of this folder and its parents). */
function importGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const source = readFileSync(file, "utf8");
    const specs = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!);
    seen.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const path = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p));
      if (path) visit(path);
    }
  };
  visit(entry);
  return seen;
}

describe("the shells' shared glue", () => {
  it("the Electron platform imports no Tauri module, not even indirectly", () => {
    const graph = importGraph(resolve(__dirname, "electron.ts"));
    const tauri = [...graph].filter(([, specs]) => specs.some((s) => s.startsWith("@tauri-apps/"))).map(([f]) => f);
    expect(tauri).toEqual([]);
    expect(graph.size).toBeGreaterThan(3);
  });

  it("tray actions and client paths", () => {
    expect(["mute", "deafen", "leave"].every(isTrayAction)).toBe(true);
    expect(isTrayAction("quit")).toBe(false);
    expect(isClientPath("/rooms/1")).toBe(true);
    for (const bad of ["//evil.example", "https://x.example", 3, null]) expect(isClientPath(bad)).toBe(false);
    expect(trayStatusOf({ state: "connected", tooltip: "t", available: true, close_to_tray: false })).toEqual({ state: "connected", tooltip: "t", available: true, closeToTray: false });
  });

  it("the updater names every failure with an update code, the install included", async () => {
    const install = vi.fn(async () => {
      throw "update.signature_invalid";
    });
    const u = updaterOf({ check: async () => ({ version: "0.5.0", notes: undefined }), install, getChannel: async () => "beta", setChannel: async () => undefined });
    const found = await u.check();
    expect(found).toMatchObject({ version: "0.5.0", notes: null });
    await expect(found!.install()).rejects.toMatchObject({ problem: { code: "update.signature_invalid" } });
    await expect(u.channel!.get()).resolves.toBe("beta");
    const offline = updaterOf({ check: async () => Promise.reject("update.unreachable"), install, getChannel: async () => "stable", setChannel: async () => Promise.reject(new Error("x")) });
    await expect(offline.check()).rejects.toMatchObject({ problem: { code: "update.unreachable" } });
    await expect(offline.channel!.set("beta")).rejects.toMatchObject({ problem: { code: "update.failed" } });
  });

  it("a chunked save: dialog, chunks of the given size, the end; a failure aborts and rethrows", async () => {
    const log: string[] = [];
    const save = chunkedSaveFile({
      begin: async (name, mime, size) => (log.push(`begin ${name} ${mime} ${size}`), { status: "ready", id: "7" }),
      chunk: async (id, bytes) => void log.push(`chunk ${id} ${bytes.length}`),
      end: async () => ({ name: "renamed.txt" }),
      abort: async (id) => void log.push(`abort ${id}`),
      chunkBytes: 4,
    });
    await expect(save({ name: "a.txt", data: new Uint8Array(10), mime: "text/plain" })).resolves.toEqual({ status: "saved", name: "renamed.txt", path: "", folder: "" });
    expect(log).toEqual(["begin a.txt text/plain 10", "chunk 7 4", "chunk 7 4", "chunk 7 2"]);
    const failing = chunkedSaveFile({
      begin: async () => ({ status: "ready", id: "8" }),
      chunk: async () => Promise.reject(new Error("disk full")),
      end: async () => ({ path: "/x", folder: "x" }),
      abort: async (id) => void log.push(`abort ${id}`),
      reveal: async () => undefined,
    });
    await expect(failing({ name: "b", data: new Uint8Array(1) })).rejects.toThrow("disk full");
    expect(log.at(-1)).toBe("abort 8");
    const cancelled = chunkedSaveFile({ begin: async () => ({ status: "cancelled" }), chunk: vi.fn(), end: vi.fn(), abort: vi.fn() });
    await expect(cancelled({ name: "c", data: new Uint8Array(1) })).resolves.toEqual({ status: "cancelled" });
  });
});
