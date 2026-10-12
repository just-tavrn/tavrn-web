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
 *
 * The desktop app keeps the persisted local key in the OS keychain instead (`platform().keystore`, docs/DESKTOP.md
 * "Keys in the OS keychain"): IndexedDB then holds ciphertext only, which opens nothing without the keychain entry.
 * The local key is the cleanest cut: one 32-byte secret per account fits every keychain (the MLS client state does
 * not: it grows with the groups), and everything else stays as in the browser. A store of the browser kind is
 * migrated on the first start (the key goes into the keychain, verified by reading it back, then the IndexedDB copy is
 * removed); a keychain that fails keeps or restores the browser's behaviour, which {@link CryptoStore.keyProtection}
 * reports for Settings → App.
 *
 * The Android app seals the local key behind fingerprint, face or PIN instead (`platform().unlock`, docs/ANDROID.md
 * "Unlock with fingerprint, face or PIN"): after an unlock the user may turn it on (the system's prompt), and the
 * IndexedDB copy is removed; the next start asks for the prompt (or the recovery key, the alternative) because the
 * shell opens the sealed key only right after the user authenticated. It is never migrated silently: storing needs
 * the prompt too.
 */
import { LocalKeyMismatchError, localAad, localStorageKey, type CryptoStatus, type KeyStore } from "@tavrn/e2ee";
import { STORE_ACCOUNTS, STORE_SECRETS, idbDelete, idbGet, idbPut, openDb } from "./idb";
import { platform } from "../platform";
import type { PlatformKeystore, PlatformUnlock, UnlockAvailability, UnlockPromptTexts } from "../platform/types";
import { UnlockError, asUnlockError, unlockErrorCode } from "../platform/unlockError";

export { LocalKeyMismatchError, type CryptoStatus };

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

interface AccountRecord {
  account: string;
  deviceId: string;
  lockOnClose: boolean;
  /** Persisted local key (the browser, or the desktop app without a keychain); absent with lock on close. */
  key?: CryptoKey;
  /** Desktop app: the local key is in the OS keychain. */
  keychain?: boolean;
  /** Android app: the local key is sealed behind fingerprint, face or PIN (the shell's Android Keystore). */
  biometric?: boolean;
  master: Sealed;
}

/**
 * Where the persisted local key of an account is: the OS keychain, IndexedDB because the keychain failed (desktop),
 * IndexedDB (browser), nowhere (lock on close), or there is no local data.
 */
export type KeyProtection = "keychain" | "biometric" | "fallback" | "browser" | "lock_on_close" | "none";

/**
 * The Android app's biometric unlock of an account (null elsewhere, or without local data): whether the phone can,
 * whether it is on, and whether the shell just found it invalidated (new biometrics, the screen lock removed), which
 * turned it off: the user unlocks once with the recovery key and may turn it on again.
 */
export interface BiometricState {
  available: UnlockAvailability;
  on: boolean;
  invalidated: boolean;
  lockOnClose: boolean;
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

/** Imports raw key bytes as a non-extractable AES key. */
function importLocalKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The IndexedDB {@link KeyStore} of the web client, with "lock on close". */
export class CryptoStore implements KeyStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private current: Unlocked | null = null;

  /** `keychain`: the OS keychain of the desktop app, `unlock`: the Android app's biometric unlock (undefined elsewhere). */
  constructor(
    private readonly dbName = "tavrn-crypto",
    private readonly keychain: () => PlatformKeystore | undefined = () => platform().keystore,
    private readonly unlock: () => PlatformUnlock | undefined = () => platform().unlock,
  ) {}

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
    if (!rec) return false;
    const key = rec.keychain ? await this.keyFromKeychain(account) : rec.key;
    if (!key) return false;
    let master: Uint8Array;
    try {
      master = await unseal(key, account, MASTER, rec.master);
    } catch {
      return false;
    }
    this.setCurrent({ account, deviceId: rec.deviceId, key, master });
    // Desktop app: a key still in IndexedDB (a store of the browser kind, or an earlier fallback) moves now.
    if (!rec.keychain && !rec.lockOnClose && this.keychain()) {
      const raw = await localStorageKey(master, rec.deviceId);
      try {
        if (await this.toKeychain(account, raw)) {
          delete rec.key;
          rec.keychain = true;
          await idbPut(await this.db(), STORE_ACCOUNTS, rec);
        }
      } finally {
        raw.fill(0);
      }
    }
    return true;
  }

  /** The local key from the keychain, or null (no entry, no keychain, or it failed). */
  private async keyFromKeychain(account: string): Promise<CryptoKey | null> {
    const kc = this.keychain();
    if (!kc) return null;
    let raw: Uint8Array | null;
    try {
      raw = await kc.get(account);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      return await importLocalKey(raw);
    } catch {
      return null;
    } finally {
      raw.fill(0);
    }
  }

  /** Stores the local key in the keychain and reads it back; false (nothing changes) when that does not work. */
  private async toKeychain(account: string, raw: Uint8Array): Promise<boolean> {
    const kc = this.keychain();
    if (!kc) return false;
    try {
      await kc.set(account, raw);
      const back = await kc.get(account);
      const ok = !!back && sameBytes(back, raw);
      back?.fill(0);
      return ok;
    } catch {
      return false;
    }
  }

  /** Persists the local key of `rec`: in the keychain when there is one that works, else in IndexedDB. */
  private async persistKey(rec: AccountRecord, raw: Uint8Array, key: CryptoKey): Promise<void> {
    if (await this.toKeychain(rec.account, raw)) {
      rec.keychain = true;
      delete rec.key;
    } else {
      delete rec.keychain;
      rec.key = key;
    }
  }

  /** Removes the account's keychain entry; never fails (sign-out and lock on close must not depend on it). */
  private async dropKeychainEntry(account: string): Promise<void> {
    try {
      await this.keychain()?.delete(account);
    } catch {
      /* the entry stays until the next save replaces it or the user removes it */
    }
  }

  /** Where the persisted local key of the account is (Settings → App of the desktop app). */
  async keyProtection(account: string): Promise<KeyProtection> {
    const rec = await this.record(account);
    if (!rec) return "none";
    if (rec.lockOnClose) return "lock_on_close";
    if (rec.biometric) return "biometric";
    if (rec.keychain) return "keychain";
    return this.keychain() ? "fallback" : "browser";
  }

  /**
   * Stores a master secret for this device (registration, first unlock on a new device, identity
   * reset) and unlocks. Replaces any earlier data of the account, including its named secrets.
   */
  async saveMaster(account: string, deviceId: string, master: Uint8Array, opts: { lockOnClose?: boolean } = {}): Promise<void> {
    const previous = await this.record(account);
    const lockOnClose = opts.lockOnClose ?? previous?.lockOnClose ?? false;
    if (previous) await this.wipe(account);
    const raw = await localStorageKey(master, deviceId);
    try {
      const key = await importLocalKey(raw);
      const rec: AccountRecord = { account, deviceId, lockOnClose, master: await seal(key, account, MASTER, master) };
      if (!lockOnClose) await this.persistKey(rec, raw, key);
      await idbPut(await this.db(), STORE_ACCOUNTS, rec);
      this.setCurrent({ account, deviceId, key, master: master.slice() });
    } finally {
      raw.fill(0);
    }
  }

  /**
   * Unlocks existing local data with the master secret from the secret storage (lock on close, new
   * tab). Throws {@link LocalKeyMismatchError} if it does not open the data.
   */
  async unlockWithMaster(account: string, master: Uint8Array): Promise<void> {
    const rec = await this.record(account);
    if (!rec) throw new Error("no local data for this account");
    const raw = await localStorageKey(master, rec.deviceId);
    try {
      const key = await importLocalKey(raw);
      let stored: Uint8Array;
      try {
        stored = await unseal(key, account, MASTER, rec.master);
      } catch {
        throw new LocalKeyMismatchError();
      }
      stored.fill(0);
      this.setCurrent({ account, deviceId: rec.deviceId, key, master: master.slice() });
      // Desktop app: the keychain entry was missing or unreadable; store it again (or fall back to IndexedDB). A key
      // stored nowhere (the biometric unlock turned off while locked, or invalidated) goes back to IndexedDB.
      if (!rec.lockOnClose && !rec.biometric && (rec.keychain || !rec.key)) {
        await this.persistKey(rec, raw, key);
        await idbPut(await this.db(), STORE_ACCOUNTS, rec);
      }
    } finally {
      raw.fill(0);
    }
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
    await this.dropKeychainEntry(account);
    await this.dropBiometric(account);
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
    if (on) {
      delete rec.key;
      if (rec.keychain) await this.dropKeychainEntry(cur.account);
      delete rec.keychain;
      if (rec.biometric) await this.dropBiometric(cur.account);
      delete rec.biometric;
    } else {
      const raw = await localStorageKey(cur.master, cur.deviceId);
      try {
        await this.persistKey(rec, raw, cur.key);
      } finally {
        raw.fill(0);
      }
    }
    await idbPut(await this.db(), STORE_ACCOUNTS, rec);
  }

  /** Removes the account's sealed key in the Android app; never fails (sign-out must not depend on it). */
  private async dropBiometric(account: string): Promise<void> {
    try {
      await this.unlock()?.clear(account);
    } catch {
      /* the next store replaces it; an orphaned blob opens nothing without its record */
    }
  }

  /**
   * The Android app's biometric unlock of `account` (null elsewhere or without local data). A record that says "on"
   * while the shell has nothing usable any more (invalidated, or gone) is turned off here.
   */
  async biometricState(account: string): Promise<BiometricState | null> {
    const u = this.unlock();
    if (!u) return null;
    const rec = await this.record(account);
    if (!rec) return null;
    let status;
    try {
      status = await u.status(account);
    } catch {
      return { available: "unavailable", on: !!rec.biometric, invalidated: false, lockOnClose: rec.lockOnClose };
    }
    let invalidated = false;
    if (rec.biometric && status.stored !== "ready") {
      invalidated = status.stored === "invalidated";
      delete rec.biometric;
      await idbPut(await this.db(), STORE_ACCOUNTS, rec);
    }
    return { available: status.available, on: !!rec.biometric, invalidated, lockOnClose: rec.lockOnClose };
  }

  /**
   * Android app: seals the open account's local key behind fingerprint, face or PIN (the system's prompt shows
   * `prompt`) and removes it from IndexedDB; turns "lock on close" off. Rejects with an {@link UnlockError}
   * (`cancelled`: nothing changed).
   */
  async enableBiometric(prompt: UnlockPromptTexts): Promise<void> {
    const cur = this.require();
    const u = this.unlock();
    if (!u) throw new UnlockError("unavailable");
    const rec = await this.record(cur.account);
    if (!rec) throw new Error("no local data for this account");
    const raw = await localStorageKey(cur.master, cur.deviceId);
    try {
      await u.store(cur.account, raw, prompt).catch(asUnlockError);
    } finally {
      raw.fill(0);
    }
    delete rec.key;
    delete rec.keychain;
    rec.lockOnClose = false;
    rec.biometric = true;
    await idbPut(await this.db(), STORE_ACCOUNTS, rec);
  }

  /**
   * Android app: turns the biometric unlock off and wipes the sealed key. An open store keeps its key in IndexedDB
   * again (as in a browser); a locked one stores it there at the next unlock with the recovery key or a passkey.
   */
  async disableBiometric(account: string): Promise<void> {
    await this.unlock()?.clear(account);
    const rec = await this.record(account);
    if (!rec) return;
    delete rec.biometric;
    if (this.current?.account === account && !rec.lockOnClose) rec.key = this.current.key;
    await idbPut(await this.db(), STORE_ACCOUNTS, rec);
  }

  /**
   * Android app: opens the store with the sealed key after the system's prompt. Rejects with an {@link UnlockError};
   * `invalidated` (the shell wiped the key, or it did not open this store) turns the biometric unlock off.
   */
  async unlockWithBiometric(account: string, prompt: UnlockPromptTexts): Promise<void> {
    const u = this.unlock();
    const rec = await this.record(account);
    if (!u) throw new UnlockError("unavailable");
    if (!rec?.biometric) throw new UnlockError("none");
    const off = async () => {
      delete rec.biometric;
      await idbPut(await this.db(), STORE_ACCOUNTS, rec);
    };
    let raw: Uint8Array;
    try {
      raw = await u.get(account, prompt);
    } catch (e) {
      const code = unlockErrorCode(e);
      if (code === "invalidated" || code === "none") await off();
      throw new UnlockError(code === "none" ? "invalidated" : code);
    }
    let key: CryptoKey;
    let master: Uint8Array;
    try {
      key = await importLocalKey(raw);
      master = await unseal(key, account, MASTER, rec.master);
    } catch {
      await this.dropBiometric(account);
      await off();
      throw new UnlockError("invalidated");
    } finally {
      raw.fill(0);
    }
    this.setCurrent({ account, deviceId: rec.deviceId, key, master });
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
