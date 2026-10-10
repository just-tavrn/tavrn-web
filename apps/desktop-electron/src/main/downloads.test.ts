// SPDX-License-Identifier: Apache-2.0
// Downloads (the Tauri shell's download.rs cases): the chunk writer, the registry, the handlers with a fake save
// dialog (100 MB in 4 MiB pieces), the test hook, and the safety net for downloads the page starts itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import {
  CHUNK_MAX,
  ChunkWriter,
  Downloads,
  MAX_ACTIVE,
  MAX_NAME_BYTES,
  extension,
  handleWillDownload,
  registerFilesHandlers,
  safeFileName,
  saveDialogOptions,
  uniqueTarget,
  type DownloadItemLike,
  type DownloadsDeps,
} from "./downloads.ts";

function dir(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "tavrn-electron-download-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const entries = (d: string) => readdirSync(d).sort();

test("writes into a temporary file next to the target and renames it into place", async (t) => {
  const d = dir(t);
  const target = join(d, "plan.pdf");
  const w = await ChunkWriter.begin(target, 6);
  assert.equal(join(w.tempPath, ".."), d, "the temporary file sits next to the target");
  assert.ok(existsSync(w.tempPath) && !existsSync(target));
  assert.equal(statSync(w.tempPath).mode & 0o077, 0, "readable by the user only while it is written");
  await w.write(Buffer.from("abc"));
  await w.write(Buffer.from("def"));
  assert.equal(await w.finish(), target);
  assert.equal(readFileSync(target, "utf8"), "abcdef");
  assert.deepEqual(entries(d), ["plan.pdf"], "no temporary file is left");
});

test("refuses more bytes than announced and too few", async (t) => {
  const d = dir(t);
  const w = await ChunkWriter.begin(join(d, "a.txt"), 3);
  await w.write(Buffer.from("ab"));
  await assert.rejects(w.write(Buffer.from("cd")), (e) => e === "download.too_large");
  await assert.rejects(w.finish(), (e) => e === "download.incomplete");
  assert.deepEqual(entries(d), [], "a refused save leaves nothing behind");
});

test("an empty file is saved; abort removes the temporary file; an existing target is replaced only on finish", async (t) => {
  const d = dir(t);
  await (await ChunkWriter.begin(join(d, "empty.txt"), 0)).finish();
  assert.equal(readFileSync(join(d, "empty.txt"), "utf8"), "");
  const half = await ChunkWriter.begin(join(d, "a.txt"), 10);
  await half.write(Buffer.from("half"));
  await half.abort();
  assert.deepEqual(entries(d), ["empty.txt"]);
  writeFileSync(join(d, "b.txt"), "old");
  const w = await ChunkWriter.begin(join(d, "b.txt"), 3);
  await w.write(Buffer.from("new"));
  assert.equal(readFileSync(join(d, "b.txt"), "utf8"), "old");
  await w.finish();
  assert.equal(readFileSync(join(d, "b.txt"), "utf8"), "new");
});

test("names from the page cannot leave the directory", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("..\\..\\Windows\\win.ini"), "win.ini");
  assert.equal(safeFileName("/abs/path/report.pdf"), "report.pdf");
  assert.equal(safeFileName(".."), "download");
  assert.equal(safeFileName(".bashrc"), "bashrc");
  assert.equal(safeFileName(""), "download");
  assert.equal(safeFileName('a<b>c:d"e|f?g*h\u0000i.txt'), "a_b_c_d_e_f_g_h_i.txt");
  assert.equal(safeFileName("notes. . "), "notes");
  assert.equal(safeFileName("CON.txt"), "_CON.txt");
  assert.equal(safeFileName("lpt1"), "_lpt1");
  assert.equal(safeFileName("console.txt"), "console.txt");
  assert.equal(safeFileName("Geheimplan ü.txt"), "Geheimplan ü.txt");
  const cut = safeFileName(`${"ä".repeat(300)}.pdf`);
  assert.ok(Buffer.byteLength(cut) <= MAX_NAME_BYTES && cut.endsWith(".pdf"), cut);
  assert.ok(!cut.includes("�"), "cut at a character boundary");
});

