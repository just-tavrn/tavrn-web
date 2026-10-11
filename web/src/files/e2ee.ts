// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end encrypted files channels in the web client (tavrn-protocol/FILES.md §8): decrypting entry records
 * into the entries the browser shows, encrypted uploads (chunked file encryption, a client-made thumbnail, the
 * record under the channel's current epoch), folders, renames, downloads that decrypt chunk by chunk, the
 * thumbnail cache, the "cannot decrypt" state shared with text channels and the local search index entries.
 *
 * The node never sees a name, type or content; it lists entries with their records, which only members of the
 * record's epoch can open. Entries whose record this device cannot open are listed as locked with their size and
 * date, and their owner can still delete them ("Your files").
 */
import { forgetGhostAck, isGhostRefusal } from "../components/GhostGate";
import { newUlid as ulid, type FileEntry, type TavrnApi } from "@tavrn/sdk";
import {
  decryptFileChunks,
  decryptFileBytes,
  decryptFileRecord,
  encryptFileBytes,
  encryptFileRecord,
  encryptFileStream,
  entryName,
  fileKeyText,
  newFileKey,
  recordKey,
  type FileRecord,
  type FileRecordResult,
  type IndexedMessage,
  type MlsManager,
  type RecordEntry,
} from "@tavrn/e2ee";
import { classifyFile, declaredCategory } from "../lib/uploads";
import { safeBlobType } from "../lib/preview";
import type { E2eePhase } from "../hooks/useE2eeConversation";

export type FilesApi = Pick<TavrnApi, "files">;

/** Why entries of a channel cannot be read on this device (the same states the message list shows). */
export type FilesLockState = "locked" | "joining" | "no_group" | "missing_keys" | "error" | null;

/**
 * The lock state of an encrypted files channel: the device (key store locked, no session manager), the group
 * (not joined yet, none created yet) or records whose epochs this device does not hold.
 */
export function filesLockState(phase: E2eePhase, results: ReadonlyMap<string, FileRecordResult>): FilesLockState {
  if (phase === "locked") return "locked";
  if (phase === "error") return "error";
  if (phase === "joining") return "joining";
  if (phase === "no_group") return "no_group";
  for (const r of results.values()) if (!r.ok && (r.reason === "missing_key" || r.reason === "withheld")) return "missing_keys";
  return null;
}

/**
 * The entries as the browser shows them: name, type and plaintext size from the record; entries without a readable
 * record keep their (ciphertext) size and get the locked label.
 */
export function displayEntries(raw: readonly FileEntry[], results: ReadonlyMap<string, FileRecordResult>, locked: { file: string; folder: string }): FileEntry[] {
  return raw.map((e) => {
    const r = results.get(e.id);
    if (r?.ok) return { ...e, name: r.record.name, mime: r.record.mime, size: r.record.kind === "file" ? r.record.size : 0 };
    return { ...e, name: e.kind === "folder" ? locked.folder : locked.file, mime: "" };
  });
}

/** `name (n).ext` (the node's rule of FILES.md §3 `Tavrn-Conflict: rename`, applied by the client). */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  if (dot > 0 && ext.length > 0 && ext.length <= 16) return `${stem} (${n}).${ext}`;
  return `${name} (${n})`;
}

/** The first free name for `name` among `taken` (case-insensitive, like the node for unencrypted channels). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n <= 1000; n++) {
    const candidate = numberedName(name, n);
    if ([...candidate].length <= 255 && !lower.has(candidate.toLowerCase())) return candidate;
  }
  return numberedName(name, Date.now());
}

/** Decrypts the records of `entries` (local; cached by the session manager). */
export async function decryptRecords(mls: Pick<MlsManager, "decrypt">, conversation: string, entries: readonly RecordEntry[]): Promise<Map<string, FileRecordResult>> {
  const out = new Map<string, FileRecordResult>();
  for (const e of entries) out.set(e.id, await decryptFileRecord(mls, conversation, e).catch(() => ({ ok: false, reason: "invalid" }) as const));
  return out;
}

// ---------------------------------------------------------------- Thumbnails

