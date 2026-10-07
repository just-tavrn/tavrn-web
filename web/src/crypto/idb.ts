// SPDX-License-Identifier: Apache-2.0
/** Minimal promise wrapper around IndexedDB for the crypto store (two object stores, no indexes). */

export const STORE_ACCOUNTS = "accounts";
export const STORE_SECRETS = "secrets";

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb(name: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_ACCOUNTS)) db.createObjectStore(STORE_ACCOUNTS, { keyPath: "account" });
    if (!db.objectStoreNames.contains(STORE_SECRETS)) db.createObjectStore(STORE_SECRETS, { keyPath: ["account", "name"] });
  };
  return promisify(req);
}

export async function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return (await promisify(db.transaction(store).objectStore(store).get(key))) as T | undefined;
}

export async function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await done(tx);
}

export async function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey | IDBKeyRange): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await done(tx);
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}
