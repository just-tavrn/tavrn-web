// SPDX-License-Identifier: Apache-2.0
/**
 * "Push notifications" in the notification settings (tavrn-protocol PROTOCOL.md §6d): push on this device (the
 * browser asks for permission only after the click), the text preview of unencrypted messages, pushes of new reports
 * (moderators and node admins, §6c `reports`), a test push, and what rooms on other nodes push.
 */
import { useT, errorMessage } from "../../i18n";
import { usePush } from "../../stores/push";
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
  const hint =
    status === "unsupported" ? t("push.unsupported")
    : status === "install" ? t("push.install")
    : status === "unavailable" ? t("push.unavailable")
    : status === "denied" ? t("push.denied")
    : t("push.hint");
  return (
    <Section title={t("push.title")} description={t("push.description")}>
      <div data-testid="push-settings" data-status={status} className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={on}
            disabled={busy || status === "loading" || status === "unsupported" || status === "install" || status === "unavailable" || status === "denied"}
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
