// SPDX-License-Identifier: Apache-2.0
/**
 * "Game activity: allowed applications" (APPLICATIONS.md §7.3): the decisions stored on this device for
 * programs using the local activity bridge (always / never), each revocable so the application is asked
 * again next time.
 */
import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { Button } from "../components/ui";
import { Section } from "../pages/settings/common";
import { localConsentStore, onConsentChange, type ConsentEntry, type ConsentStore } from "./bridge";

export function AllowedAppsSection({ store: injected }: { store?: ConsentStore }) {
  const t = useT();
  const store = useMemo(() => injected ?? localConsentStore(), [injected]);
  const [entries, setEntries] = useState<ConsentEntry[]>(() => store.list());
  useEffect(() => {
    const reload = () => setEntries(store.list());
    reload();
    const off = onConsentChange(reload);
    window.addEventListener("storage", reload);
    return () => {
      off();
      window.removeEventListener("storage", reload);
    };
  }, [store]);
  return (
    <Section title={t("settings.activity_bridge.title")} description={t("settings.activity_bridge.hint")}>
      {entries.length === 0 ? (
        <p className="text-sm text-fg-2" data-testid="activity-apps-empty">
          {t("settings.activity_bridge.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line" data-testid="activity-apps">
          {entries.map((e) => (
            <li key={e.ref} className="flex flex-wrap items-center gap-3 py-2" data-testid="activity-app" data-ref={e.ref} data-decision={e.decision}>
              <div className="min-w-0 flex-[1_1_12rem]">
                <p className="truncate text-sm">{e.name}</p>
                <p className="truncate text-xs text-fg-2">{e.ref}</p>
              </div>
              <span className={`shrink-0 text-xs ${e.decision === "always" ? "text-ok" : "text-danger"}`}>{t(`settings.activity_bridge.${e.decision}`)}</span>
              <Button variant="ghost" onClick={() => store.revoke(e.ref)} aria-label={t("settings.activity_bridge.revoke_label", { name: e.name })} data-testid="activity-app-revoke">
                {t("settings.activity_bridge.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
