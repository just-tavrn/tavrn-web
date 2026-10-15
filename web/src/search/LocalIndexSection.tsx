// SPDX-License-Identifier: Apache-2.0
/** User settings: the local search index of this device (design note 4.4, tavrn-protocol/SEARCH.md §3). */
import { useEffect, useState } from "react";
import { DEFAULT_WINDOW_DAYS, DEFAULT_MAX_BYTES } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { Button, Field } from "../components/ui";
import { Section, Select } from "../pages/settings/common";
import { HISTORY_CAP_CHOICES_MB, enforceHistoryCap, historyCapBytes, setHistoryCapMb } from "../history/local";
import { useE2ee } from "../stores/e2ee";
import { toastError } from "../stores/toasts";
import { useAction } from "../hooks/useAction";
import { confirmDialog } from "../components/Confirm";
import { clearLocalIndex, localIndex, rebuildLocalIndex, refreshLocalState, useLocalSearch } from "./local";
import { wakeSearchSync } from "./sync";

/** `12.3 MB` */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function LocalIndexSection() {
  const t = useT();
  const unlocked = useE2ee((s) => s.status === "unlocked");
  const stats = useLocalSearch((s) => s.stats);
  const syncing = useLocalSearch((s) => Object.keys(s.syncing).length);
  const history = useLocalSearch((s) => s.history);
  const historyBytes = Object.values(history).reduce((a, b) => a + b, 0);
  const [capMb, setCapMb] = useState(() => historyCapBytes() / 1024 / 1024);
  const { run, busy } = useAction({ refresh: wakeSearchSync });
  useEffect(() => {
    if (unlocked) void localIndex().then((i) => refreshLocalState(i));
  }, [unlocked]);
  const act = (fn: () => Promise<void>, done: string) => run(fn, { done });
  return (
    <Section title={t("search.settings.title")} description={t("search.settings.description", { days: DEFAULT_WINDOW_DAYS, mb: Math.round(DEFAULT_MAX_BYTES / 1024 / 1024) })}>
      {!unlocked ? (
        <p className="text-sm text-fg-2" data-testid="local-index-locked">
          {t("search.settings.locked")}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="local-index-stats">
            <dt className="text-fg-2">{t("search.settings.size")}</dt>
            <dd data-testid="local-index-size">{stats ? formatBytes(stats.bytes) : "…"}</dd>
            <dt className="text-fg-2">{t("search.settings.conversations")}</dt>
            <dd data-testid="local-index-conversations">{stats?.conversations ?? "…"}</dd>
            <dt className="text-fg-2">{t("search.settings.messages")}</dt>
            <dd data-testid="local-index-messages">{stats?.messages ?? "…"}</dd>
            <dt className="text-fg-2">{t("search.settings.complete")}</dt>
            <dd data-testid="local-index-complete">{stats?.complete ?? "…"}</dd>
          </dl>
          {syncing > 0 && <p className="text-xs text-fg-2">{t("search.settings.syncing")}</p>}
          {/* The archived full history (#4): what it takes and the space per conversation. */}
          <div className="space-y-2 border-t border-line pt-3" data-testid="local-history">
            <h3 className="text-sm font-medium">{t("search.settings.history_title")}</h3>
            <p className="text-xs text-fg-2">{t("search.settings.history_hint")}</p>
            <p className="text-sm" data-testid="local-history-usage">
              {t("search.settings.history_usage", { size: formatBytes(historyBytes), count: Object.keys(history).length })}
            </p>
            <Field label={t("search.settings.history_cap")}>
              <Select
                value={String(capMb)}
                onChange={(e) => {
                  const mb = Number(e.target.value);
                  setHistoryCapMb(mb);
                  setCapMb(mb);
                  void enforceHistoryCap().catch(toastError);
                }}
                data-testid="local-history-cap"
              >
                {HISTORY_CAP_CHOICES_MB.map((mb) => (
                  <option key={mb} value={mb}>
                    {mb} MB
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => void act(rebuildLocalIndex, t("search.settings.rebuilt"))} data-testid="local-index-rebuild">
              {t("search.settings.rebuild")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (await confirmDialog({ title: t("search.settings.clear"), text: t("search.settings.clear_confirm"), confirmLabel: t("search.settings.clear"), danger: true })) await act(clearLocalIndex, t("search.settings.cleared"));
              }}
              data-testid="local-index-clear"
            >
              {t("search.settings.clear")}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}
