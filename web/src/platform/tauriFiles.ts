// SPDX-License-Identifier: Apache-2.0
/**
 * Downloads in the desktop app (docs/DESKTOP.md "Downloads"): the shell shows the save dialog and writes the file
 * itself (`src-tauri/src/download.rs`); the client only streams the content. `save_file_begin` opens the dialog and
 * answers with the save's id (or `cancelled`), `save_file_chunk` appends a raw IPC body of at most
 * {@link SAVE_CHUNK_BYTES}, `save_file_end` moves the finished file into place, `save_file_abort` removes it. The
 * webview never names a path: the shell owns them, and "show in folder" asks by the save's id.
 */
import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { asBlob, SAVE_CHUNK_BYTES, type SaveFile } from "./files";

/** The shell's IPC (tests pass a fake). */
export type ShellCall = (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;

type Begin = { status: "ready"; id: string } | { status: "cancelled" };
interface Saved {
  path: string;
  folder: string;
}

export function createTauriSaveFile(call: ShellCall = invoke): SaveFile {
  return async (file) => {
    const blob = asBlob(file);
    const mime = file.mime || blob.type || "application/octet-stream";
    const begin = (await call("save_file_begin", { name: file.name, mime, size: blob.size })) as Begin;
    if (begin.status !== "ready") return { status: "cancelled" };
    const { id } = begin;
    try {
      for (let offset = 0; offset < blob.size; offset += SAVE_CHUNK_BYTES) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + SAVE_CHUNK_BYTES).arrayBuffer());
        await call("save_file_chunk", bytes, { headers: { "x-tavrn-save": id } });
      }
      const saved = (await call("save_file_end", { id })) as Saved;
      return { status: "saved", name: file.name, path: saved.path, folder: saved.folder, reveal: async () => void (await call("save_file_reveal", { id })) };
    } catch (e) {
      await call("save_file_abort", { id }).catch(() => {});
      throw e;
    }
  };
}
