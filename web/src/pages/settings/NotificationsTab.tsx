// SPDX-License-Identifier: Apache-2.0
/**
 * Notification settings of the account (design note 4.11): the global level (all / mentions only / nothing),
 * sound, browser notifications (the permission prompt only appears after a click here), and the rooms,
 * channels and DMs with their own settings or a mute, which can be reset. The desktop app has no web push and no
 * browser permission: it offers its native notifications instead (a switch of this device, docs/DESKTOP.md).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RoomDetail } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { FOREVER, mutedNow, setGlobalSetting, useNotifications, type NotificationMode } from "../../stores/notifications";
import { browserNotificationsSupported, desktopNotificationsEnabled, playNotifySound, requestBrowserPermission, setDesktopNotifications } from "../../lib/notify";
import { platform } from "../../platform";
import { channelName } from "../../lib/names";
import { Button, Field } from "../../components/ui";
import { Section, Select } from "./common";
import { AccessibilitySection } from "./AccessibilitySection";
import { PushSection } from "./PushSection";
import { roomOfChannel } from "../../lib/roomCache";
import { formatDate } from "../../lib/format";

const MODES: NotificationMode[] = ["all", "mentions", "nothing"];

export function NotificationsTab() {
  const t = useT();
  const settings = useNotifications((s) => s.settings);
  const source = useNotifications((s) => s.source);
  const queryClient = useQueryClient();
  const [permission, setPermission] = useState<string>(browserNotificationsSupported() ? Notification.permission : "unsupported");
  const desktop = !!platform().notifications;
  const [nativeOn, setNativeOn] = useState(desktopNotificationsEnabled);
  // Names of rooms and channels the client knows (room details in the cache).
  const rooms = queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] }).map(([, r]) => r).filter((r): r is RoomDetail => !!r?.channels);
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? id;
  const channelLabel = (id: string) => {
    const owner = roomOfChannel(queryClient, id);
    return owner ? `#${channelName(owner.channel)} · ${owner.room.name}` : id;
  };
  const until = (v: string | null | undefined) => (!v ? "" : v === FOREVER || Date.parse(v) > Date.now() + 365 * 86_400_000 ? t("menu.duration.forever") : formatDate(v, "datetime"));
  const overrides = [
    ...Object.entries(settings.rooms).map(([id, v]) => ({ key: `r:${id}`, label: roomName(id), level: "room" as const, id, mode: v.mode, muted: mutedNow(v.muted_until) ? v.muted_until : null, suppress: !!v.suppress_everyone })),
    ...Object.entries(settings.channels).map(([id, v]) => ({ key: `c:${id}`, label: channelLabel(id), level: "channel" as const, id, mode: v.mode, muted: mutedNow(v.muted_until) ? v.muted_until : null, suppress: false })),
  ];
  const reset = (level: "room" | "channel", id: string) =>
    useNotifications.getState().update((s) => {
      const copy = { ...s, rooms: { ...s.rooms }, channels: { ...s.channels } };
      if (level === "room") delete copy.rooms[id];
      else delete copy.channels[id];
      return copy;
    });
  return (
    <div className="space-y-4" data-testid="notification-settings">
      <Section title={t("notify.settings_title")} description={source === "local" ? t("notify.settings_local") : t("notify.settings_hint")}>
        <Field label={t("notify.global_mode")} hint={t("notify.global_mode_hint")}>
          <Select value={settings.global.mode} onChange={(e) => setGlobalSetting({ mode: e.target.value as NotificationMode })} data-testid="notify-global-mode">
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`notify.mode.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={settings.global.sound} onChange={(e) => setGlobalSetting({ sound: e.target.checked })} data-testid="notify-sound" />
            {t("notify.sound")}
          </label>
          <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => playNotifySound()}>
            {t("notify.sound_preview")}
          </Button>
        </div>
        {desktop ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={nativeOn}
              data-testid="notify-desktop"
              onChange={(e) => {
                setDesktopNotifications(e.target.checked);
                setNativeOn(e.target.checked);
              }}
            />
            <span>
              {t("notify.desktop")}
              <span className="block text-xs text-fg-2">{t("notify.desktop_hint")}</span>
            </span>
          </label>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={settings.global.browser && permission === "granted"}
              disabled={permission === "unsupported" || permission === "denied"}
              data-testid="notify-browser"
              onChange={async (e) => {
                if (!e.target.checked) return setGlobalSetting({ browser: false });
                // The browser asks only now, after the click (never on page load).
                const result = await requestBrowserPermission();
                setPermission(result);
                setGlobalSetting({ browser: result === "granted" });
              }}
            />
            <span>
              {t("notify.browser")}
              <span className="block text-xs text-fg-2">{permission === "denied" ? t("notify.browser_denied") : permission === "unsupported" ? t("notify.browser_unsupported") : t("notify.browser_hint")}</span>
            </span>
          </label>
        )}
        <p className="text-xs text-fg-2" data-testid="mentions-privacy">
          {t("notify.mentions_privacy")}
        </p>
      </Section>
      {/* The Android app pushes through UnifiedPush (docs/ANDROID.md); the desktop app has no push. */}
      {(!desktop || !!platform().android) && <PushSection />}
      <AccessibilitySection />
      <Section title={t("notify.overrides")} description={t("notify.overrides_hint")}>
        {overrides.length === 0 && <p className="text-sm text-fg-2">{t("notify.overrides_none")}</p>}
        <ul className="divide-y divide-line" data-testid="notify-overrides">
          {overrides.map((o) => (
            <li key={o.key} className="flex min-h-10 flex-wrap items-center gap-2 py-1 text-sm">
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.mode && <span className="text-xs text-fg-2">{t(`notify.mode.${o.mode}`)}</span>}
              {o.muted && <span className="text-xs text-fg-2">🔕 {until(o.muted)}</span>}
              {o.suppress && <span className="text-xs text-fg-2">{t("menu.notify.suppress_everyone")}</span>}
              <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => reset(o.level, o.id)}>
                {t("notify.reset")}
              </Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
