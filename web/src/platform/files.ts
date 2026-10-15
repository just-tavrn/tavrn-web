// SPDX-License-Identifier: Apache-2.0
/**
 * Downloads (docs/DESKTOP.md "Downloads"): what the client hands to the platform when the user saves a file, and the
 * browser's way of saving it (an anchor with `download` on an object URL). The desktop app saves through its shell
 * instead (`tauriFiles.ts`): its webview does nothing with blob downloads. Call sites use `saveFile.ts`.
 */

/** A file the user saves: its suggested name, its content and its type. */
export interface SaveFileRequest {
  name: string;
  data: Blob | Uint8Array;
  /** Type of the saved content (default: the blob's type, else `application/octet-stream`). */
  mime?: string;
}

/**
 * `started`: the browser took the download over (where it lands is the browser's business); `cancelled`: the user
 * closed the save dialog; `saved`: the desktop app wrote the file (`folder` is the name of its directory).
 */
export type SaveFileOutcome =
  | { status: "started" }
  | { status: "cancelled" }
  | { status: "saved"; name: string; path: string; folder: string; reveal?: () => Promise<void> };

export type SaveFile = (file: SaveFileRequest) => Promise<SaveFileOutcome>;

/** The desktop app streams a file to its shell in pieces of this size: a large file never sits twice in memory. */
export const SAVE_CHUNK_BYTES = 4 * 1024 * 1024;

/** A shell's save commands: the dialog, the chunks, the end (moves the file into place) and the abort. */
export interface ChunkedSave {
  begin(name: string, mime: string, size: number): Promise<{ status: "ready"; id: string } | { status: "cancelled" }>;
  chunk(id: string, bytes: Uint8Array): Promise<unknown>;
  /** The saved file (`name`: the name the shell gave it, when it chose another). */
  end(id: string): Promise<{ path?: string; folder?: string; name?: string }>;
  abort(id: string): Promise<unknown>;
  /** "Show in folder" of a finished save (shells without folders have none). */
  reveal?(id: string): Promise<void>;
  /** Bytes per chunk (default {@link SAVE_CHUNK_BYTES}). */
  chunkBytes?: number;
}

/**
 * Saving through a shell (`tauriFiles.ts`, `electronFiles.ts`, the Android app's `tauriAndroid.ts`): the dialog, then
 * the content streamed in chunks (a large file never sits twice in memory), then the end; any failure aborts the save
 * (the shell removes its temporary file) and is rethrown.
 */
export function chunkedSaveFile(t: ChunkedSave): SaveFile {
  const size = t.chunkBytes ?? SAVE_CHUNK_BYTES;
  return async (file) => {
    const blob = asBlob(file);
    const mime = file.mime || blob.type || "application/octet-stream";
    const begin = await t.begin(file.name, mime, blob.size);
    if (begin.status !== "ready") return { status: "cancelled" };
    const { id } = begin;
    try {
      for (let offset = 0; offset < blob.size; offset += size) await t.chunk(id, new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer()));
      const saved = await t.end(id);
      const reveal = t.reveal;
      return { status: "saved", name: saved.name || file.name, path: saved.path ?? "", folder: saved.folder ?? "", ...(reveal ? { reveal: () => reveal(id) } : {}) };
    } catch (e) {
      await Promise.resolve(t.abort(id)).catch(() => {});
      throw e;
    }
  };
}

/** The content as a blob of the wanted type. */
export function asBlob({ data, mime }: SaveFileRequest): Blob {
  if (data instanceof Blob) return mime && mime !== data.type ? data.slice(0, data.size, mime) : data;
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: mime || "application/octet-stream" });
}

/** The browser's download: an anchor with `download` on an object URL (revoked once the browser has taken it). */
export const browserSaveFile: SaveFile = async (file) => {
  const url = URL.createObjectURL(asBlob(file));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name || "download";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { status: "started" };
};
