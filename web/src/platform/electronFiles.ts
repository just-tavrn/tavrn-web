// SPDX-License-Identifier: Apache-2.0
/**
 * Downloads in the Linux app (docs/DESKTOP.md "Downloads"): the Electron shell shows the save dialog and writes the
 * file itself (`apps/desktop-electron/src/main/downloads.ts`), exactly like the Tauri shell (`tauriFiles.ts`); the
 * client only streams the content. `saveFileBegin` opens the dialog and answers with the save's id (or `cancelled`),
 * `saveFileChunk` appends at most {@link SAVE_CHUNK_BYTES}, `saveFileEnd` moves the finished file into place,
 * `saveFileAbort` removes it. The page never names a path: the shell owns them, and "show in folder" asks by the
 * save's id.
 */
import type { TavrnShellBridge } from "./electronBridge";
import { asBlob, SAVE_CHUNK_BYTES, type SaveFile } from "./files";

/** Saving through the bridge's `files` namespace, the file streamed in 4 MiB pieces. */
export function createElectronSaveFile(files: TavrnShellBridge["files"]): SaveFile {
  return async (file) => {
    const blob = asBlob(file);
    const mime = file.mime || blob.type || "application/octet-stream";
    const begin = await files.saveFileBegin(file.name, mime, blob.size);
    if (begin.status !== "ready") return { status: "cancelled" };
    const { id } = begin;
    try {
      for (let offset = 0; offset < blob.size; offset += SAVE_CHUNK_BYTES) {
        await files.saveFileChunk(id, new Uint8Array(await blob.slice(offset, offset + SAVE_CHUNK_BYTES).arrayBuffer()));
      }
      const saved = await files.saveFileEnd(id);
      return { status: "saved", name: file.name, path: saved.path, folder: saved.folder, reveal: () => files.saveFileReveal(id) };
    } catch (e) {
      await files.saveFileAbort(id).catch(() => {});
      throw e;
    }
  };
}
