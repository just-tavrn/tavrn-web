// SPDX-License-Identifier: Apache-2.0
/**
 * Downloads (docs/DESKTOP.md "Downloads", the Tauri shell's `download.rs`). The client saves files through the shell
 * (`web/src/platform/electronFiles.ts`):
 *
 * - `saveFileBegin(name, mime, size)` shows the native save dialog (the cleaned name is only its suggestion; it opens
 *   in the directory used last, at first in Downloads) and answers with the save's id, or `cancelled`;
 * - `saveFileChunk(id, bytes)` appends at most 4 MiB to a temporary file next to the target;
 * - `saveFileEnd(id)` checks the size, flushes and renames the temporary file into place; `saveFileAbort(id)` removes it;
 * - `saveFileReveal(id)` shows a finished file in its folder.
 *
 * The shell owns every path: the page never names one (only a file name to suggest, and the save's id), and nothing is
 * written outside the directory the user chose.
 *
 * A safety net catches downloads the page starts by itself (an `<a download>`, a navigation to a file): the session's
 * `will-download` gives them the same save dialog; downloads of any other web contents are cancelled.
 *
 * Test hook: with `TAVRN_DESKTOP_TEST_SAVE_DIR=<dir>` set when the app starts, no dialog is shown and files are saved
 * into that directory, never overwriting (`name (1).ext`). Never set it otherwise.
 */
import { existsSync, rmSync } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { check, type IpcRegistry } from "./ipc.ts";

/** The environment variable of the test hook. */
export const TEST_SAVE_DIR_ENV = "TAVRN_DESKTOP_TEST_SAVE_DIR";
/** Saves that may run at the same time. */
export const MAX_ACTIVE = 8;
/** Finished saves that "show in folder" still finds. */
const MAX_SAVED = 32;
/** Longest file name (bytes) the shell suggests or writes. */
export const MAX_NAME_BYTES = 200;
/** Largest piece of a save (the client sends 4 MiB). */
export const CHUNK_MAX = 4 * 1024 * 1024;

export type DownloadCode =
  | "download.unknown"
  | "download.duplicate"
  | "download.busy"
  | "download.too_large"
  | "download.incomplete"
  | "download.write_failed"
  | "download.dialog_failed"
  | "download.reveal_failed";

function truncateKeepingExtension(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 && name.length - dot - 1 <= 16 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let out = "";
  let bytes = Buffer.byteLength(ext);
  for (const c of stem) {
    const b = Buffer.byteLength(c);
    if (bytes + b > max) break;
    out += c;
    bytes += b;
  }
  return out + ext;
}

/**
 * A file name the shell can suggest and write: the last path component, without control characters, characters Windows
 * refuses, leading dots, trailing dots and spaces, or reserved device names; at most {@link MAX_NAME_BYTES} bytes (the
 * extension kept); `download` when nothing is left.
 */
