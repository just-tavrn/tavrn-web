// SPDX-License-Identifier: Apache-2.0
// The keychain (the Tauri shell's keychain.rs cases), its safeStorage store with a fake cipher, and its IPC handlers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "./config.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import {
  Keychain,
  KEYCHAIN_FILE,
  MAX_ACCOUNT,
  SECRET_LEN,
  entryUser,
  passwordStoreSwitch,
  registerKeychainHandlers,
  safeStorageCipher,
  validAccount,
  type SafeStorageLike,
  type SecretCipher,
} from "./keychain.ts";

const KEY = new Uint8Array(SECRET_LEN).fill(7);

function tempDir(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "tavrn-electron-keychain-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A cipher like safeStorage on a desktop with a Secret Service: `v11` and a reversible scramble. */
function fakeCipher(over: Partial<SecretCipher> = {}): SecretCipher & { key: number } {
  const c: SecretCipher & { key: number } = {
    key: 0x5a,
    backend: () => "secret-service" as const,
    available: () => true,
    encrypt(plain: string): Buffer {
      return Buffer.concat([Buffer.from("v11"), Buffer.from(plain, "utf8").map((b: number) => b ^ c.key)]);
    },
    decrypt(blob: Buffer): string {
      if (blob.subarray(0, 3).toString() !== "v11") throw new Error("not ours");
      return Buffer.from(blob.subarray(3).map((b) => b ^ c.key)).toString("utf8");
    },
    ...over,
  };
  return c;
}

test("entries are scoped by node and account", () => {
  assert.equal(entryUser("https://tavrn.example", "alice@tavrn.example"), "local-key/https://tavrn.example/alice@tavrn.example");
  assert.equal(entryUser("https://Tavrn.Example/", "Alice@Tavrn.Example"), "local-key/https://tavrn.example/alice@tavrn.example", "normalized");
  assert.equal(entryUser("http://127.0.0.1:8080", "bob@localhost"), "local-key/http://127.0.0.1:8080/bob@localhost");
  assert.notEqual(entryUser("https://a.example", "x@a.example"), entryUser("https://b.example", "x@a.example"), "another node, another entry");
});

test("odd accounts and nodes are refused", () => {
  for (const bad of ["", "alice", "@tavrn.example", "alice@", "a/b@tavrn.example", "alice@tavrn.example/x", "alice@x:", "alice@x:123456", "alice@.x", "a lice@x", "alice@x@y", "ä@x"]) {
    assert.throws(() => entryUser("https://tavrn.example", bad), (e) => e === "keychain.invalid", JSON.stringify(bad));
  }
  assert.throws(() => entryUser("https://tavrn.example", `${"a".repeat(MAX_ACCOUNT)}@x`), (e) => e === "keychain.invalid");
  assert.ok(validAccount("bob@localhost:8080"));
  assert.throws(() => entryUser("http://evil.example", "alice@tavrn.example"), (e) => e === "keychain.no_node");
  assert.throws(() => entryUser("", "alice@tavrn.example"), (e) => e === "keychain.no_node");
  assert.throws(() => entryUser(null, "alice@tavrn.example"), (e) => e === "keychain.no_node");
});

test("the memory keychain stores, reads and deletes", async () => {
  const k = Keychain.memory();
  const user = "local-key/https://tavrn.example/alice@tavrn.example";
  assert.equal(await k.get(user), null);
  await k.set(user, KEY);
  assert.deepEqual(await k.get(user), KEY);
  assert.equal(await k.get("local-key/https://tavrn.example/bob@tavrn.example"), null, "entries do not leak between accounts");
  await k.set(user, new Uint8Array(SECRET_LEN).fill(9));
  assert.deepEqual(await k.get(user), new Uint8Array(SECRET_LEN).fill(9), "replaced");
  await k.delete(user);
  assert.equal(await k.get(user), null);
  await k.delete(user);
  assert.deepEqual(await k.status(), { backend: "memory", available: true });
});

test("only 32-byte keys are stored", async () => {
  const k = Keychain.memory();
  for (const len of [31, 33, 0]) await assert.rejects(k.set("u", new Uint8Array(len)), (e) => e === "keychain.invalid");
  assert.equal(await k.get("u"), null);
  // A stored value is a copy: changing the caller's array afterwards changes nothing.
  const mine = new Uint8Array(KEY);
  await k.set("u", mine);
  mine.fill(0);
  assert.deepEqual(await k.get("u"), KEY);
});

test("without a keychain every call fails as unavailable", async () => {
  const k = Keychain.unavailable();
  await assert.rejects(k.get("u"), (e) => e === "keychain.unavailable");
  await assert.rejects(k.set("u", KEY), (e) => e === "keychain.unavailable");
  await assert.rejects(k.delete("u"), (e) => e === "keychain.unavailable");
  assert.deepEqual(await k.status(), { backend: "none", available: false });
});

test("the setting selects the test backends", () => {
  const dir = "/nonexistent";
  assert.equal(Keychain.forSetting("memory", { dir, cipher: fakeCipher() }).backend, "memory");
  assert.equal(Keychain.forSetting("unavailable", { dir, cipher: fakeCipher() }).backend, "none");
  assert.equal(Keychain.forSetting(undefined, { dir, cipher: fakeCipher() }).backend, "secret-service");
  assert.equal(Keychain.forSetting(undefined, { dir, cipher: null }).backend, "none", "no cipher before the app is ready");
});

test("the OS keychain keeps only ciphertext in its file, written atomically and private", async (t) => {
  const dir = tempDir(t);
  const cipher = fakeCipher();
  const k = Keychain.os(dir, cipher);
  const user = "local-key/https://tavrn.example/alice@tavrn.example";
  assert.equal(await k.get(user), null, "no file yet");
  await k.set(user, KEY);
  const file = join(dir, KEYCHAIN_FILE);
  const text = readFileSync(file, "utf8");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const doc = JSON.parse(text) as { version: number; entries: Record<string, string> };
  assert.equal(doc.version, 1);
  assert.deepEqual(Object.keys(doc.entries), [user]);
  const blob = Buffer.from(doc.entries[user]!, "base64");
  assert.equal(blob.subarray(0, 3).toString(), "v11");
  assert.ok(!text.includes(Buffer.from(KEY).toString("base64")), "the key itself is not in the file");
  // A new start reads the file again.
  const again = Keychain.os(dir, cipher);
  assert.deepEqual(await again.get(user), KEY);
  await again.delete(user);
  assert.equal(await Keychain.os(dir, cipher).get(user), null);
  assert.deepEqual(await again.status(), { backend: "secret-service", available: true });
});

test("the file alone opens nothing: another keyring secret cannot read it", async (t) => {
  const dir = tempDir(t);
  const user = "local-key/https://tavrn.example/alice@tavrn.example";
  await Keychain.os(dir, fakeCipher()).set(user, KEY);
  const other = fakeCipher();
  other.key = 0x33;
  await assert.rejects(Keychain.os(dir, other).get(user), (e) => e === "keychain.corrupt");
});

test("a foreign value or a corrupt file is reported as corrupt, a broken file does not lose new entries", async (t) => {
  const dir = tempDir(t);
  const cipher = fakeCipher();
  const file = join(dir, KEYCHAIN_FILE);
  writeFileSync(file, JSON.stringify({ version: 1, entries: { u: cipher.encrypt("bm90IGEga2V5").toString("base64") } }));
  await assert.rejects(Keychain.os(dir, cipher).get("u"), (e) => e === "keychain.corrupt", "not 32 bytes");
  writeFileSync(file, "{ not json");
  await assert.rejects(Keychain.os(dir, cipher).get("u"), (e) => e === "keychain.corrupt");
  // Writing replaces the unreadable file (its entries were lost anyway).
  const k = Keychain.os(dir, cipher);
  await k.set("u", KEY);
  assert.deepEqual(await Keychain.os(dir, cipher).get("u"), KEY);
});

test("a keyring that stops answering makes the OS keychain unavailable, never plain", async (t) => {
  const dir = tempDir(t);
  let up = true;
  const cipher = fakeCipher({ available: () => up });
  const k = Keychain.os(dir, cipher);
  await k.set("u", KEY);
  up = false;
  assert.deepEqual(await k.status(), { backend: "secret-service", available: false });
  await assert.rejects(k.get("u"), (e) => e === "keychain.unavailable");
  await assert.rejects(k.set("u", KEY), (e) => e === "keychain.unavailable");
  await assert.rejects(k.delete("u"), (e) => e === "keychain.unavailable");
});

test("concurrent writes keep every entry", async (t) => {
  const dir = tempDir(t);
  const k = Keychain.os(dir, fakeCipher());
  await Promise.all(Array.from({ length: 20 }, (_, i) => k.set(`u${i}`, new Uint8Array(SECRET_LEN).fill(i))));
  const again = Keychain.os(dir, fakeCipher());
  for (let i = 0; i < 20; i++) assert.deepEqual(await again.get(`u${i}`), new Uint8Array(SECRET_LEN).fill(i));
});

/** A fake of Electron's safeStorage. */
function fakeSafeStorage(backend: string, available: boolean, prefix = "v11"): SafeStorageLike {
  return {
    getSelectedStorageBackend: () => backend as ReturnType<SafeStorageLike["getSelectedStorageBackend"]>,
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => {
      if (!available) throw new Error("Encryption is not available.");
      return Buffer.concat([Buffer.from(prefix), Buffer.from(s)]);
    },
    decryptString: (b: Buffer) => b.subarray(3).toString(),
  };
}

test("safeStorage counts only when a keyring holds its key (never Chromium's built-in fallback key)", () => {
  const linux = "linux";
  const libsecret = safeStorageCipher(fakeSafeStorage("gnome_libsecret", true), linux);
  assert.equal(libsecret.backend(), "secret-service");
  assert.equal(libsecret.available(), true);
  assert.equal(libsecret.decrypt(libsecret.encrypt("abc")), "abc");
  for (const kwallet of ["kwallet", "kwallet5", "kwallet6"]) assert.equal(safeStorageCipher(fakeSafeStorage(kwallet, true), linux).backend(), "secret-service");
  // No desktop keyring: Chromium falls back to a fixed key (`v10`), which protects nothing.
  const basic = safeStorageCipher(fakeSafeStorage("basic_text", true, "v10"), linux);
  assert.equal(basic.backend(), "none");
  assert.equal(basic.available(), false);
  assert.throws(() => basic.encrypt("abc"), (e) => e === "keychain.unavailable");
  const noService = safeStorageCipher(fakeSafeStorage("gnome_libsecret", false), linux);
  assert.equal(noService.backend(), "secret-service");
  assert.equal(noService.available(), false);
  assert.throws(() => noService.encrypt("abc"), (e) => e === "keychain.unavailable");
  const fallbackKey = safeStorageCipher(fakeSafeStorage("gnome_libsecret", true, "v10"), linux);
  assert.equal(fallbackKey.available(), false, "the libsecret backend fell back to the fixed key");
  assert.throws(() => fallbackKey.encrypt("abc"), (e) => e === "keychain.unavailable");
  assert.equal(safeStorageCipher(fakeSafeStorage("unknown", true), linux).available(), false, "before the app is ready");
});

test("the password store: Chromium's choice on KDE, the Secret Service everywhere else, an explicit switch wins", () => {
  assert.equal(passwordStoreSwitch({ XDG_CURRENT_DESKTOP: "GNOME" }, false), "gnome-libsecret");
  assert.equal(passwordStoreSwitch({ XDG_CURRENT_DESKTOP: "sway" }, false), "gnome-libsecret");
  assert.equal(passwordStoreSwitch({}, false), "gnome-libsecret", "xvfb, a bare session");
  assert.equal(passwordStoreSwitch({ XDG_CURRENT_DESKTOP: "KDE" }, false), null);
  assert.equal(passwordStoreSwitch({ XDG_CURRENT_DESKTOP: "ubuntu:KDE" }, false), null);
  assert.equal(passwordStoreSwitch({ XDG_CURRENT_DESKTOP: "GNOME" }, true), null);
});

const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

function setup(t: { after: (fn: () => void) => void }, keychain = Keychain.memory()) {
  const d = tempDir(t);
  const settings = new Settings(join(d, "settings.json"));
  const registry = new IpcRegistry((e) => e === me);
  registerKeychainHandlers(registry, { settings, keychain: () => keychain });
  const call = (method: string, ...args: unknown[]) => registry.dispatch(`tavrn:keychain.${method}`, method, me, args);
  return { settings, call, keychain };
}

test("the handlers take the node from the settings file, never from the page", async (t) => {
  const { settings, call, keychain } = setup(t);
  assert.deepEqual(await call("keychainGet", "alice@tavrn.example"), { ok: false, error: "keychain.no_node" });
  settings.setNode("https://tavrn.example");
  assert.deepEqual(await call("keychainGet", "alice@tavrn.example"), { ok: true, value: null });
  assert.deepEqual(await call("keychainSet", "alice@tavrn.example", KEY), { ok: true, value: undefined });
  assert.deepEqual(await keychain.get("local-key/https://tavrn.example/alice@tavrn.example"), KEY);
  assert.deepEqual(await call("keychainGet", "Alice@Tavrn.Example"), { ok: true, value: KEY });
  // Another home node: another entry.
  settings.setNode("https://other.example");
  assert.deepEqual(await call("keychainGet", "alice@tavrn.example"), { ok: true, value: null });
  settings.setNode("https://tavrn.example");
  assert.deepEqual(await call("keychainDelete", "alice@tavrn.example"), { ok: true, value: undefined });
  assert.deepEqual(await call("keychainGet", "alice@tavrn.example"), { ok: true, value: null });
  assert.deepEqual(await call("keychainStatus"), { ok: true, value: { backend: "memory", available: true } });
});

test("the handlers refuse odd arguments at the IPC boundary and in the keychain", async (t) => {
  const { settings, call } = setup(t);
  settings.setNode("https://tavrn.example");
  assert.deepEqual(await call("keychainSet", "alice@tavrn.example", new Uint8Array(31)), { ok: false, error: "keychain.invalid" });
  assert.deepEqual(await call("keychainSet", "alice@tavrn.example", Array.from(KEY)), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("keychainSet", "alice@tavrn.example", new Uint8Array(4096)), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("keychainGet", "../x"), { ok: false, error: "keychain.invalid" });
  assert.deepEqual(await call("keychainGet", 42), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("keychainGet", "a".repeat(10_000)), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("keychainStatus", "x"), { ok: false, error: "ipc.invalid_arguments" });
});

test("an unavailable keychain answers its status and refuses the rest", async (t) => {
  const { settings, call } = setup(t, Keychain.unavailable());
  settings.setNode("https://tavrn.example");
  assert.deepEqual(await call("keychainStatus"), { ok: true, value: { backend: "none", available: false } });
  assert.deepEqual(await call("keychainGet", "alice@tavrn.example"), { ok: false, error: "keychain.unavailable" });
});
