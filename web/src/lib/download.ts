// SPDX-License-Identifier: Apache-2.0
/**
 * Saving a file the user downloads from a conversation or a files channel (attachments, the media viewer, files
 * entries): executables and scripts ask first ("This file can run programs on your computer"), everything else is
 * saved at once. The check runs on the content that is about to be saved, so it covers encrypted files (decrypted
 * here) exactly like plaintext ones, with the node's rules (lib/uploads.ts `executableKind`; archives excluded).
 */
import { t } from "../i18n";
import { saveFile, type SaveFileOutcome, type SaveFileRequest } from "../platform/saveFile";
import { askDownloadAnyway } from "../stores/downloadWarning";
import { executableKind, readHead } from "./uploads";

/**
 * Saves `file` after the warning if it is an executable; `type` is the file's declared content type (the saved blob
 * may carry a neutralized one). Resolves `cancelled` when the user keeps it off the disk.
 */
export async function saveDownload(file: SaveFileRequest, type = file.mime ?? ""): Promise<SaveFileOutcome> {
  const kind = executableKind(file.name, type, await readHead(file.data));
  if (kind) {
    const fallback = () => window.confirm(`${t("download_warning.title")}\n\n${file.name} (${t(`download_warning.kind.${kind}`)})`);
    if (!(await askDownloadAnyway(file.name, kind, fallback))) return { status: "cancelled" };
  }
  return saveFile(file);
}