test("the filter comes from the extension", () => {
  assert.equal(extension("plan.PDF"), "pdf");
  assert.equal(extension("archive.tar.gz"), "gz");
  assert.equal(extension("README"), null);
  assert.equal(extension("bashrc."), null);
  assert.equal(extension("x.this-is-no-ext"), null);
  assert.deepEqual(saveDialogOptions("plan.pdf", "/home/u/Downloads"), {
    defaultPath: "/home/u/Downloads/plan.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  assert.deepEqual(saveDialogOptions("README", "/tmp").filters, []);
});

test("the test hook and the safety net never overwrite", (t) => {
  const d = dir(t);
  assert.equal(uniqueTarget(d, "a.txt"), join(d, "a.txt"));
  writeFileSync(join(d, "a.txt"), "1");
  writeFileSync(join(d, "a (1).txt"), "2");
  assert.equal(uniqueTarget(d, "a.txt"), join(d, "a (2).txt"));
  writeFileSync(join(d, "README"), "3");
  assert.equal(uniqueTarget(d, "README"), join(d, "README (1)"));
  assert.equal(uniqueTarget(d, "c.txt", new Set([join(d, "c.txt")])), join(d, "c (1).txt"), "a name a running save holds is taken");
});

/** Downloads with a fake save dialog that answers `answers` in turn (null: cancelled). */
function setup(t: { after: (fn: () => void) => void }, over: Partial<DownloadsDeps> = {}, answers: Array<string | null> = []) {
  const d = dir(t);
  const asked: Array<{ name: string; defaultDir: string }> = [];
  const revealed: string[] = [];
  const downloads = new Downloads({
    testDir: null,
    downloadsDir: () => join(d, "Downloads"),
    chooseTarget: async (name, defaultDir) => {
      asked.push({ name, defaultDir });
      return answers.length ? (answers.shift() ?? null) : join(d, name);
    },
    reveal: (p) => void revealed.push(p),
    ...over,
  });
  t.after(() => downloads.abortAll());
  const registry = new IpcRegistry((e) => e === me);
  registerFilesHandlers(registry, { downloads });
  const call = (method: string, ...args: unknown[]) => registry.dispatch(`tavrn:files.${method}`, method, me, args);
  return { d, downloads, asked, revealed, call };
}
const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

test("a save: dialog, chunks, end with path and folder, reveal by id", async (t) => {
  const { d, asked, revealed, call } = setup(t);
  const begin = await call("saveFileBegin", "../plan.pdf", "application/pdf", 6);
  assert.deepEqual(begin, { ok: true, value: { status: "ready", id: "1" } });
  assert.deepEqual(asked, [{ name: "plan.pdf", defaultDir: join(d, "Downloads") }], "the cleaned name is the suggestion; first in Downloads");
  assert.deepEqual(await call("saveFileChunk", "1", new Uint8Array(Buffer.from("abc"))), { ok: true, value: undefined });
  assert.deepEqual(await call("saveFileChunk", "1", new Uint8Array(Buffer.from("def"))), { ok: true, value: undefined });
  const folder = d.split("/").at(-1);
  assert.deepEqual(await call("saveFileEnd", "1"), { ok: true, value: { path: join(d, "plan.pdf"), folder } });
  assert.equal(readFileSync(join(d, "plan.pdf"), "utf8"), "abcdef");
  assert.deepEqual(await call("saveFileReveal", "1"), { ok: true, value: undefined });
  assert.deepEqual(revealed, [join(d, "plan.pdf")]);
  // The next dialog starts in the directory used last.
  await call("saveFileBegin", "b.txt", "text/plain", 0);
  assert.equal(asked[1]?.defaultDir, d);
});

test("a cancelled dialog, unknown ids, a failed reveal", async (t) => {
  const { d, call } = setup(t, {}, [null]);
  assert.deepEqual(await call("saveFileBegin", "a.txt", "text/plain", 1), { ok: true, value: { status: "cancelled" } });
  assert.deepEqual(await call("saveFileChunk", "9", new Uint8Array(1)), { ok: false, error: "download.unknown" });
  assert.deepEqual(await call("saveFileEnd", "9"), { ok: false, error: "download.unknown" });
  assert.deepEqual(await call("saveFileAbort", "9"), { ok: true, value: undefined });
  assert.deepEqual(await call("saveFileReveal", "9"), { ok: false, error: "download.unknown" });
  await call("saveFileBegin", "gone.txt", "text/plain", 0);
  await call("saveFileEnd", "1");
  rmSync(join(d, "gone.txt"));
  assert.deepEqual(await call("saveFileReveal", "1"), { ok: false, error: "download.reveal_failed" });
});

test("abort removes the temporary file; more than announced is refused", async (t) => {
  const { d, call } = setup(t);
  await call("saveFileBegin", "a.bin", "", 2);
  assert.deepEqual(await call("saveFileChunk", "1", new Uint8Array(3)), { ok: false, error: "download.too_large" });
  assert.deepEqual(await call("saveFileAbort", "1"), { ok: true, value: undefined });
  assert.deepEqual(await call("saveFileEnd", "1"), { ok: false, error: "download.unknown" });
  assert.deepEqual(entries(d), []);
});

test("at most 8 saves at once, checked before the dialog", async (t) => {
  const { asked, call, downloads } = setup(t);
  for (let i = 0; i < MAX_ACTIVE; i++) assert.equal(((await call("saveFileBegin", `${i}.bin`, "", 1)) as { ok: boolean }).ok, true);
  assert.deepEqual(await call("saveFileBegin", "x.bin", "", 1), { ok: false, error: "download.busy" });
  assert.equal(asked.length, MAX_ACTIVE, "no dialog for a save that cannot run");
  downloads.abortAll();
  assert.equal(((await call("saveFileBegin", "y.bin", "", 1)) as { ok: boolean }).ok, true);
});

test("the test hook saves into its directory without a dialog, never overwriting", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "tavrn-electron-save-"));
  t.after(() => rmSync(testDir, { recursive: true, force: true }));
  writeFileSync(join(testDir, "a.txt"), "old");
  const { asked, call } = setup(t, { testDir });
  await call("saveFileBegin", "a.txt", "text/plain", 1);
  await call("saveFileBegin", "a.txt", "text/plain", 1);
  await call("saveFileChunk", "1", new Uint8Array([49]));
  await call("saveFileChunk", "2", new Uint8Array([50]));
  assert.deepEqual(await call("saveFileEnd", "2"), { ok: true, value: { path: join(testDir, "a (2).txt"), folder: testDir.split("/").at(-1) } });
  assert.deepEqual(await call("saveFileEnd", "1"), { ok: true, value: { path: join(testDir, "a (1).txt"), folder: testDir.split("/").at(-1) } });
  assert.equal(readFileSync(join(testDir, "a.txt"), "utf8"), "old");
  assert.equal(asked.length, 0);
});

