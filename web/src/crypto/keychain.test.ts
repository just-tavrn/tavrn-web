// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * The local key store with the OS keychain of the desktop app (docs/DESKTOP.md "Keys in the OS keychain"): the local
 * storage key lives in the keychain instead of IndexedDB, an existing store is migrated on the first start, and a
 * missing or failing keychain falls back to the browser's behaviour, visibly (`keyProtection`).
 */
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { CryptoStore } from "./store";
import { initCryptoForTests } from "../test/wasm";
import type { KeychainStatus, PlatformKeystore } from "../platform/types";

const ALICE = "alice@t.local";
const DEV = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const master = () => new Uint8Array(32).fill(7);
let n = 0;
const fresh = () => `keychain-db-${++n}`;

beforeAll(() => initCryptoForTests());

/** An in-memory keychain like the shell's (32-byte values); `failing` makes every call throw, `dropWrites` loses them. */
class FakeKeychain implements PlatformKeystore {
  entries = new Map<string, Uint8Array>();
  failing = false;
  dropWrites = false;
  calls: string[] = [];
  private check(op: string) {
    this.calls.push(op);
    if (this.failing) throw "keychain.unavailable";
  }
  async status(): Promise<KeychainStatus> {
    return { backend: "memory", available: !this.failing };
  }
  async get(account: string) {
    this.check("get");
    return this.entries.get(account)?.slice() ?? null;
  }
  async set(account: string, secret: Uint8Array) {
    this.check("set");
    if (secret.length !== 32) throw "keychain.invalid";
    if (!this.dropWrites) this.entries.set(account, secret.slice());
  }
  async delete(account: string) {
    this.check("delete");
    this.entries.delete(account);
  }
}

async function record(db: string, account: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const get = req.result.transaction("accounts").objectStore("accounts").get(account);
      get.onsuccess = () => {
        resolve(get.result as Record<string, unknown>);
        req.result.close();
      };
    };
  });
}

