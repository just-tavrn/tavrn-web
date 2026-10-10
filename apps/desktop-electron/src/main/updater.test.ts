// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import { parsePublicKey } from "./minisign.ts";
import { minisignKeyPair } from "./minisign.fixture.ts";
import { channelFile, feedSource, notesText, parseFeed, registerUpdaterHandlers, updaterSetup, verifyFeed, type FeedCheck } from "./updater.ts";

const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

const APP_UPDATE_YML = "owner: just-tavrn\nrepo: tavrn-web\nprovider: github\nreleaseType: release\nupdaterCacheDirName: tavrn-updater\n";

function packageDirs(t: { after(fn: () => void): void }, pubkey: string | null, appUpdate: string | null = APP_UPDATE_YML) {
  const resources = mkdtempSync(join(tmpdir(), "tavrn-electron-updater-"));
  const appPath = mkdtempSync(join(tmpdir(), "tavrn-electron-app-"));
  t.after(() => {
    rmSync(resources, { recursive: true, force: true });
    rmSync(appPath, { recursive: true, force: true });
  });
  if (appUpdate !== null) writeFileSync(join(resources, "app-update.yml"), appUpdate);
  writeFileSync(join(appPath, "package.json"), JSON.stringify({ name: "tavrn", ...(pubkey === null ? {} : { tavrn: { updaterPubkey: pubkey } }) }));
  return { resources, appPath };
}

const noFetch = async () => {
  throw new Error("no network in this test");
};

test("updates only in a package that carries the feed's settings and a valid update key", (t) => {
  const key = minisignKeyPair();
  const pubkey = Buffer.from(key.publicKeyFile).toString("base64");
  const ok = packageDirs(t, pubkey);
  const setup = updaterSetup({ packaged: true, resourcesPath: ok.resources, appPath: ok.appPath, platform: "linux", arch: "x64", fetch: noFetch });
  assert.ok(setup);
  assert.deepEqual(setup.source, { owner: "just-tavrn", repo: "tavrn-web" });
  assert.equal(setup.channel, "latest-linux.yml");
  assert.equal(updaterSetup({ packaged: false, resourcesPath: ok.resources, appPath: ok.appPath, platform: "linux", arch: "x64", fetch: noFetch }), null, "never in a development run");
  const noFeed = packageDirs(t, pubkey, null);
  assert.equal(updaterSetup({ packaged: true, resourcesPath: noFeed.resources, appPath: noFeed.appPath, platform: "linux", arch: "x64", fetch: noFetch }), null);
  for (const bad of [null, "REPLACE_WITH_THE_OWNERS_MINISIGN_PUBLIC_KEY", ""]) {
    const d = packageDirs(t, bad);
    assert.equal(updaterSetup({ packaged: true, resourcesPath: d.resources, appPath: d.appPath, platform: "linux", arch: "x64", fetch: noFetch }), null, `no updates with the key ${bad}`);
  }
});

test("the feed's source and channel file as electron-updater reads them", () => {
  assert.deepEqual(feedSource(APP_UPDATE_YML), { owner: "just-tavrn", repo: "tavrn-web" });
  assert.deepEqual(feedSource("provider: github\nowner: 'a-b'\nrepo: \"c.d\"\n"), { owner: "a-b", repo: "c.d" });
  assert.equal(feedSource("provider: generic\nurl: https://example.org\n"), null);
  assert.equal(feedSource("provider: github\nowner: ../x\nrepo: y\n"), null);
  assert.equal(channelFile("linux", "x64"), "latest-linux.yml");
  assert.equal(channelFile("linux", "arm64"), "latest-linux-arm64.yml");
  assert.equal(channelFile("win32", "x64"), "latest.yml");
  assert.equal(channelFile("darwin", "arm64"), "latest-mac.yml");
});

const LINUX_FEED = `version: 0.3.0
files:
  - url: Tavrn-0.3.0.AppImage
    sha512: aGVsbG8=
    size: 120000000
    blockMapSize: 125000
  - url: tavrn_0.3.0_amd64.deb
    sha512: d29ybGQ=
    size: 90000000
path: Tavrn-0.3.0.AppImage
sha512: aGVsbG8=
releaseDate: '2026-10-10T12:00:00.000Z'
`;

