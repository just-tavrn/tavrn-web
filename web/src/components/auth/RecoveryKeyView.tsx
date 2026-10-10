// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useT } from "../../i18n";
import { Button, ErrorText } from "../ui";
import { copyText, downloadText } from "./secrets";

export interface RecoveryKeyDisplay {
  words: string;
  compact: string;
  /** Text of the optional download file. */
  file: string;
}

/**
 * Shows a new recovery key once (24 words and the compact string) and asks the user to confirm
 * having saved it before `onConfirm` (which performs the upload) can run.
 */
export function RecoveryKeyView({ recoveryKey, account, onConfirm, confirmLabel, busy, error }: { recoveryKey: RecoveryKeyDisplay; account: string; onConfirm: () => void; confirmLabel: string; busy?: boolean; error?: string | null }) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const words = recoveryKey.words.split(" ");
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-1">{t("recovery_key.intro")}</p>
      <ol className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-line bg-bg-0 p-3 font-mono text-sm sm:grid-cols-3" data-testid="recovery-key-words" data-words={recoveryKey.words}>
        {words.map((w, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="w-5 text-right text-fg-2 select-none">{i + 1}.</span>
            <span>{w}</span>
          </li>
        ))}
      </ol>
      <div className="space-y-1">
        <p className="text-xs text-fg-2">{t("recovery_key.compact")}</p>
        <code className="block break-all rounded-md border border-line bg-bg-0 p-2 text-xs select-all" data-testid="recovery-key-compact">
          {recoveryKey.compact}
        </code>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => void copyText(recoveryKey.words)}>
          {t("recovery_key.copy_words")}
        </Button>
        <Button variant="ghost" onClick={() => void downloadText(`tavrn-recovery-${account.split("@")[0]}.txt`, recoveryKey.file)}>
          {t("common.download")}
        </Button>
      </div>
      <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1">{t("recovery_key.warning")}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t("recovery_key.confirm")}</span>
      </label>
      <ErrorText>{error}</ErrorText>
      <Button className="w-full" disabled={!saved || busy} onClick={onConfirm}>
        {busy ? t("auth.wait") : confirmLabel}
      </Button>
    </div>
  );
}
