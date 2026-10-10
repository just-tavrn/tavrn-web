// SPDX-License-Identifier: Apache-2.0
import { t } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { saveFile } from "../../platform/saveFile";

/** Saves `text` as a file (the browser's download, the desktop app's save dialog); a failure becomes a toast. */
export async function downloadText(filename: string, text: string): Promise<void> {
  try {
    await saveFile({ name: filename, data: new Blob([text], { type: "text/plain;charset=utf-8" }), mime: "text/plain;charset=utf-8" });
  } catch (e) {
    toastError(e);
  }
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useToasts.getState().push({ kind: "info", title: t("common.copied") });
  } catch {
    useToasts.getState().push({ kind: "warning", title: t("common.copy_failed") });
  }
}
