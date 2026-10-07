// SPDX-License-Identifier: Apache-2.0
import { TavrnApiError } from "@tavrn/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Navigate, useNavigate, useParams } from "react-router";
import { api } from "../lib/api";
import { LOCALES, intlLocale, useLocale, useT } from "../i18n";
import { describeError, toastError } from "../stores/toasts";
import { Button, Field } from "../components/ui";
import { Section, Select } from "./settings/common";
import { SecuritySettings } from "./settings/SecuritySettings";
import { ProfileSettingsTab } from "./settings/ProfileSettingsTab";
import { PrivacyTab } from "./settings/PrivacyTab";
import { VoiceSettingsTab } from "./settings/VoiceSettingsTab";
import { NotificationsTab } from "./settings/NotificationsTab";
import { ApplicationsTab } from "./settings/ApplicationsTab";
import { PersonalEmojisTab } from "./settings/PersonalEmojisTab";
import { PersonalSoundsTab } from "./settings/PersonalSoundsTab";
import { LegalTab } from "./settings/LegalTab";

const TABS = ["profile", "privacy", "security", "voice", "notifications", "emojis", "sounds", "applications", "language", "devices", "legal"] as const;

export function UserSettingsPage() {
  const t = useT();
  const { tab = "profile" } = useParams();
  const navigate = useNavigate();
  if (!TABS.includes(tab as (typeof TABS)[number])) return <Navigate to="/settings/profile" replace />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={() => navigate("/")} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("shell.home")}>
          ←
        </button>
        <h1 className="truncate text-sm font-semibold">{t("user.settings")}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={t("settings.sections")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
          {TABS.map((x) => (
            <NavLink key={x} to={`/settings/${x}`} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
              {t(`user.tab.${x}`)}
            </NavLink>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0}>
          {tab === "profile" && <ProfileSettingsTab />}
          {tab === "privacy" && <PrivacyTab />}
          {tab === "security" && <SecuritySettings />}
          {tab === "voice" && <VoiceSettingsTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "emojis" && <PersonalEmojisTab />}
          {tab === "sounds" && <PersonalSoundsTab />}
          {tab === "applications" && <ApplicationsTab />}
          {tab === "language" && <LanguageTab />}
          {tab === "devices" && <DevicesTab />}
          {tab === "legal" && <LegalTab />}
        </div>
      </div>
    </div>
  );
}

function LanguageTab() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  return (
    <Section title={t("user.language")} description={t("user.language_hint")}>
      <Field label={t("user.language")}>
        <Select value={locale} onChange={(e) => setLocale(e.target.value)} data-testid="locale-switch">
          {Object.entries(LOCALES).map(([code, { label }]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
    </Section>
  );
}

function DevicesTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api.users.devices() });
  return (
    <Section title={t("user.devices")} description={t("user.devices_hint")}>
      {devices.isError && <p className="text-sm text-danger">{describeError(devices.error)}</p>}
      <ul className="divide-y divide-line" data-testid="device-list">
        {[...(devices.data ?? [])]
          .sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at.localeCompare(a.last_seen_at))
          .map((d) => (
            <li key={d.id} className="flex min-h-12 items-center gap-3 text-sm" data-testid="device" data-current={d.current ? "true" : "false"} data-stale={d.stale ? "true" : "false"}>
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {d.name} {d.current && <span className="text-xs text-accent">· {t("user.device_current")}</span>}
                  {d.stale && (
                    <span className="ml-1 rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn" title={d.stale_at ? t("user.device_stale_hint", { date: new Date(d.stale_at).toLocaleDateString(intlLocale()) }) : undefined} data-testid="device-stale">
                      {t("user.device_stale")}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-fg-2">
                  {d.client} · {t("user.last_seen", { date: new Date(d.last_seen_at).toLocaleString(intlLocale()) })}
                </p>
              </div>
              {!d.current && (
                <Button
                  variant="ghost"
                  aria-label={t("user.device_remove", { name: d.name })}
                  onClick={async () => {
                    try {
                      // Needs a recent confirmation (PROTOCOL.md §5c): the API client opens the dialog.
                      await api.users.deleteDevice(d.id);
                      await queryClient.invalidateQueries({ queryKey: ["devices"] });
                    } catch (e) {
                      if (!(e instanceof TavrnApiError && e.code === "auth.reauth_required")) toastError(e);
                    }
                  }}
                >
                  {t("common.delete")}
                </Button>
              )}
            </li>
          ))}
      </ul>
    </Section>
  );
}
