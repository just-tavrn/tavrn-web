// SPDX-License-Identifier: Apache-2.0
/**
 * "Push notifications" in the notification settings (tavrn-protocol PROTOCOL.md §6d): push on this device (the
 * browser asks for permission only after the click), the text preview of unencrypted messages, pushes of new reports
 * (moderators and node admins, §6c `reports`), a test push, and what rooms on other nodes push.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT, errorMessage } from "../../i18n";
import { usePush } from "../../stores/push";
import { platform, type PlatformAndroid } from "../../platform";
import { keepConnectionWanted, setKeepConnection } from "../../lib/androidConnection";
import { describeError } from "../../stores/toasts";
import { setGlobalSetting, useNotifications } from "../../stores/notifications";
import { Button } from "../../components/ui";
import { Section } from "./common";

export function PushSection() {
  const t = useT();
  const status = usePush((s) => s.status);
  const busy = usePush((s) => s.busy);
  const error = usePush((s) => s.error);
  const pushText = useNotifications((s) => s.settings.global.push_text === true);
  const reports = useNotifications((s) => s.settings.global.reports !== false);
  const on = status === "on";
  const android = platform().android;
  const hint =
    status === "unsupported" ? t("push.unsupported")
    : status === "install" ? t("push.install")
    : status === "unavailable" ? t("push.unavailable")
    : status === "no_distributor" ? t("push.android.no_distributor")
    : status === "denied" ? t(android ? "push.android.denied" : "push.denied")
    : t(android ? "push.android.hint" : "push.hint");
  return (
    <Section title={t("push.title")} description={t("push.description")}>
      <div data-testid="push-settings" data-status={status} className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={on}
            disabled={busy || status === "loading" || status === "unsupported" || status === "install" || status === "unavailable" || status === "denied" || status === "no_distributor"}
            data-testid="push-enable"
            onChange={(e) => void (e.target.checked ? usePush.getState().enable() : usePush.getState().disable())}
          />
          <span>
            {t("push.enable")}
            <span className="block text-xs text-fg-2" data-testid="push-hint">
              {hint}
            </span>
          </span>
        </label>
        {android && <AndroidPush android={android} status={status} />}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={pushText} data-testid="push-text" onChange={(e) => setGlobalSetting({ push_text: e.target.checked })} />
          <span>
            {t("push.text")}
            <span className="block text-xs text-fg-2">{t("push.text_hint")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={reports} data-testid="push-reports" onChange={(e) => setGlobalSetting({ reports: e.target.checked })} />
          <span>
            {t("push.reports")}
            <span className="block text-xs text-fg-2">{t("push.reports_hint")}</span>
          </span>
        </label>
        <p className="text-xs text-fg-2" data-testid="push-remote-hint">
          {t("push.remote_hint")}
        </p>
        {on && (
          <Button variant="ghost" className="min-h-10 px-3 text-sm" onClick={() => void usePush.getState().test()} data-testid="push-test">
            {t("push.test")}
          </Button>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger" data-testid="push-error">
            {errorMessage(error, t("push.failed"))}
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * The Android app (docs/ANDROID.md "Notifications without Google"): where to get a UnifiedPush distributor, the
 * notification settings when they are off, the connection service as the alternative, and the battery exemption.
 */
function AndroidPush({ android, status }: { android: PlatformAndroid; status: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["android-status"], queryFn: () => android.status(), retry: false });
  const [keep, setKeep] = useState(keepConnectionWanted);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["android-status"] });
  const toggleKeep = async (on: boolean) => {
    setError(null);
    try {
      await setKeepConnection(android, on);
      setKeep(on);
    } catch (e) {
      setError(describeError(e) || t("push.failed"));
    }
    refresh();
  };
  return (
    <div className="space-y-3" data-testid="push-android">
      {status === "no_distributor" && (
        <p className="text-sm text-fg-1" data-testid="push-no-distributor">
          {t("push.android.get_distributor")}{" "}
          <a className="text-accent underline" href="https://unifiedpush.org/users/distributors/" target="_blank" rel="noreferrer">
            {t("push.android.distributors")}
          </a>{" "}
          ·{" "}
          <a className="text-accent underline" href="https://f-droid.org/packages/io.heckel.ntfy/" target="_blank" rel="noreferrer">
            {t("push.android.ntfy")}
          </a>
        </p>
      )}
      {status === "denied" && (
        <Button variant="ghost" className="min-h-10 border border-line px-3 text-sm" onClick={() => void android.openSettings("notifications").catch(() => undefined)} data-testid="push-open-settings">
          {t("android.open_settings")}
        </Button>
      )}
      {status !== "on" && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={keep} onChange={(e) => void toggleKeep(e.target.checked)} data-testid="push-keep-connection" />
          <span>
            {t("push.android.keep")}
            <span className="block text-xs text-fg-2">{t("push.android.keep_hint")}</span>
          </span>
        </label>
      )}
      <div className="space-y-1">
        <p className="text-xs text-fg-2" data-testid="push-battery" data-exempt={info.data?.batteryExempt ? "true" : "false"}>
          {info.data?.batteryExempt ? t("push.android.battery_exempt") : t("push.android.battery_hint")}
        </p>
        {info.data && !info.data.batteryExempt && (
          <Button variant="ghost" className="min-h-10 border border-line px-3 text-sm" onClick={() => void android.requestBatteryExemption().catch(() => false).then(refresh)} data-testid="push-battery-exempt">
            {t("push.android.battery_button")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
