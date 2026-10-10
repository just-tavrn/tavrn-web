// SPDX-License-Identifier: Apache-2.0
/**
 * The question before an executable or a script is saved (lib/download.ts). A modal dialog (focus trapped, Escape
 * cancels); Cancel comes first and takes the focus, so Enter never downloads by accident.
 */
import { useEffect } from "react";
import { useT } from "../i18n";
import { answerDownloadWarning, useDownloadWarning } from "../stores/downloadWarning";
import { Button, Dialog } from "./ui";

export function DownloadWarningDialog() {
  const t = useT();
  const pending = useDownloadWarning((s) => s.pending);
  useEffect(() => {
    useDownloadWarning.setState((s) => ({ dialogs: s.dialogs + 1 }));
    return () => useDownloadWarning.setState((s) => ({ dialogs: s.dialogs - 1 }));
  }, []);
  return (
    <Dialog title={t("download_warning.title")} open={!!pending} onClose={() => answerDownloadWarning(false)}>
      {pending && (
        <div className="space-y-3 text-sm text-fg-1" data-testid="download-warning">
          <dl className="space-y-1 rounded-md border border-line bg-bg-0 px-3 py-2">
            <div className="flex gap-2">
              <dt className="shrink-0 text-fg-2">{t("download_warning.file")}</dt>
              <dd className="min-w-0 break-all font-medium text-fg-0" data-testid="download-warning-name">
                {pending.name}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-fg-2">{t("download_warning.kind_label")}</dt>
              <dd className="min-w-0 text-fg-0" data-testid="download-warning-kind" data-kind={pending.kind}>
                {t(`download_warning.kind.${pending.kind}`)}
              </dd>
            </div>
          </dl>
          <p>{t("download_warning.text")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => answerDownloadWarning(false)} data-testid="download-warning-cancel">
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => answerDownloadWarning(true)} data-testid="download-warning-anyway">
              {t("download_warning.anyway")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
