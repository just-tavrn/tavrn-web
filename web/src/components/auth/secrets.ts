// SPDX-License-Identifier: Apache-2.0
import { t } from "../../i18n";
import { useToasts } from "../../stores/toasts";

/** Saves `text` as a file through the browser's download. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useToasts.getState().push({ kind: "info", title: t("common.copied") });
  } catch {
    useToasts.getState().push({ kind: "warning", title: t("common.copy_failed") });
  }
}
