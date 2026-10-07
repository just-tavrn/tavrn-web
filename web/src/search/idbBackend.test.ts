// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { SearchIndex, deriveSearchKeys } from "@tavrn/e2ee";
import { backendContract } from "@tavrn/e2ee/search-contract";
import { IdbSearchBackend, searchNamespace } from "./idbBackend";

let n = 0;
const dbName = () => `tavrn-search-test-${n++}`;

backendContract("indexeddb", () => new IdbSearchBackend("alice@t.local", dbName()));

describe("IdbSearchBackend", () => {
  it("namespaces records per account without storing the address", async () => {
    const name = dbName();
    const alice = new IdbSearchBackend("alice@t.local", name);
    const bob = new IdbSearchBackend("bob@t.local", name);
    await alice.write([{ store: "meta", key: "k", value: new Uint8Array([1]) }]);
    await bob.write([{ store: "meta", key: "k", value: new Uint8Array([2]) }]);
    expect(Array.from((await alice.get("meta", "k"))!)).toEqual([1]);
    expect(Array.from((await bob.get("meta", "k"))!)).toEqual([2]);
    expect(await alice.keys("meta")).toEqual(["k"]);
    expect(await alice.size()).toBe(1);
    await alice.clear();
    expect(await alice.get("meta", "k")).toBeNull();
    expect(Array.from((await bob.get("meta", "k"))!)).toEqual([2]);

    const ns = await searchNamespace("bob@t.local");
    expect(ns).toMatch(/^[0-9a-f]{16}:$/);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const raw = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = db.transaction("meta").objectStore("meta").getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(raw).toEqual([`${ns}k`]);
    db.close();
    await alice.close();
    await bob.close();
  });

  it("runs a SearchIndex", async () => {
    const keys = await deriveSearchKeys(new Uint8Array(32).fill(5));
    const backend = new IdbSearchBackend("alice@t.local", dbName());
    const index = await SearchIndex.open(backend, keys);
    const now = Date.now();
    await index.add([
      { conversation: "n.example/c1", id: "01J9ZK3G5M8Q2W4E6R8T0Y2VC1", ts: now - 2000, author: "alice@t.local", text: "Treffen morgen am Bahnhof", files: [] },
      { conversation: "n.example/c1", id: "01J9ZK3G5M8Q2W4E6R8T0Y2VC2", ts: now - 1000, author: "bob@t.local", text: "Bahnhof passt", files: ["plan.pdf"] },
    ]);
    expect((await index.search("bahn")).map((h) => h.author)).toEqual(["bob@t.local", "alice@t.local"]);
    const reopened = await SearchIndex.open(backend, keys);
    expect(await reopened.search("treffen")).toHaveLength(1);
    expect((await reopened.stats()).messages).toBe(2);
    await backend.close();
  });
});
