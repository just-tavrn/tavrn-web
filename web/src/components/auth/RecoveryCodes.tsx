// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useT } from "../../i18n";
import { Button } from "../ui";
import { copyText, downloadText } from "./secrets";

/** The ten recovery codes, shown once, with copy/download and an "I saved them" confirmation. */
export function RecoveryCodesView({ codes, account, onDone, doneLabel }: { codes: string[]; account: string; onDone: () => void; doneLabel?: string }) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const text = `${t("codes.file_header", { account })}\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-1">{t("codes.intro")}</p>
      <ol className="grid grid-cols-1 gap-1 rounded-md border border-line bg-bg-0 p-3 font-mono text-sm min-[360px]:grid-cols-2" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => void copyText(codes.join("\n"))}>
          {t("common.copy")}
        </Button>
        <Button variant="ghost" onClick={() => void downloadText(`tavrn-recovery-codes-${account.split("@")[0]}.txt`, text)}>
          {t("common.download")}
        </Button>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t("codes.confirm")}</span>
      </label>
      <Button className="w-full" disabled={!saved} onClick={onDone}>
        {doneLabel ?? t("common.continue")}
      </Button>
    </div>
  );
}
