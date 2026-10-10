// SPDX-License-Identifier: Apache-2.0
/**
 * The one entry point for saving a file the user downloads (attachments, files channels, exports, recovery codes,
 * whiteboard exports): the browser's download, or the desktop app's save dialog (docs/DESKTOP.md "Downloads").
 * After a save in the desktop app a toast says where the file went and offers to show it in its folder.
 * Previews and playback keep their object URLs; only saving goes through here.
 */
import { t } from "../i18n";
import { toastError, useToasts } from "../stores/toasts";
import { browserSaveFile, type SaveFileOutcome, type SaveFileRequest } from "./files";
import { platform } from "./index";

export type { SaveFileOutcome, SaveFileRequest } from "./files";

/** Saves a file; rejects when the platform could not (the caller shows the error). */
export async function saveFile(file: SaveFileRequest): Promise<SaveFileOutcome> {
  const out = await (platform().saveFile ?? browserSaveFile)(file);
  if (out.status === "saved") {
    const reveal = out.reveal;
    useToasts.getState().push({
      kind: "info",
      title: t("download.saved", { folder: out.folder }),
      detail: out.name,
      testId: "download-saved",
      ...(reveal ? { action: { label: t("download.show_in_folder"), run: () => void reveal().catch((e: unknown) => toastError(e)) } } : {}),
    });
  }
  return out;
}