export const THUMB_MAX = 320;

/** A small WebP (or JPEG) of a raster image, made in the browser; null when the platform cannot. */
export async function makeThumbnail(file: Blob): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number } | null> {
  if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(file.type) || typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    for (const mime of ["image/webp", "image/jpeg"]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.8));
      if (blob && blob.type === mime) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, width, height };
    }
    return null;
  } catch {
    return null;
  }
}

/** Decrypted thumbnails of this session as object URLs (never stored, never in the search index). */
const thumbnails = new Map<string, Promise<string | null>>();

/** Sign-out: the decrypted thumbnails of this session go (their object URLs are revoked). */
export function forgetThumbnails(): void {
  const all = [...thumbnails.values()];
  thumbnails.clear();
  for (const p of all) void p.then((url) => url && URL.revokeObjectURL(url));
}

/** The thumbnail of an entry as an object URL (fetched and decrypted once per session), or null. */
export function thumbnailUrl(api: FilesApi, roomId: string, channelId: string, entry: Pick<FileEntry, "id">, record: FileRecord): Promise<string | null> {
  if (!record.thumbnail) return Promise.resolve(null);
  const key = `${channelId}|${entry.id}|${record.key}`;
  let p = thumbnails.get(key);
  if (!p) {
    const mime = record.thumbnail.mime;
    p = (async () => {
      const bytes = await api.files.thumbnail(roomId, channelId, entry.id);
      if (!bytes) return null;
      const fileKey = recordKey(record);
      try {
        const plain = await decryptFileBytes(fileKey, "thumbnail", bytes);
        return URL.createObjectURL(new Blob([plain as Uint8Array<ArrayBuffer>], { type: safeBlobType(mime) }));
      } finally {
        fileKey.fill(0);
      }
    })().catch(() => null);
    thumbnails.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------- Writing

export interface EncryptedContext {
  api: FilesApi;
  mls: Pick<MlsManager, "encrypt">;
  /** Qualified conversation id of the channel. */
  conversation: string;
  roomId: string;
  channelId: string;
}

/** Uploads a file: chunked encryption, thumbnail, record under the current epoch, then the thumbnail. */
export async function uploadEncrypted(
  ctx: EncryptedContext,
  file: File,
  opts: { parentId: string | null; name: string; onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<FileEntry> {
  const name = entryName(opts.name);
  if (!name) throw new RangeError("invalid name");
  const fileKey = newFileKey();
  try {
    const [classified, thumb] = await Promise.all([classifyFile(file), makeThumbnail(file)]);
    const { blob } = await encryptFileStream(file, { fileKey, signal: opts.signal, onProgress: (f) => opts.onProgress?.(f * 0.1) });
    const id = ulid();
    const mime = (file.type || "application/octet-stream").toLowerCase();
    const record: FileRecord = { entry: id, kind: "file", name, mime, size: file.size, key: fileKeyText(fileKey), ...(thumb ? { thumbnail: { mime: thumb.mime, width: thumb.width, height: thumb.height } } : {}) };
    const enc = await sealRecord(ctx, record);
    const entry = await ctx.api.files.uploadEncrypted(ctx.roomId, ctx.channelId, blob, {
      id,
      record: enc.record,
      recordEpoch: enc.record_epoch,
      category: declaredCategory(classified),
      parentId: opts.parentId,
      signal: opts.signal,
      onProgress: (f) => opts.onProgress?.(0.1 + f * 0.9),
    });
    if (thumb) {
      const ct = await encryptFileBytes(fileKey, "thumbnail", thumb.bytes);
      await ctx.api.files.putThumbnail(ctx.roomId, ctx.channelId, id, ct).catch(() => undefined);
    }
    return entry;
  } finally {
    fileKey.fill(0);
  }
}

/** Encrypts an entry record; a refusal for an unacknowledged ghost leaf shows the view's warning again (§4.6). */
async function sealRecord(ctx: EncryptedContext, record: FileRecord): Promise<{ record: string; record_epoch: number }> {
  try {
    return await encryptFileRecord(ctx.mls, ctx.conversation, record);
  } catch (e) {
    if (isGhostRefusal(e)) forgetGhostAck(ctx.conversation);
    throw e;
  }
}

/** Creates a folder with its record. */
export async function createFolderEncrypted(ctx: EncryptedContext, rawName: string, parentId: string | null): Promise<FileEntry> {
  const name = entryName(rawName);
  if (!name) throw new RangeError("invalid name");
  const id = ulid();
  const enc = await sealRecord(ctx, { entry: id, kind: "folder", name, mime: "", size: 0, key: "" });
  return ctx.api.files.createFolderEncrypted(ctx.roomId, ctx.channelId, { id, ...enc, parent_id: parentId });
}

/** Renames an entry: a new record (same key and type) under the current epoch. */
export async function renameEncrypted(ctx: EncryptedContext, entry: Pick<FileEntry, "id">, record: FileRecord, rawName: string): Promise<FileEntry> {
  const name = entryName(rawName);
  if (!name) throw new RangeError("invalid name");
  const enc = await sealRecord(ctx, { ...record, entry: entry.id, name });
  return ctx.api.files.update(ctx.roomId, ctx.channelId, entry.id, enc);
}

// ---------------------------------------------------------------- Reading

/** Downloads and decrypts a file chunk by chunk into a Blob typed for safe display (`safeBlobType`). */
export async function loadEncrypted(api: FilesApi, roomId: string, channelId: string, entry: Pick<FileEntry, "id" | "size">, record: FileRecord): Promise<Blob> {
  const resp = await api.files.downloadResponse(roomId, channelId, entry.id);
  if (!resp.body) throw new Error("empty download");
  const fileKey = recordKey(record);
  try {
    const plain = resp.body.pipeThrough(decryptFileChunks(fileKey, "content", entry.size));
    const parts: BlobPart[] = [];
    const reader = plain.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as Uint8Array<ArrayBuffer>);
    }
    return new Blob(parts, { type: safeBlobType(record.mime, record.name) });
  } finally {
    fileKey.fill(0);
  }
}

// ---------------------------------------------------------------- Local search (SEARCH.md §3.6)

/** The upload category of a decrypted entry for the search filters (PROTOCOL.md §7a table, by type and name). */
export function entryCategory(record: Pick<FileRecord, "kind" | "mime" | "name">): string {
  if (record.kind === "folder") return "";
  const m = record.mime;
  const ext = record.name.includes(".") ? record.name.slice(record.name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (m.startsWith("image/") && m !== "image/svg+xml") return "images";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"].includes(ext) || /zip|x-7z|rar|tar|gzip|bzip|xz|zstd/.test(m)) return "archives";
  if (m.startsWith("text/") || m === "application/pdf" || m === "image/svg+xml" || /json|xml|rtf|officedocument|opendocument|msword|ms-excel|ms-powerpoint|epub/.test(m)) return "documents";
  return "other";
}

/**
 * Index entries of decrypted records: name and folder path as text, the uploader as author, the upload date as
 * time. `paths` maps folder ids to their path ("A/B"); `uploader` resolves user ids to addresses.
 */
export function fileIndexEntries(
  conversation: string,
  roomId: string,
  entries: readonly FileEntry[],
  results: ReadonlyMap<string, FileRecordResult>,
  folderPath: (parentId: string | null) => string,
  uploader: (e: FileEntry) => string,
): IndexedMessage[] {
  const out: IndexedMessage[] = [];
  for (const e of entries) {
    const r = results.get(e.id);
    if (!r?.ok) continue;
    const ts = Date.parse(e.created_at);
    if (!Number.isFinite(ts)) continue;
    const folder = folderPath(e.parent_id ?? null);
    out.push({
      conversation,
      id: e.id,
      ts,
      author: uploader(e),
      text: folder ? `${r.record.name}\n${folder}` : r.record.name,
      files: [],
      room: roomId,
      file: { kind: r.record.kind, name: r.record.name, folder, mime: r.record.mime, category: entryCategory(r.record), size: r.record.size, thumbnail: !!r.record.thumbnail, parent: e.parent_id ?? null },
    });
  }
  return out;
}
