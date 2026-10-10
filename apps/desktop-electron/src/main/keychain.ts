// SPDX-License-Identifier: Apache-2.0
/**
 * The OS keychain (docs/DESKTOP.md "Keys in the OS keychain", the Tauri shell's `keychain.rs`): the client's local key
 * store (IndexedDB) is encrypted with a *local storage key*; in the app that key lives here, so the files of the
 * renderer alone open nothing.
 *
 * Entries: `local-key/<home node origin>/<account address>`. The node part is never taken from the client: it is the
 * home node of the settings file, so the page can only reach the entries of the node it talks to. Values are exactly 32
 * bytes (an AES-256 key). Only the main window's bundled client can call the handlers (`ipc.ts`).
 *
 * Storage: Electron's `safeStorage`, whose key Chromium keeps in the desktop's keyring (the Secret Service through
 * libsecret: GNOME Keyring, KeePassXC, KWallet's Secret Service; KWallet directly on KDE), and the encrypted entries in
 * `keychain.json` of the profile directory. The file alone opens nothing; the key never leaves the keyring except into
 * this process. Chromium's fallback without a keyring (a fixed, built-in key; ciphertext prefix `v10`) protects nothing,
 * so it counts as no keychain at all: only `v11` ciphertext (a key from the keyring) is ever written.
 *
 * `TAVRN_DESKTOP_KEYCHAIN=memory` keeps the entries in memory for this process only (tests); `=unavailable` behaves
 * like a session without a keyring (the fallback). Neither weakens anything: the keys are then not persisted at all.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "./config.ts";
import { check, type IpcRegistry } from "./ipc.ts";
import { validateNodeUrl } from "./node_url.ts";

/** Length of a stored secret: the AES-256 local storage key. */
export const SECRET_LEN = 32;
/** Longest account address accepted (local part, `@`, domain with an optional port). */
export const MAX_ACCOUNT = 320;
/** Environment switch of the backend (see the module documentation). */
export const BACKEND_ENV = "TAVRN_DESKTOP_KEYCHAIN";
/** The file of the encrypted entries in the profile directory. */
export const KEYCHAIN_FILE = "keychain.json";

/** Error codes the client sees (`keychain.*`), thrown as plain strings like the Tauri commands' refusals. */
export type KeychainCode = "keychain.unavailable" | "keychain.invalid" | "keychain.no_node" | "keychain.corrupt";

/** Which keychain holds the entries, as Settings → App names it (`KeychainStatus` of the client). */
export type Backend = "secret-service" | "credential-manager" | "keychain" | "memory" | "none";

export interface Status {
  backend: Backend;
  /** The keychain answered just now. */
  available: boolean;
}

const word = (b: string) => /^[A-Za-z0-9._-]+$/.test(b);

/** An account address as the client's key store names accounts: `local@domain` or `local@domain:port`. */
export function validAccount(account: string): boolean {
  if (!account || account.length > MAX_ACCOUNT) return false;
  const at = account.indexOf("@");
  if (at < 0) return false;
  const local = account.slice(0, at);
  const host = account.slice(at + 1);
  const colon = host.indexOf(":");
  const domain = colon < 0 ? host : host.slice(0, colon);
  const port = colon < 0 ? null : host.slice(colon + 1);
  const localOk = local.length > 0 && word(local);
  const domainOk = domain.length > 0 && !domain.startsWith(".") && !domain.endsWith(".") && /^[A-Za-z0-9.-]+$/.test(domain);
  const portOk = port === null || /^[0-9]{1,5}$/.test(port);
  return localOk && domainOk && portOk;
}

/** The entry's name: scoped by the home node's origin and the account. Throws a {@link KeychainCode}. */
export function entryUser(node: string | null, account: string): string {
  if (!validAccount(account)) throw "keychain.invalid" satisfies KeychainCode;
  let origin: string;
  try {
    origin = validateNodeUrl(node ?? "");
  } catch {
    throw "keychain.no_node" satisfies KeychainCode;
  }
  return `local-key/${origin}/${account.toLowerCase()}`;
}