test("parses electron-builder's feed: the version and every file with its SHA-512", () => {
  assert.deepEqual(parseFeed(LINUX_FEED), {
    version: "0.3.0",
    files: [
      { url: "Tavrn-0.3.0.AppImage", sha512: "aGVsbG8=" },
      { url: "tavrn_0.3.0_amd64.deb", sha512: "d29ybGQ=" },
    ],
  });
  assert.deepEqual(parseFeed("version: '1.0.0-rc.1'\nfiles:\n  - url: \"tavrn-electron_1.0.0-rc.1_x64-setup.exe\"\n    sha512: eA==\n"), {
    version: "1.0.0-rc.1",
    files: [{ url: "tavrn-electron_1.0.0-rc.1_x64-setup.exe", sha512: "eA==" }],
  });
});

/** A fake of the release: the feed and its signature at their download URLs. */
function release(files: Record<string, string | Uint8Array>) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  };
  return { fetch, asked };
}

const BASE = "https://github.com/just-tavrn/tavrn-web/releases/download/v0.3.0";
const INFO = {
  version: "0.3.0",
  tag: "v0.3.0",
  files: [
    { url: "Tavrn-0.3.0.AppImage", sha512: "aGVsbG8=" },
    { url: "tavrn_0.3.0_amd64.deb", sha512: "d29ybGQ=" },
  ],
};

function feedCheck(key: ReturnType<typeof minisignKeyPair>, files: Record<string, string | Uint8Array>, logs: string[] = []): FeedCheck & { asked: string[] } {
  const r = release(files);
  return { source: { owner: "just-tavrn", repo: "tavrn-web" }, channel: "latest-linux.yml", publicKey: parsePublicKey(key.publicKeyFile), fetch: r.fetch, log: (m) => void logs.push(m), asked: r.asked };
}

const signed = (key: ReturnType<typeof minisignKeyPair>, feed: string, file = "latest-linux.yml", version = "0.3.0") =>
  key.sign(Buffer.from(feed), { trustedComment: `timestamp:1791658999\tfile:${file}\tversion:${version}` });

test("a feed signed with the app's key and matching what electron-updater read passes", async () => {
  const key = minisignKeyPair();
  const check = feedCheck(key, { [`${BASE}/latest-linux.yml`]: LINUX_FEED, [`${BASE}/latest-linux.yml.minisig`]: signed(key, LINUX_FEED) });
  await verifyFeed(check, INFO);
  assert.deepEqual(check.asked, [`${BASE}/latest-linux.yml`, `${BASE}/latest-linux.yml.minisig`]);
  // Without a tag in the update info the tag is v<version>; electron-updater lists a subset of the files: fine.
  await verifyFeed(check, { version: "0.3.0", files: [INFO.files[0]!] });
});

test("refuses unsigned, foreign, changed or mismatched feeds with a logged reason", async () => {
  const key = minisignKeyPair();
  const other = minisignKeyPair();
  const feedUrl = `${BASE}/latest-linux.yml`;
  const sigUrl = `${feedUrl}.minisig`;
  const cases: [string, Record<string, string>, typeof INFO, RegExp][] = [
    ["no signature", { [feedUrl]: LINUX_FEED }, INFO, /latest-linux\.yml\.minisig: HTTP 404/],
    ["no feed", { [sigUrl]: signed(key, LINUX_FEED) }, INFO, /latest-linux\.yml: HTTP 404/],
    ["another key", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(other, LINUX_FEED) }, INFO, /made with key/],
    ["a changed feed", { [feedUrl]: LINUX_FEED.replace("d29ybGQ=", "ZXZpbA=="), [sigUrl]: signed(key, LINUX_FEED) }, INFO, /does not match the file/],
    ["the signature of another feed file", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(key, LINUX_FEED, "latest.yml") }, INFO, /signed for latest\.yml/],
    ["the signature of another version", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(key, LINUX_FEED, "latest-linux.yml", "0.2.0") }, INFO, /signed for version 0\.2\.0/],
    ["another version than electron-updater read", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(key, LINUX_FEED) }, { ...INFO, version: "0.4.0" }, /announces 0\.3\.0/],
    ["a file electron-updater read that the signed feed lacks", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(key, LINUX_FEED) }, { ...INFO, files: [{ url: "Tavrn-0.3.0.AppImage", sha512: "ZXZpbA==" }] }, /Tavrn-0\.3\.0\.AppImage is not in the signed feed/],
    ["no files at all", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(key, LINUX_FEED) }, { ...INFO, files: [] }, /no files/],
    ["an odd tag", { [feedUrl]: LINUX_FEED, [sigUrl]: signed(key, LINUX_FEED) }, { ...INFO, tag: "v0.3.0/../../evil" }, /tag/],
  ];
  for (const [what, files, info, reason] of cases) {
    const logs: string[] = [];
    await assert.rejects(verifyFeed(feedCheck(key, files, logs), info), (e) => e === "update.signature_invalid", what);
    assert.equal(logs.length, 1, what);
    assert.match(logs[0]!, reason, what);
    assert.match(logs[0]!, /^tavrn: refused the update/, what);
  }
});