test("odd arguments are refused at the IPC boundary", async (t) => {
  const { call } = setup(t);
  assert.deepEqual(await call("saveFileBegin", "a.txt", "text/plain", -1), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("saveFileBegin", "a.txt", "text/plain", 1.5), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("saveFileBegin", "a.txt", 7, 1), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("saveFileBegin", "a".repeat(5000), "", 1), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("saveFileChunk", "1", new Uint8Array(CHUNK_MAX + 1)), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("saveFileChunk", "1", [1, 2]), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("saveFileEnd", 1), { ok: false, error: "ipc.invalid_arguments" });
});

test("a 100 MB file arrives byte for byte in 4 MiB pieces", async (t) => {
  const { d, call } = setup(t);
  const size = 100 * 1024 * 1024;
  await call("saveFileBegin", "big.bin", "application/octet-stream", size);
  const piece = new Uint8Array(CHUNK_MAX);
  const sent = createHash("sha256");
  let n = 0;
  for (let offset = 0; offset < size; offset += CHUNK_MAX, n++) {
    const len = Math.min(CHUNK_MAX, size - offset);
    piece.fill(n & 0xff);
    piece[0] = n >> 8;
    const bytes = piece.subarray(0, len);
    sent.update(bytes);
    const r = await call("saveFileChunk", "1", bytes);
    assert.deepEqual(r, { ok: true, value: undefined });
  }
  assert.equal(n, 25);
  assert.deepEqual(await call("saveFileEnd", "1"), { ok: true, value: { path: join(d, "big.bin"), folder: d.split("/").at(-1) } });
  assert.equal(statSync(join(d, "big.bin")).size, size);
  assert.equal(createHash("sha256").update(readFileSync(join(d, "big.bin"))).digest("hex"), sent.digest("hex"));
  assert.deepEqual(entries(d), ["big.bin"]);
});

class FakeItem implements DownloadItemLike {
  savePath = "";
  dialog: unknown = null;
  cancelled = false;
  done: ((event: unknown, state: "completed" | "cancelled" | "interrupted") => void) | null = null;
  readonly url: string;
  readonly name: string;
  constructor(url: string, name: string) {
    this.url = url;
    this.name = name;
  }
  getURL() {
    return this.url;
  }
  getFilename() {
    return this.name;
  }
  setSavePath(p: string) {
    this.savePath = p;
  }
  getSavePath() {
    return this.savePath;
  }
  setSaveDialogOptions(o: unknown) {
    this.dialog = o;
  }
  cancel() {
    this.cancelled = true;
  }
  once(_event: "done", fn: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void) {
    this.done = fn;
    return this;
  }
}

test("the safety net: a download of the main window gets the save dialog, others are cancelled", async (t) => {
  const { d, downloads } = setup(t);
  const item = new FakeItem("blob:app://tavrn/1234", "../report.pdf");
  handleWillDownload(item, true, downloads);
  assert.equal(item.cancelled, false);
  assert.deepEqual(item.dialog, saveDialogOptions("report.pdf", join(d, "Downloads")));
  item.savePath = join(d, "chosen", "report.pdf");
  item.done?.({}, "completed");
  assert.equal(downloads.defaultDir(), join(d, "chosen"), "remembered for the next dialog");
  for (const [url, fromMain] of [
    ["blob:app://tavrn/1", false],
    ["file:///etc/passwd", true],
    ["javascript:alert(1)", true],
  ] as const) {
    const other = new FakeItem(url, "x");
    handleWillDownload(other, fromMain, downloads);
    assert.equal(other.cancelled, true, `${url} ${fromMain}`);
  }
});

test("the safety net with the test hook saves into its directory", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "tavrn-electron-save-"));
  t.after(() => rmSync(testDir, { recursive: true, force: true }));
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "a.txt"), "old");
  const { downloads } = setup(t, { testDir });
  const item = new FakeItem("data:text/plain,hi", "a.txt");
  handleWillDownload(item, true, downloads);
  assert.equal(item.savePath, join(testDir, "a (1).txt"));
  assert.equal(item.dialog, null);
});
