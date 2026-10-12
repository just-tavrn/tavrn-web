// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * The local key store with the Android app's biometric unlock (docs/ANDROID.md "Unlock with fingerprint, face or PIN"):
 * the local storage key is sealed by the shell behind the system's prompt and removed from IndexedDB, the store then
 * opens only through the prompt (or the recovery key), and an invalidated key turns the unlock off.
 */
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { CryptoStore } from "./store";
import { initCryptoForTests } from "../test/wasm";
import type { PlatformUnlock, UnlockAvailability, UnlockPromptTexts, UnlockStatus } from "../platform/types";
import { UnlockError } from "../platform/unlockError";

const ALICE = "alice@t.local";
const DEV = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const master = () => new Uint8Array(32).fill(7);
const PROMPT: UnlockPromptTexts = { title: "Unlock", subtitle: ALICE };
let n = 0;
const fresh = () => `biometric-db-${++n}`;

beforeAll(() => initCryptoForTests());

/** The shell's sealed keys in memory: `next` makes the next prompt end with that code, `invalidate` acts as Android does. */
class FakeUnlock implements PlatformUnlock {
  entries = new Map<string, Uint8Array>();
  invalidated = new Set<string>();
  available: UnlockAvailability = "ready";
  next: string | null = null;
  calls: string[] = [];
  prompts: UnlockPromptTexts[] = [];
  private prompt(p: UnlockPromptTexts) {
    this.prompts.push(p);
    const code = this.next;
    this.next = null;
    if (code) throw `unlock.${code}`;
  }
  async status(account?: string): Promise<UnlockStatus> {
    this.calls.push("status");
    const stored = account && this.invalidated.has(account) ? "invalidated" : account && this.entries.has(account) ? "ready" : "none";
    if (account) this.wipeInvalid(account);
    return { available: this.available, stored };
  }
  async store(account: string, secret: Uint8Array, p: UnlockPromptTexts) {
    this.calls.push("store");
    if (secret.length !== 32) throw "unlock.invalid";
    this.entries.delete(account);
    this.prompt(p);
    this.entries.set(account, secret.slice());
  }
  async get(account: string, p: UnlockPromptTexts) {
    this.calls.push("get");
    if (this.invalidated.has(account)) {
      this.wipeInvalid(account);
      throw "unlock.invalidated";
    }
    const secret = this.entries.get(account);
    if (!secret) throw "unlock.none";
    this.prompt(p);
    return secret.slice();
  }
  async clear(account: string) {
    this.calls.push("clear");
    this.entries.delete(account);
    this.invalidated.delete(account);
  }
  invalidate(account: string) {
    this.invalidated.add(account);
  }
  private wipeInvalid(account: string) {
    if (this.invalidated.delete(account)) this.entries.delete(account);
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

/** A store with Alice's data, the key in IndexedDB as in a browser (the first unlock on the phone). */
async function setUp(u: FakeUnlock, db = fresh()) {
  const store = new CryptoStore(db, () => undefined, () => u);
  await store.saveMaster(ALICE, DEV, master());
  await store.putSecret("mls-client", new Uint8Array([1, 2, 3]));
  return { db, store, restart: () => new CryptoStore(db, () => undefined, () => u) };
}

const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("CryptoStore with the Android app's biometric unlock", () => {
  it("is not turned on by itself: the first unlock keeps the key in IndexedDB and offers it", async () => {
    const u = new FakeUnlock();
    const { db, store } = await setUp(u);
    expect(u.calls).not.toContain("store");
    expect((await record(db, ALICE)).key).toBeDefined();
    expect(await store.keyProtection(ALICE)).toBe("browser");
    expect(await store.biometricState(ALICE)).toEqual({ available: "ready", on: false, invalidated: false, lockOnClose: false });
  });

  it("seals the local key behind the prompt, removes it from IndexedDB and opens only through the prompt", async () => {
    const u = new FakeUnlock();
    const { db, store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    expect(u.prompts).toEqual([PROMPT]);
    expect(u.entries.get(ALICE)?.length).toBe(32);
    const rec = await record(db, ALICE);
    expect(rec.key).toBeUndefined();
    expect(rec.biometric).toBe(true);
    expect(await store.keyProtection(ALICE)).toBe("biometric");

    const next = restart();
    expect(await next.resume(ALICE)).toBe(false);
    expect(await next.status(ALICE)).toBe("locked");
    expect(await next.biometricState(ALICE)).toEqual({ available: "ready", on: true, invalidated: false, lockOnClose: false });
    await next.unlockWithBiometric(ALICE, PROMPT);
    expect(next.masterSecret()).toEqual(master());
    expect(await next.getSecret("mls-client")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("changes nothing when the user cancels the prompt of turning it on", async () => {
    const u = new FakeUnlock();
    const { db, store, restart } = await setUp(u);
    u.next = "cancelled";
    const e = await rejection(store.enableBiometric(PROMPT));
    expect(e).toBeInstanceOf(UnlockError);
    expect((e as UnlockError).code).toBe("cancelled");
    expect((await record(db, ALICE)).biometric).toBeUndefined();
    expect(await restart().resume(ALICE)).toBe(true);
  });

  it("stays locked and on when the user cancels the unlock prompt; a lockout says so", async () => {
    const u = new FakeUnlock();
    const { store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    const next = restart();
    for (const code of ["cancelled", "lockout"]) {
      u.next = code;
      expect(((await rejection(next.unlockWithBiometric(ALICE, PROMPT))) as UnlockError).code).toBe(code);
      expect(next.isUnlocked()).toBe(false);
      expect((await next.biometricState(ALICE))?.on).toBe(true);
    }
  });

  it("turns itself off when Android invalidated the key; the recovery key puts the key back into IndexedDB", async () => {
    const u = new FakeUnlock();
    const { db, store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    u.invalidate(ALICE);
    const next = restart();
    expect(((await rejection(next.unlockWithBiometric(ALICE, PROMPT))) as UnlockError).code).toBe("invalidated");
    expect((await record(db, ALICE)).biometric).toBeUndefined();
    expect(u.entries.has(ALICE)).toBe(false);
    expect(await next.biometricState(ALICE)).toEqual({ available: "ready", on: false, invalidated: false, lockOnClose: false });
    // The alternative: the master secret (recovery key or passkey).
    await next.unlockWithMaster(ALICE, master());
    expect((await record(db, ALICE)).key).toBeDefined();
    expect(await restart().resume(ALICE)).toBe(true);
  });

  it("reports an invalidated key once, before any prompt (the unlock dialog's notice)", async () => {
    const u = new FakeUnlock();
    const { store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    u.invalidate(ALICE);
    const next = restart();
    expect(await next.biometricState(ALICE)).toEqual({ available: "ready", on: false, invalidated: true, lockOnClose: false });
    expect(u.calls).not.toContain("get");
    expect(await next.keyProtection(ALICE)).toBe("browser");
  });

  it("refuses a sealed key that does not open this store and wipes it", async () => {
    const u = new FakeUnlock();
    const { store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    u.entries.set(ALICE, new Uint8Array(32).fill(1));
    const next = restart();
    expect(((await rejection(next.unlockWithBiometric(ALICE, PROMPT))) as UnlockError).code).toBe("invalidated");
    expect(next.isUnlocked()).toBe(false);
    expect(u.entries.has(ALICE)).toBe(false);
    expect((await next.biometricState(ALICE))?.on).toBe(false);
  });

  it("keeps it on when the user takes the recovery key instead (the alternative)", async () => {
    const u = new FakeUnlock();
    const { db, store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    const next = restart();
    await next.unlockWithMaster(ALICE, master());
    const rec = await record(db, ALICE);
    expect(rec.biometric).toBe(true);
    expect(rec.key).toBeUndefined();
    expect(u.entries.has(ALICE)).toBe(true);
  });

  it("turned off while open: the sealed key is wiped and the key is in IndexedDB again", async () => {
    const u = new FakeUnlock();
    const { db, store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    await store.disableBiometric(ALICE);
    expect(u.entries.has(ALICE)).toBe(false);
    const rec = await record(db, ALICE);
    expect(rec.biometric).toBeUndefined();
    expect(rec.key).toBeDefined();
    expect(await restart().resume(ALICE)).toBe(true);
  });

  it("turned off while locked: nothing is stored until the next unlock with the master secret", async () => {
    const u = new FakeUnlock();
    const { db, store, restart } = await setUp(u);
    await store.enableBiometric(PROMPT);
    const locked = restart();
    await locked.disableBiometric(ALICE);
    expect(u.entries.has(ALICE)).toBe(false);
    expect(await restart().resume(ALICE)).toBe(false);
    await locked.unlockWithMaster(ALICE, master());
    expect((await record(db, ALICE)).key).toBeDefined();
    expect(await restart().resume(ALICE)).toBe(true);
  });

  it("is wiped on sign-out and by lock on close; turning it on turns lock on close off", async () => {
    const u = new FakeUnlock();
    const { db, store } = await setUp(u);
    await store.setLockOnClose(true);
    expect((await store.biometricState(ALICE))?.lockOnClose).toBe(true);
    await store.enableBiometric(PROMPT);
    expect((await record(db, ALICE)).lockOnClose).toBe(false);
    await store.setLockOnClose(true);
    expect(u.entries.has(ALICE)).toBe(false);
    expect((await record(db, ALICE)).biometric).toBeUndefined();
    await store.setLockOnClose(false);
    await store.enableBiometric(PROMPT);
    await store.wipe(ALICE);
    expect(u.entries.has(ALICE)).toBe(false);
    expect(await record(db, ALICE)).toBeUndefined();
  });

  it("is a new start after a new master secret (identity reset, setup)", async () => {
    const u = new FakeUnlock();
    const { store } = await setUp(u);
    await store.enableBiometric(PROMPT);
    await store.saveMaster(ALICE, DEV, new Uint8Array(32).fill(9));
    expect(u.entries.has(ALICE)).toBe(false);
    expect((await store.biometricState(ALICE))?.on).toBe(false);
  });

  it("does not exist in a browser or the desktop app", async () => {
    const db = fresh();
    const store = new CryptoStore(db, () => undefined, () => undefined);
    await store.saveMaster(ALICE, DEV, master());
    expect(await store.biometricState(ALICE)).toBeNull();
    expect(((await rejection(store.enableBiometric(PROMPT))) as UnlockError).code).toBe("unavailable");
    await store.wipe(ALICE);
  });

  it("reports the phone's availability without changing anything", async () => {
    const u = new FakeUnlock();
    u.available = "no_lock";
    const { store } = await setUp(u);
    expect(await store.biometricState(ALICE)).toEqual({ available: "no_lock", on: false, invalidated: false, lockOnClose: false });
    expect(await new CryptoStore(fresh(), () => undefined, () => u).biometricState(ALICE)).toBeNull();
  });
});
