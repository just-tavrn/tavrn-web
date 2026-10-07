// SPDX-License-Identifier: Apache-2.0
/**
 * Local crypto storage of the web client (design note 5.1 "Local storage and lock on close"), the browser
 * implementation of `KeyStore` from `@tavrn/e2ee`.
 *
 * Per account (user address) IndexedDB holds the master secret and named secrets (the exported MLS
 * client state, which contains the device key, and whatever part C2 adds), all encrypted with
 * AES-256-GCM under the *local storage key* = `MasterSecret.localStorageKey(deviceId)`. The local key
 * is a non-extractable WebCrypto key. By default it is persisted next to the data, so the device
 * unlocks by itself; with "lock on close" it lives only in this module's memory and every new tab
 * or browser start has to unlock with the recovery key or a passkey (which yield the master secret).
 */
import { LocalKeyMismatchError, localAad, localStorageKey, type CryptoStatus, type KeyStore } from "@tavrn/e2ee";
import { STORE_ACCOUNTS, STORE_SECRETS, idbDelete, idbGet, idbPut, openDb } from "./idb";

export { LocalKeyMismatchError, type CryptoStatus };

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

interface AccountRecord {
  account: string;
  deviceId: string;
  lockOnClose: boolean;
  /** Persisted local key; absent with lock on close. */
  key?: CryptoKey;
  master: Sealed;
}

interface SecretRecord {
  account: string;
  name: string;
  value: Sealed;
}

interface Unlocked {
  account: string;
  deviceId: string;
  key: CryptoKey;
  master: Uint8Array;
}

const MASTER = "master";

async function seal(key: CryptoKey, account: string, name: string, plain: Uint8Array): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: localAad(account, name) }, key, plain as Uint8Array<ArrayBuffer>);
  return { iv, data };
}

async function unseal(key: CryptoKey, account: string, name: string, sealed: Sealed): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: localAad(account, name) }, key, sealed.data);
  return new Uint8Array(plain);
}