/** Encrypts with a key from the desktop's keyring (safeStorage, or a fake in tests). */
export interface SecretCipher {
  backend(): Backend;
  /** A keyring holds the key now (never Chromium's fixed fallback key). */
  available(): boolean;
  /** Throws `keychain.unavailable` without a keyring. */
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** The part of Electron's `safeStorage` the keychain uses. */
export interface SafeStorageLike {
  getSelectedStorageBackend(): "basic_text" | "gnome_libsecret" | "kwallet" | "kwallet5" | "kwallet6" | "unknown";
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

/** Chromium's ciphertext version of a key from the keyring (`v10` is its fixed fallback key on Linux). */
const KEYRING_PREFIX = "v11";

/** `safeStorage` as a {@link SecretCipher}: only ciphertext under a key from the keyring counts (Linux). */
export function safeStorageCipher(safe: SafeStorageLike, platform: NodeJS.Platform = process.platform): SecretCipher {
  const linux = platform === "linux";
  const fromKeyring = (blob: Buffer) => !linux || blob.subarray(0, KEYRING_PREFIX.length).toString("latin1") === KEYRING_PREFIX;
  const backend = (): Backend => {
    if (!linux) return platform === "darwin" ? "keychain" : platform === "win32" ? "credential-manager" : "none";
    const selected = safe.getSelectedStorageBackend();
    return selected === "gnome_libsecret" || selected.startsWith("kwallet") ? "secret-service" : "none";
  };
  const encrypt = (plain: string): Buffer => {
    if (backend() === "none" || !safe.isEncryptionAvailable()) throw "keychain.unavailable" satisfies KeychainCode;
    let blob: Buffer;
    try {
      blob = safe.encryptString(plain);
    } catch {
      throw "keychain.unavailable" satisfies KeychainCode;
    }
    if (!fromKeyring(blob)) throw "keychain.unavailable" satisfies KeychainCode;
    return blob;
  };
  return {
    backend,
    available: () => {
      try {
        encrypt("probe");
        return true;
      } catch {
        return false;
      }
    },
    encrypt,
    decrypt: (blob) => safe.decryptString(blob),
  };
}

/**
 * The `--password-store` switch for Chromium (before the app is ready): Chromium picks the keyring by the desktop and
 * falls back to its fixed key on desktops it does not know (sway, Hyprland, i3, xvfb), even when a Secret Service runs.
 * The Secret Service is the Linux standard (the Tauri shell uses it everywhere), so it is asked on every desktop but
 * KDE, where Chromium's own choice is KWallet. An explicit `--password-store` of the user wins.
 */
export function passwordStoreSwitch(env: NodeJS.ProcessEnv, hasSwitch: boolean): string | null {
  if (hasSwitch) return null;
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((d) => d.trim().toUpperCase());
  return desktops.includes("KDE") ? null : "gnome-libsecret";
}

interface Store {
  get(user: string): Uint8Array | null;
  set(user: string, secret: Uint8Array): void;
  delete(user: string): void;
  available(): boolean;
}

class MemoryStore implements Store {
  readonly #entries = new Map<string, Uint8Array>();
  get(user: string) {
    const v = this.#entries.get(user);
    return v ? new Uint8Array(v) : null;
  }
  set(user: string, secret: Uint8Array) {
    this.#entries.set(user, new Uint8Array(secret));
  }
  delete(user: string) {
    this.#entries.delete(user);
  }
  available() {
    return true;
  }
}

interface FileDoc {
  version: 1;
  entries: Record<string, string>;
}

/** Entries encrypted by the cipher, in `keychain.json` (written atomically, readable by the user only). */
class SafeStorageStore implements Store {
  readonly #path: string;
  readonly #cipher: SecretCipher;

  constructor(dir: string, cipher: SecretCipher) {
    this.#path = join(dir, KEYCHAIN_FILE);
    this.#cipher = cipher;
  }

  /** The entries of the file; `corrupt`: the file exists but cannot be read (null: no file). */
  #read(): { entries: Record<string, string>; corrupt: boolean } {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch {
      return { entries: {}, corrupt: false };
    }
    try {
      const doc = JSON.parse(text) as Partial<FileDoc>;
      const entries = doc?.entries;
      if (doc?.version !== 1 || typeof entries !== "object" || entries === null || Array.isArray(entries) || !Object.values(entries).every((v) => typeof v === "string")) {
        return { entries: {}, corrupt: true };
      }
      return { entries: { ...entries }, corrupt: false };
    } catch {
      return { entries: {}, corrupt: true };
    }
  }

