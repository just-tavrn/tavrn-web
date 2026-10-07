// SPDX-License-Identifier: Apache-2.0
/**
 * IndexedDB storage of the local encrypted search index (`SearchIndex` of `@tavrn/e2ee`, design note 4.4
 * "Search"). Own database (`tavrn-search` by default) with one object store per `SearchStore`; keys are
 * strings, values the sealed bytes. The index already seals every value and turns every key into an HMAC
 * token, so this layer stores opaque data only.
 *
 * Several accounts can share the database: every key is prefixed with a per-account namespace,
 * `hex(SHA-256("tavrn search ns v1\0" + account))[0..16] + ":"`, so the account address is not stored
 * either. `keys`, `size` and `clear` act on the account's namespace only.
 */
import type { SearchBackend, SearchStore, SearchWrite } from "@tavrn/e2ee";

const STORES: readonly SearchStore[] = ["docs", "postings", "meta"];
const VERSION = 1;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  const req = indexedDB.open(name, VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
  };
  return promisify(req);
}

/** The key prefix of an account: 16 hex digits of a domain-separated SHA-256, never the address itself. */
export async function searchNamespace(account: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tavrn search ns v1\u0000${account}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 16)}:`;
}

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

export class IdbSearchBackend implements SearchBackend {
  private readonly ready: Promise<{ db: IDBDatabase; ns: string }>;

  constructor(account: string, dbName = "tavrn-search") {
    this.ready = Promise.all([openDb(dbName), searchNamespace(account)]).then(([db, ns]) => ({ db, ns }));
    // Avoid an unhandled rejection before the first call; every method awaits `ready` and sees the error.
    this.ready.catch(() => undefined);
  }

  private static range(ns: string): IDBKeyRange {
    // Every key of the namespace starts with `ns`; "￿" sorts after every character that follows it.
    return IDBKeyRange.bound(ns, `${ns}￿`);
  }

  async get(store: SearchStore, key: string): Promise<Uint8Array | null> {
    const { db, ns } = await this.ready;
    return toBytes(await promisify(db.transaction(store).objectStore(store).get(ns + key)));
  }

  async getMany(store: SearchStore, keys: string[]): Promise<(Uint8Array | null)[]> {
    if (keys.length === 0) return [];
    const { db, ns } = await this.ready;
    const os = db.transaction(store).objectStore(store);
    const values = await Promise.all(keys.map((k) => promisify(os.get(ns + k))));
    return values.map(toBytes);
  }

  async write(batch: SearchWrite[]): Promise<void> {
    if (batch.length === 0) return;
    const { db, ns } = await this.ready;
    const stores = [...new Set(batch.map((w) => w.store))];
    // Copy before the transaction starts (structured clone copies too, but the caller may reuse buffers meanwhile).
    const copies = batch.map((w) => ({ ...w, value: w.value ? w.value.slice() : null }));
    const tx = db.transaction(stores, "readwrite");
    const finished = done(tx);
    for (const w of copies) {
      const os = tx.objectStore(w.store);
      if (w.value) os.put(w.value, ns + w.key);
      else os.delete(ns + w.key);
    }
    await finished;
  }

  async keys(store: SearchStore): Promise<string[]> {
    const { db, ns } = await this.ready;
    const keys = await promisify(db.transaction(store).objectStore(store).getAllKeys(IdbSearchBackend.range(ns)));
    return keys.map((k) => String(k).slice(ns.length));
  }

  async size(): Promise<number> {
    const { db, ns } = await this.ready;
    const tx = db.transaction([...STORES]);
    let total = 0;
    await Promise.all(
      STORES.map(
        (s) =>
          new Promise<void>((resolve, reject) => {
            const req = tx.objectStore(s).openCursor(IdbSearchBackend.range(ns));
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) return resolve();
              total += toBytes(cursor.value)?.byteLength ?? 0;
              cursor.continue();
            };
          }),
      ),
    );
    return total;
  }

  async clear(): Promise<void> {
    const { db, ns } = await this.ready;
    const tx = db.transaction([...STORES], "readwrite");
    const finished = done(tx);
    for (const s of STORES) tx.objectStore(s).delete(IdbSearchBackend.range(ns));
    await finished;
  }

  /** Closes the database connection. */
  async close(): Promise<void> {
    (await this.ready).db.close();
  }
}