/** Derives the local storage key of `deviceId` from the master secret as a non-extractable AES key. */
async function deriveLocalKey(master: Uint8Array, deviceId: string): Promise<CryptoKey> {
  const raw = await localStorageKey(master, deviceId);
  try {
    return await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** The IndexedDB {@link KeyStore} of the web client, with "lock on close". */
export class CryptoStore implements KeyStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private current: Unlocked | null = null;

  constructor(private readonly dbName = "tavrn-crypto") {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(this.dbName).catch((e: unknown) => {
      this.dbPromise = null;
      throw e;
    });
    return this.dbPromise;
  }

  private async record(account: string): Promise<AccountRecord | undefined> {
    return idbGet<AccountRecord>(await this.db(), STORE_ACCOUNTS, account);
  }

  private require(): Unlocked {
    if (!this.current) throw new Error("crypto store is locked");
    return this.current;
  }

  /** Whether this device holds the account's master secret, and whether it is readable right now. */
  async status(account: string): Promise<CryptoStatus> {
    if (this.current?.account === account) return "unlocked";
    const rec = await this.record(account);
    if (!rec) return "none";
    return "locked";
  }

  /** Device id the account's local data belongs to, or null if there is none. */
  async deviceIdOf(account: string): Promise<string | null> {
    return (await this.record(account))?.deviceId ?? null;
  }

  /** Opens the store with the persisted local key (no user interaction); false if locked or empty. */
  async resume(account: string): Promise<boolean> {
    if (this.current?.account === account) return true;
    const rec = await this.record(account);
    if (!rec?.key) return false;
    try {
      const master = await unseal(rec.key, account, MASTER, rec.master);
      this.setCurrent({ account, deviceId: rec.deviceId, key: rec.key, master });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stores a master secret for this device (registration, first unlock on a new device, identity
   * reset) and unlocks. Replaces any earlier data of the account, including its named secrets.
   */
  async saveMaster(account: string, deviceId: string, master: Uint8Array, opts: { lockOnClose?: boolean } = {}): Promise<void> {
    const previous = await this.record(account);
    const lockOnClose = opts.lockOnClose ?? previous?.lockOnClose ?? false;
    if (previous) await this.wipe(account);
    const key = await deriveLocalKey(master, deviceId);
    const rec: AccountRecord = { account, deviceId, lockOnClose, master: await seal(key, account, MASTER, master) };
    if (!lockOnClose) rec.key = key;
    await idbPut(await this.db(), STORE_ACCOUNTS, rec);
    this.setCurrent({ account, deviceId, key, master: master.slice() });
  }

  /**
   * Unlocks existing local data with the master secret from the secret storage (lock on close, new
   * tab). Throws {@link LocalKeyMismatchError} if it does not open the data.
   */
  async unlockWithMaster(account: string, master: Uint8Array): Promise<void> {
    const rec = await this.record(account);
    if (!rec) throw new Error("no local data for this account");
    const key = await deriveLocalKey(master, rec.deviceId);
    let stored: Uint8Array;
    try {
      stored = await unseal(key, account, MASTER, rec.master);
    } catch {
      throw new LocalKeyMismatchError();
    }
    stored.fill(0);
    this.setCurrent({ account, deviceId: rec.deviceId, key, master: master.slice() });
  }

  isUnlocked(account?: string): boolean {
    return !!this.current && (account === undefined || this.current.account === account);
  }

  /** Forgets the key and the master secret in memory (data stays on disk). */
  lock(): void {
    this.current?.master.fill(0);
    this.current = null;
  }

  /** Deletes all local data of the account (logout) and locks if it was open. */
  async wipe(account: string): Promise<void> {
    if (this.current?.account === account) this.lock();
    const db = await this.db();
    await idbDelete(db, STORE_ACCOUNTS, account);
    await idbDelete(db, STORE_SECRETS, IDBKeyRange.bound([account, ""], [account, "￿"]));
  }

  async lockOnClose(account: string): Promise<boolean> {
    return (await this.record(account))?.lockOnClose ?? false;
  }

  /** Switches "lock on close" for the open account: removes or persists the local key. */
  async setLockOnClose(on: boolean): Promise<void> {
    const cur = this.require();
    const rec = await this.record(cur.account);
    if (!rec) throw new Error("no local data for this account");
    rec.lockOnClose = on;
    if (on) delete rec.key;
    else rec.key = cur.key;
    await idbPut(await this.db(), STORE_ACCOUNTS, rec);
  }

  /** Account address of the open store, or null. */
  account(): string | null {
    return this.current?.account ?? null;
  }

  deviceId(): string {
    return this.require().deviceId;
  }

  /** A copy of the 32-byte master secret; the caller should `fill(0)` it after use. */
  masterSecret(): Uint8Array {
    return this.require().master.slice();
  }

  /** Stores a named secret (e.g. `mls-client`) encrypted under the local key. */
  async putSecret(name: string, value: Uint8Array): Promise<void> {
    const cur = this.require();
    const rec: SecretRecord = { account: cur.account, name, value: await seal(cur.key, cur.account, name, value) };
    await idbPut(await this.db(), STORE_SECRETS, rec);
  }

  async getSecret(name: string): Promise<Uint8Array | null> {
    const cur = this.require();
    const rec = await idbGet<SecretRecord>(await this.db(), STORE_SECRETS, [cur.account, name]);
    return rec ? unseal(cur.key, cur.account, name, rec.value) : null;
  }

  async deleteSecret(name: string): Promise<void> {
    const cur = this.require();
    await idbDelete(await this.db(), STORE_SECRETS, [cur.account, name]);
  }

  private setCurrent(next: Unlocked) {
    if (this.current && this.current !== next) this.current.master.fill(0);
    this.current = next;
  }
}

/** The store of this browser. */
export const cryptoStore = new CryptoStore();
