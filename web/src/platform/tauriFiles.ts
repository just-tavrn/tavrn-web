// SPDX-License-Identifier: Apache-2.0
/**
 * Downloads in the desktop app (docs/DESKTOP.md "Downloads"): the shell shows the save dialog and writes the file
 * itself (`src-tauri/src/download.rs`); the client only streams the content. `save_file_begin` opens the dialog and
 * answers with the save's id (or `cancelled`), `save_file_chunk` appends a raw IPC body of at most
 * {@link SAVE_CHUNK_BYTES}, `save_file_end` moves the finished file into place, `save_file_abort` removes it. The
 * webview never names a path: the shell owns them, and "show in folder" asks by the save's id.
 */
import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { chunkedSaveFile, type SaveFile } from "./files";

/** The shell's IPC (tests pass a fake). */
export type ShellCall = (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;

type Begin = { status: "ready"; id: string } | { status: "cancelled" };
interface Saved {
  path: string;
  folder: string;
}

export function createTauriSaveFile(call: ShellCall = invoke): SaveFile {
  return chunkedSaveFile({
    begin: async (name, mime, size) => (await call("save_file_begin", { name, mime, size })) as Begin,
    // A raw IPC body (no JSON number array), named by the save's id in a header.
    chunk: (id, bytes) => call("save_file_chunk", bytes, { headers: { "x-tavrn-save": id } }),
    end: async (id) => (await call("save_file_end", { id })) as Saved,
    abort: (id) => call("save_file_abort", { id }),
    reveal: async (id) => void (await call("save_file_reveal", { id })),
  });
}
