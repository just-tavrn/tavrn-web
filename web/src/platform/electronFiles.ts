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
import { chunkedSaveFile, type SaveFile } from "./files";

/** Saving through the bridge's `files` namespace, the file streamed in 4 MiB pieces. */
export function createElectronSaveFile(files: TavrnShellBridge["files"]): SaveFile {
  return chunkedSaveFile({
    begin: (name, mime, size) => files.saveFileBegin(name, mime, size),
    chunk: (id, bytes) => files.saveFileChunk(id, bytes),
    end: (id) => files.saveFileEnd(id),
    abort: (id) => files.saveFileAbort(id),
    reveal: (id) => files.saveFileReveal(id),
  });
}