  #write(entries: Record<string, string>): void {
    try {
      mkdirSync(join(this.#path, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.tmp`;
      const doc: FileDoc = { version: 1, entries };
      writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
      renameSync(tmp, this.#path);
    } catch {
      throw "keychain.unavailable" satisfies KeychainCode;
    }
  }

  #needKeyring(): void {
    if (!this.#cipher.available()) throw "keychain.unavailable" satisfies KeychainCode;
  }

  get(user: string): Uint8Array | null {
    this.#needKeyring();
    const { entries, corrupt } = this.#read();
    const stored = entries[user];
    if (stored === undefined) {
      if (corrupt) throw "keychain.corrupt" satisfies KeychainCode;
      return null;
    }
    let secret: Buffer;
    try {
      secret = Buffer.from(this.#cipher.decrypt(Buffer.from(stored, "base64")), "base64");
    } catch {
      // Encrypted under another keyring secret (the keyring entry was replaced), or not ours at all.
      throw "keychain.corrupt" satisfies KeychainCode;
    }
    if (secret.length !== SECRET_LEN) throw "keychain.corrupt" satisfies KeychainCode;
    return new Uint8Array(secret);
  }

  set(user: string, secret: Uint8Array): void {
    this.#needKeyring();
    const blob = this.#cipher.encrypt(Buffer.from(secret).toString("base64"));
    const { entries } = this.#read();
    entries[user] = blob.toString("base64");
    this.#write(entries);
  }

  delete(user: string): void {
    this.#needKeyring();
    const { entries, corrupt } = this.#read();
    if (!(user in entries) && !corrupt) return;
    delete entries[user];
    this.#write(entries);
  }

  available(): boolean {
    return this.#cipher.available();
  }
}

export interface KeychainOptions {
  /** The profile directory (`app.getPath("userData")`). */
  dir: string;
  /** safeStorage once the app is ready; null: no OS keychain. */
  cipher: SecretCipher | null;
}

/** The keychain of this installation (or none: every call then fails with `keychain.unavailable`). */
export class Keychain {
  readonly backend: Backend;
  readonly #store: Store | null;
  /** One call at a time: the file is read, changed and written as a whole. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(store: Store | null, backend: Backend) {
    this.#store = store;
    this.backend = backend;
  }

  /** `memory`, `unavailable`, anything else: the OS keychain. */
  static forSetting(setting: string | undefined, options: KeychainOptions): Keychain {
    if (setting === "memory") return Keychain.memory();
    if (setting === "unavailable" || !options.cipher) return Keychain.unavailable();
    return Keychain.os(options.dir, options.cipher);
  }

  static os(dir: string, cipher: SecretCipher): Keychain {
    const backend = cipher.backend();
    return backend === "none" ? Keychain.unavailable() : new Keychain(new SafeStorageStore(dir, cipher), backend);
  }

  static memory(): Keychain {
    return new Keychain(new MemoryStore(), "memory");
  }

  static unavailable(): Keychain {
    return new Keychain(null, "none");
  }

  #run<T>(fn: (store: Store) => T): Promise<T> {
    const next = this.#queue.then(() => {
      if (!this.#store) throw "keychain.unavailable" satisfies KeychainCode;
      return fn(this.#store);
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The secret of `user`, or null. */
  get(user: string): Promise<Uint8Array | null> {
    return this.#run((s) => s.get(user));
  }

  /** Stores (or replaces) the secret of `user`: exactly 32 bytes. */
  set(user: string, secret: Uint8Array): Promise<void> {
    if (secret.byteLength !== SECRET_LEN) return Promise.reject("keychain.invalid" satisfies KeychainCode);
    return this.#run((s) => s.set(user, secret));
  }

  /** Removes the entry of `user`; a missing entry is fine. */
  delete(user: string): Promise<void> {
    return this.#run((s) => s.delete(user));
  }

  /** Which keychain, and does it answer? */
  async status(): Promise<Status> {
    const available = await this.#run((s) => s.available()).catch(() => false);
    return { backend: this.backend, available };
  }
}

export interface KeychainDeps {
  settings: Settings;
  /** The keychain, chosen once the app is ready (safeStorage knows its keyring only then). */
  keychain: () => Keychain;
}

/** The `keychain` namespace of the bridge (the client: `web/src/platform/electron.ts`). */
export function registerKeychainHandlers(registry: IpcRegistry, deps: KeychainDeps): void {
  const account = check.string(MAX_ACCOUNT * 4);
  const user = (a: string) => entryUser(deps.settings.get().node, a);
  registry.handle("keychain", "keychainGet", check.args([account]), (a: string) => deps.keychain().get(user(a)));
  registry.handle("keychain", "keychainSet", check.args([account, check.bytes(1024)]), (a: string, secret: Uint8Array) => deps.keychain().set(user(a), secret));
  registry.handle("keychain", "keychainDelete", check.args([account]), (a: string) => deps.keychain().delete(user(a)));
  registry.handle("keychain", "keychainStatus", check.args([]), () => deps.keychain().status());
}
