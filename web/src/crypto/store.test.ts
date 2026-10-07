// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { CryptoStore, LocalKeyMismatchError } from "./store";
import { initCryptoForTests } from "../test/wasm";

const ALICE = "alice@t.local";
const DEV = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const master = () => new Uint8Array(32).fill(7);
let n = 0;
const fresh = () => `test-db-${++n}`;

beforeAll(() => initCryptoForTests());

describe("CryptoStore", () => {
  it("starts empty, stores the master secret and resumes in a new tab by default", async () => {
    const db = fresh();
    const store = new CryptoStore(db);
    expect(await store.status(ALICE)).toBe("none");
    expect(await store.resume(ALICE)).toBe(false);
    await store.saveMaster(ALICE, DEV, master());
    expect(store.isUnlocked(ALICE)).toBe(true);
    expect(store.isUnlocked("bob@t.local")).toBe(false);
    expect(await store.status(ALICE)).toBe("unlocked");
    expect(store.masterSecret()).toEqual(master());
    expect(store.deviceId()).toBe(DEV);
    await store.putSecret("mls-client", new Uint8Array([1, 2, 3]));

    const tab2 = new CryptoStore(db);
    expect(await tab2.status(ALICE)).toBe("locked");
    expect(await tab2.resume(ALICE)).toBe(true);
    expect(tab2.masterSecret()).toEqual(master());
    expect(await tab2.getSecret("mls-client")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await tab2.getSecret("missing")).toBeNull();
  });

  it("never stores the master secret or secrets in plain text", async () => {
    const db = fresh();
    const store = new CryptoStore(db);
    await store.saveMaster(ALICE, DEV, master());
    await store.putSecret("mls-client", new Uint8Array(64).fill(9));
    const raw = await new Promise<unknown[]>((resolve) => {
      const req = indexedDB.open(db, 1);
      req.onsuccess = () => {
        const out: unknown[] = [];
        const tx = req.result.transaction(["accounts", "secrets"]);
        tx.objectStore("accounts").getAll().onsuccess = (e) => out.push(...((e.target as IDBRequest).result as unknown[]));
        tx.objectStore("secrets").getAll().onsuccess = (e) => out.push(...((e.target as IDBRequest).result as unknown[]));
        tx.oncomplete = () => resolve(out);
      };
    });
    const bytes = (v: unknown): number[][] => {
      if (v instanceof ArrayBuffer) return [[...new Uint8Array(v)]];
      if (ArrayBuffer.isView(v)) return [[...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)]];
      if (v && typeof v === "object" && !(v instanceof CryptoKey)) return Object.values(v).flatMap(bytes);
      return [];
    };
    const all = raw.flatMap(bytes).map((b) => b.join(","));
    expect(all.some((b) => b.includes(Array(32).fill(7).join(",")))).toBe(false);
    expect(all.some((b) => b.includes(Array(64).fill(9).join(",")))).toBe(false);
    const key = (raw[0] as { key: CryptoKey }).key;
    expect(key.extractable).toBe(false);
  });

  it("with lock on close keeps the key only in memory; a new tab must unlock with the master secret", async () => {
    const db = fresh();
    const store = new CryptoStore(db);
    await store.saveMaster(ALICE, DEV, master());
    await store.putSecret("mls-client", new Uint8Array([4]));
    await store.setLockOnClose(true);
    expect(await store.lockOnClose(ALICE)).toBe(true);
    expect(store.isUnlocked(ALICE)).toBe(true);

    const tab2 = new CryptoStore(db);
    expect(await tab2.resume(ALICE)).toBe(false);
    expect(await tab2.status(ALICE)).toBe("locked");
    await expect(tab2.unlockWithMaster(ALICE, new Uint8Array(32).fill(8))).rejects.toBeInstanceOf(LocalKeyMismatchError);
    expect(tab2.isUnlocked()).toBe(false);
    await tab2.unlockWithMaster(ALICE, master());
    expect(await tab2.getSecret("mls-client")).toEqual(new Uint8Array([4]));

    await tab2.setLockOnClose(false);
    const tab3 = new CryptoStore(db);
    expect(await tab3.resume(ALICE)).toBe(true);
  });

  it("lock forgets the secret in memory; wipe deletes the account's data only", async () => {
    const db = fresh();
    const store = new CryptoStore(db);
    await store.saveMaster("bob@t.local", DEV, new Uint8Array(32).fill(1));
    await store.putSecret("x", new Uint8Array([1]));
    await store.saveMaster(ALICE, DEV, master());
    await store.putSecret("x", new Uint8Array([2]));
    store.lock();
    expect(store.isUnlocked()).toBe(false);
    expect(() => store.masterSecret()).toThrow();
    await expect(store.putSecret("y", new Uint8Array([1]))).rejects.toThrow();
    expect(await store.resume(ALICE)).toBe(true);
    await store.wipe(ALICE);
    expect(store.isUnlocked()).toBe(false);
    expect(await store.status(ALICE)).toBe("none");
    expect(await store.resume("bob@t.local")).toBe(true);
    expect(await store.getSecret("x")).toEqual(new Uint8Array([1]));
  });

  it("saving a new master secret (identity reset) replaces the old data", async () => {
    const db = fresh();
    const store = new CryptoStore(db);
    await store.saveMaster(ALICE, DEV, master());
    await store.putSecret("x", new Uint8Array([1]));
    await store.setLockOnClose(true);
    await store.saveMaster(ALICE, DEV, new Uint8Array(32).fill(3));
    expect(await store.getSecret("x")).toBeNull();
    expect(await store.lockOnClose(ALICE)).toBe(true);
    expect(store.masterSecret()).toEqual(new Uint8Array(32).fill(3));
  });

  it("a secret record cannot be moved to another name", async () => {
    const db = fresh();
    const store = new CryptoStore(db);
    await store.saveMaster(ALICE, DEV, master());
    await store.putSecret("a", new Uint8Array([5]));
    const moved = await new Promise<void>((resolve) => {
      const req = indexedDB.open(db, 1);
      req.onsuccess = () => {
        const tx = req.result.transaction("secrets", "readwrite");
        const os = tx.objectStore("secrets");
        os.get([ALICE, "a"]).onsuccess = (e) => {
          const rec = (e.target as IDBRequest).result as { name: string };
          os.put({ ...rec, name: "b" });
        };
        tx.oncomplete = () => resolve();
      };
    });
    void moved;
    await expect(store.getSecret("b")).rejects.toThrow();
  });
});