describe("CryptoStore with the OS keychain", () => {
  it("keeps the local key in the keychain, not in IndexedDB, and resumes from it", async () => {
    const db = fresh();
    const kc = new FakeKeychain();
    const store = new CryptoStore(db, () => kc);
    await store.saveMaster(ALICE, DEV, master());
    await store.putSecret("mls-client", new Uint8Array([1, 2, 3]));
    expect(kc.entries.get(ALICE)?.length).toBe(32);
    const rec = await record(db, ALICE);
    expect(rec.key).toBeUndefined();
    expect(rec.keychain).toBe(true);
    expect(await store.keyProtection(ALICE)).toBe("keychain");

    const restart = new CryptoStore(db, () => kc);
    expect(await restart.resume(ALICE)).toBe(true);
    expect(restart.masterSecret()).toEqual(master());
    expect(await restart.getSecret("mls-client")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("without the keychain entry the store stays locked until the master secret unlocks it, which puts the entry back", async () => {
    const db = fresh();
    const kc = new FakeKeychain();
    await new CryptoStore(db, () => kc).saveMaster(ALICE, DEV, master());
    kc.entries.clear();

    const restart = new CryptoStore(db, () => kc);
    expect(await restart.resume(ALICE)).toBe(false);
    expect(await restart.status(ALICE)).toBe("locked");
    await restart.unlockWithMaster(ALICE, master());
    expect(kc.entries.has(ALICE)).toBe(true);
    expect(await new CryptoStore(db, () => kc).resume(ALICE)).toBe(true);
  });

  it("migrates a store of the browser kind on the first start: the key moves into the keychain", async () => {
    const db = fresh();
    await new CryptoStore(db, () => undefined).saveMaster(ALICE, DEV, master());
    expect((await record(db, ALICE)).key).toBeDefined();

    const kc = new FakeKeychain();
    const first = new CryptoStore(db, () => kc);
    expect(await first.resume(ALICE)).toBe(true);
    expect(kc.entries.get(ALICE)?.length).toBe(32);
    expect(kc.calls).toEqual(["set", "get"]);
    const rec = await record(db, ALICE);
    expect(rec.key).toBeUndefined();
    expect(rec.keychain).toBe(true);
    expect(await first.keyProtection(ALICE)).toBe("keychain");

    const second = new CryptoStore(db, () => kc);
    expect(await second.resume(ALICE)).toBe(true);
    expect(second.masterSecret()).toEqual(master());
  });

  it("keeps the IndexedDB key when the keychain fails or loses the write, and shows the fallback", async () => {
    const db = fresh();
    await new CryptoStore(db, () => undefined).saveMaster(ALICE, DEV, master());
    const kc = new FakeKeychain();
    kc.failing = true;
    const failing = new CryptoStore(db, () => kc);
    expect(await failing.resume(ALICE)).toBe(true);
    expect((await record(db, ALICE)).key).toBeDefined();
    expect(await failing.keyProtection(ALICE)).toBe("fallback");

    kc.failing = false;
    kc.dropWrites = true;
    const dropping = new CryptoStore(db, () => kc);
    expect(await dropping.resume(ALICE)).toBe(true);
    expect((await record(db, ALICE)).key).toBeDefined();
    expect(await dropping.keyProtection(ALICE)).toBe("fallback");

    // The keychain works again: the next start moves the key.
    kc.dropWrites = false;
    expect(await new CryptoStore(db, () => kc).resume(ALICE)).toBe(true);
    expect((await record(db, ALICE)).key).toBeUndefined();
  });

  it("falls back to IndexedDB when the keychain is unavailable while saving", async () => {
    const db = fresh();
    const kc = new FakeKeychain();
    kc.failing = true;
    const store = new CryptoStore(db, () => kc);
    await store.saveMaster(ALICE, DEV, master());
    expect(await store.keyProtection(ALICE)).toBe("fallback");
    expect(await new CryptoStore(db, () => kc).resume(ALICE)).toBe(true);
  });

  it("an unreadable keychain at start locks the store; unlocking then falls back when the keychain still fails", async () => {
    const db = fresh();
    const kc = new FakeKeychain();
    await new CryptoStore(db, () => kc).saveMaster(ALICE, DEV, master());
    kc.failing = true;
    const restart = new CryptoStore(db, () => kc);
    expect(await restart.resume(ALICE)).toBe(false);
    await restart.unlockWithMaster(ALICE, master());
    expect(await restart.keyProtection(ALICE)).toBe("fallback");
    expect(await new CryptoStore(db, () => kc).resume(ALICE)).toBe(true);
  });

  it("lock on close removes the keychain entry; turning it off stores it again", async () => {
    const db = fresh();
    const kc = new FakeKeychain();
    const store = new CryptoStore(db, () => kc);
    await store.saveMaster(ALICE, DEV, master());
    await store.setLockOnClose(true);
    expect(kc.entries.has(ALICE)).toBe(false);
    expect((await record(db, ALICE)).key).toBeUndefined();
    expect(await store.keyProtection(ALICE)).toBe("lock_on_close");
    expect(await new CryptoStore(db, () => kc).resume(ALICE)).toBe(false);

    await store.setLockOnClose(false);
    expect(kc.entries.has(ALICE)).toBe(true);
    expect(await store.keyProtection(ALICE)).toBe("keychain");
    expect(await new CryptoStore(db, () => kc).resume(ALICE)).toBe(true);
  });

  it("sign-out (wipe) deletes the keychain entry with the data", async () => {
    const db = fresh();
    const kc = new FakeKeychain();
    const store = new CryptoStore(db, () => kc);
    await store.saveMaster(ALICE, DEV, master());
    await store.wipe(ALICE);
    expect(kc.entries.size).toBe(0);
    expect(await store.keyProtection(ALICE)).toBe("none");
    // A failing keychain does not block the sign-out.
    await store.saveMaster(ALICE, DEV, master());
    kc.failing = true;
    await expect(store.wipe(ALICE)).resolves.toBeUndefined();
    expect(await store.status(ALICE)).toBe("none");
  });

  it("the browser keeps its behaviour", async () => {
    const db = fresh();
    const store = new CryptoStore(db, () => undefined);
    await store.saveMaster(ALICE, DEV, master());
    expect((await record(db, ALICE)).key).toBeDefined();
    expect(await store.keyProtection(ALICE)).toBe("browser");
  });
});