export function safeFileName(name: string): string {
  const last = name.split(/[/\\]/).at(-1) ?? "";
  const cleaned = [...last].map((c) => (/[\p{Cc}<>:"|?*]/u.test(c) ? "_" : c)).join("");
  const trimmed = cleaned.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  let out = truncateKeepingExtension(trimmed, MAX_NAME_BYTES);
  const stem = (out.split(".")[0] ?? "").trimEnd().toUpperCase();
  if (["CON", "PRN", "AUX", "NUL"].includes(stem) || /^(COM|LPT)[0-9]$/.test(stem)) out = `_${out}`;
  return out || "download";
}

/** The extension of a file name for the dialog's filter (1 to 10 ASCII letters or digits), if any. */
export function extension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : null;
}

/** `dir/name`, or `dir/name (1).ext`, `(2)`, … when that file exists or a running save holds the name. */
export function uniqueTarget(dir: string, name: string, taken: ReadonlySet<string> = new Set()): string {
  const free = (p: string) => !existsSync(p) && !taken.has(p);
  const first = join(dir, name);
  if (free(first)) return first;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n < 10_000; n++) {
    const p = join(dir, `${stem} (${n})${ext}`);
    if (free(p)) return p;
  }
  return first;
}

/** The options of the native save dialog for `name`, opening in `dir`. */
export function saveDialogOptions(name: string, dir: string) {
  const ext = extension(name);
  return {
    defaultPath: join(dir, name),
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
    properties: ["createDirectory" as const, "showOverwriteConfirmation" as const],
  };
}

/** One file being written: a temporary file next to the target, renamed into place when all announced bytes arrived. */
export class ChunkWriter {
  readonly target: string;
  readonly tempPath: string;
  readonly #size: number;
  #file: FileHandle | null;
  #written = 0;
  /** Writes of this file, one after the other. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(target: string, temp: string, file: FileHandle, size: number) {
    this.target = target;
    this.tempPath = temp;
    this.#file = file;
    this.#size = size;
  }

  /** Creates the temporary file (a new file, never an existing one) in the target's directory. */
  static async begin(target: string, size: number): Promise<ChunkWriter> {
    const dir = dirname(target);
    const base = truncateKeepingExtension(basename(target) || "download", MAX_NAME_BYTES);
    for (let n = 0; n < 100; n++) {
      const temp = join(dir, `.${base}.${process.pid}-${n}.part`);
      try {
        return new ChunkWriter(target, temp, await open(temp, "wx", 0o600), size);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw new Error("no free temporary name");
  }

  /** Appends `bytes`; refuses more than the announced size (the save stays running, the caller aborts it). */
  write(bytes: Uint8Array): Promise<void> {
    if (this.#written + bytes.byteLength > this.#size) return Promise.reject("download.too_large" satisfies DownloadCode);
    this.#written += bytes.byteLength;
    const copy = Buffer.from(bytes);
    const next = this.#queue.then(async () => {
      const file = this.#file;
      if (!file) throw "download.write_failed" satisfies DownloadCode;
      try {
        for (let at = 0; at < copy.length; ) at += (await file.write(copy, at, copy.length - at)).bytesWritten;
      } catch {
        throw "download.write_failed" satisfies DownloadCode;
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Flushes the file to disk and renames it into place; returns the target. A failure removes the temporary file. */
  async finish(): Promise<string> {
    await this.#queue;
    if (this.#written !== this.#size) {
      await this.abort();
      throw "download.incomplete" satisfies DownloadCode;
    }
    try {
      const file = this.#file;
      this.#file = null;
      if (!file) throw new Error("closed");
      await file.sync();
      await file.close();
      await rename(this.tempPath, this.target);
      return this.target;
    } catch {
      await rm(this.tempPath, { force: true });
      throw "download.write_failed" satisfies DownloadCode;
    }
  }

  /** Closes and removes the temporary file. */
  async abort(): Promise<void> {
    const file = this.#file;
    this.#file = null;
    await file?.close().catch(() => undefined);
    await rm(this.tempPath, { force: true });
  }

  /** Removes the temporary file at once (the app quits). */
  abortNow(): void {
    void this.#file?.close().catch(() => undefined);
    this.#file = null;
    rmSync(this.tempPath, { force: true });
  }
}

export interface DownloadsDeps {
  /** The test hook's directory (no dialog), or null. */
  testDir: string | null;
  /** The user's Downloads directory (`app.getPath("downloads")`). */
  downloadsDir(): string;
  /** Shows the save dialog for `name` opening in `defaultDir`; the chosen path, or null when cancelled. */
  chooseTarget(name: string, defaultDir: string): Promise<string | null>;
  /** Shows a file in the file manager (`shell.showItemInFolder`). */
  reveal(path: string): void;
}

export type Begin = { status: "ready"; id: string } | { status: "cancelled" };
export interface Saved {
  path: string;
  /** The name of the directory ("Downloads"), for "Saved to …". */
  folder: string;
}

function saved(path: string): Saved {
  const dir = dirname(path);
  return { path, folder: basename(dir) || dir };
}

/** The running and the recently finished saves. */
export class Downloads {
  readonly #deps: DownloadsDeps;
  #nextId = 0;
  #lastDir: string | null = null;
  readonly #active = new Map<string, ChunkWriter>();
  /** Saves between the dialog and their writer (they count against the limit). */
  #starting = 0;
  readonly #saved: Array<[string, string]> = [];

  constructor(deps: DownloadsDeps) {
    this.#deps = deps;
  }

  get testDir(): string | null {
    return this.#deps.testDir;
  }

  /** Where the next dialog opens: the directory used last, at first the Downloads directory. */
  defaultDir(): string {
    return this.#lastDir ?? this.#deps.downloadsDir();
  }

  /** Remembers the directory of a file the user saved. */
  remember(path: string): void {
    this.#lastDir = dirname(path);
  }

  /** Names the running saves hold (the test hook never hands one out twice). */
  taken(): Set<string> {
    return new Set([...this.#active.values()].map((w) => w.target));
  }

  async begin(name: string, size: number): Promise<Begin> {
    if (this.#active.size + this.#starting >= MAX_ACTIVE) throw "download.busy" satisfies DownloadCode;
    this.#starting++;
    try {
      const clean = safeFileName(name);
      let target: string | null;
      if (this.#deps.testDir) target = uniqueTarget(this.#deps.testDir, clean, this.taken());
      else {
        try {
          target = await this.#deps.chooseTarget(clean, this.defaultDir());
        } catch {
          throw "download.dialog_failed" satisfies DownloadCode;
        }
        if (target) this.remember(target);
      }
      if (!target) return { status: "cancelled" };
      let writer: ChunkWriter;
      try {
        writer = await ChunkWriter.begin(target, size);
      } catch {
        throw "download.write_failed" satisfies DownloadCode;
      }
      const id = String(++this.#nextId);
      this.#active.set(id, writer);
      return { status: "ready", id };
    } finally {
      this.#starting--;
    }
  }

  chunk(id: string, bytes: Uint8Array): Promise<void> {
    const writer = this.#active.get(id);
    if (!writer) return Promise.reject("download.unknown" satisfies DownloadCode);
    return writer.write(bytes);
  }

  /** Finishes the save (also when that fails, the save is over and its temporary file removed). */
  async end(id: string): Promise<Saved> {
    const writer = this.#active.get(id);
    if (!writer) throw "download.unknown" satisfies DownloadCode;
    this.#active.delete(id);
    const path = await writer.finish();
    if (this.#saved.length >= MAX_SAVED) this.#saved.shift();
    this.#saved.push([id, path]);
    return saved(path);
  }

  async abort(id: string): Promise<void> {
    const writer = this.#active.get(id);
    this.#active.delete(id);
    await writer?.abort();
  }

  /** Removes the temporary files of every running save (the app quits). */
  abortAll(): void {
    for (const writer of this.#active.values()) writer.abortNow();
    this.#active.clear();
  }

  /** Shows a finished save in the file manager. */
  reveal(id: string): void {
    const path = this.#saved.findLast(([i]) => i === id)?.[1];
    if (!path) throw "download.unknown" satisfies DownloadCode;
    if (!existsSync(path)) throw "download.reveal_failed" satisfies DownloadCode;
    this.#deps.reveal(path);
  }
}

/** The `files` namespace of the bridge. */
export function registerFilesHandlers(registry: IpcRegistry, deps: { downloads: Downloads }): void {
  const id = check.string(32);
  const d = deps.downloads;
  registry.handle("files", "saveFileBegin", check.args([check.string(4096), check.string(255), check.int(0, Number.MAX_SAFE_INTEGER)]), (name: string, _mime: string, size: number) => d.begin(name, size));
  registry.handle("files", "saveFileChunk", check.args([id, check.bytes(CHUNK_MAX)]), (i: string, bytes: Uint8Array) => d.chunk(i, bytes));
  registry.handle("files", "saveFileEnd", check.args([id]), (i: string) => d.end(i));
  registry.handle("files", "saveFileAbort", check.args([id]), (i: string) => d.abort(i));
  registry.handle("files", "saveFileReveal", check.args([id]), (i: string) => d.reveal(i));
}

/** The part of Electron's `DownloadItem` the safety net uses. */
export interface DownloadItemLike {
  getURL(): string;
  getFilename(): string;
  setSavePath(path: string): void;
  getSavePath(): string;
  setSaveDialogOptions(options: ReturnType<typeof saveDialogOptions>): void;
  cancel(): void;
  once(event: "done", listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void): unknown;
}

/** Downloads the page may start: the client's own blob and data URLs and files of the bundle or the web. */
const ALLOWED_SCHEMES = ["blob:", "data:", "https:", "http:", "app:"];

/**
 * The safety net (`session.on("will-download")`): a download the main window starts itself gets the same save dialog
 * (Electron's, with the cleaned name, opening where the last save went), or the test hook's directory; downloads of
 * other web contents and of other schemes are cancelled.
 */
export function handleWillDownload(item: DownloadItemLike, fromMainWindow: boolean, downloads: Downloads): void {
  let scheme = "";
  try {
    scheme = new URL(item.getURL()).protocol;
  } catch {
    scheme = "";
  }
  if (!fromMainWindow || !ALLOWED_SCHEMES.includes(scheme)) {
    item.cancel();
    return;
  }
  const name = safeFileName(item.getFilename());
  if (downloads.testDir) item.setSavePath(uniqueTarget(downloads.testDir, name, downloads.taken()));
  else item.setSaveDialogOptions(saveDialogOptions(name, downloads.defaultDir()));
  item.once("done", (_event, state) => {
    if (state === "completed" && !downloads.testDir && item.getSavePath()) downloads.remember(item.getSavePath());
  });
}