test("release notes become plain text", () => {
  assert.equal(notesText("<p>New <b>things</b> &amp; fixes</p><ul><li>One</li><li>Two</li></ul>"), "New things & fixes\nOne\nTwo");
  assert.equal(notesText([{ note: "<p>A</p>" }, { note: null }, { note: "B" }]), "A\n\nB");
  assert.equal(notesText(null), null);
  assert.equal(notesText(""), null);
});

function fakeUpdater(available: boolean, info: Record<string, unknown> = { version: "0.3.0", releaseNotes: "<p>New</p>" }) {
  const calls: string[] = [];
  return {
    calls,
    load: async () => ({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: async () => (calls.push("check"), { isUpdateAvailable: available, updateInfo: info as { version: string } }),
      downloadUpdate: async () => void calls.push("download"),
      quitAndInstall: () => void calls.push("install"),
    }),
  };
}

test("checkUpdate and installUpdate as the Tauri commands answer, after the feed's signature", async () => {
  const key = minisignKeyPair();
  const goodFiles = { [`${BASE}/latest-linux.yml`]: LINUX_FEED, [`${BASE}/latest-linux.yml.minisig`]: signed(key, LINUX_FEED) };
  const info = { ...INFO, releaseNotes: "<p>New</p>" };

  const off = new IpcRegistry((e) => e === me);
  registerUpdaterHandlers(off, null, fakeUpdater(true, info).load);
  assert.deepEqual(await off.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: false, error: "update.not_configured" });

  const on = new IpcRegistry((e) => e === me);
  const u = fakeUpdater(true, info);
  const check = feedCheck(key, goodFiles);
  registerUpdaterHandlers(on, check, u.load);
  assert.deepEqual(await on.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: true, value: { version: "0.3.0", notes: "New" } });
  assert.deepEqual(await on.dispatch("tavrn:updater.installUpdate", "installUpdate", me, []), { ok: true, value: undefined });
  assert.deepEqual(u.calls, ["check", "check", "download", "install"]);
  assert.equal(check.asked.length, 4, "the feed and its signature are checked for the offer and again before the download");

  const none = new IpcRegistry((e) => e === me);
  registerUpdaterHandlers(none, feedCheck(key, goodFiles), fakeUpdater(false, info).load);
  assert.deepEqual(await none.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: true, value: null });
  assert.deepEqual(await none.dispatch("tavrn:updater.installUpdate", "installUpdate", me, []), { ok: false, error: "update.none" });
});

test("a refused signature offers nothing and never downloads", async () => {
  const key = minisignKeyPair();
  const other = minisignKeyPair();
  const logs: string[] = [];
  const forged = feedCheck(key, { [`${BASE}/latest-linux.yml`]: LINUX_FEED, [`${BASE}/latest-linux.yml.minisig`]: signed(other, LINUX_FEED) }, logs);
  const u = fakeUpdater(true, { ...INFO, releaseNotes: null });
  const registry = new IpcRegistry((e) => e === me);
  registerUpdaterHandlers(registry, forged, u.load);
  assert.deepEqual(await registry.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: false, error: "update.signature_invalid" });
  assert.deepEqual(await registry.dispatch("tavrn:updater.installUpdate", "installUpdate", me, []), { ok: false, error: "update.signature_invalid" });
  assert.deepEqual(u.calls, ["check", "check"], "no download, no install");
  assert.equal(logs.length, 2);
});
