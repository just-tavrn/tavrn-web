// SPDX-License-Identifier: Apache-2.0
/**
 * "Event subscriptions" of an application (tavrn-protocol/APPLICATIONS.md §6.2, owner only): the HTTPS URL that receives
 * events of the rooms of this node the bot is in, the event types, the delivery state (active, failing, disabled),
 * the last error, and the queued and dropped counters. Saving verifies the URL with a signed ping; a disabled
 * subscription is re-enabled (and verified again) with one click.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TavrnApiError, type Application, type Subscription } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, Section } from "./common";

/** The subscribable event types (§6.2), in the node's order. */
export const SUBSCRIPTION_EVENTS = [
  "application.install",
  "application.uninstall",
  "member.join",
  "member.leave",
  "member.update",
  "message.create",
  "message.update",
  "message.delete",
  "commands.update",
] as const;

const STATE_STYLE: Record<string, string> = {
  active: "bg-ok/15 text-ok",
  failing: "bg-warn/15 text-warn",
  disabled: "bg-danger/15 text-danger",
};

export function SubscriptionSection({ app }: { app: Application }) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = ["application-subscription", app.id];
  const sub = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Subscription | null> => {
      try {
        return await api.applications.subscription(app.id);
      } catch (e) {
        if (e instanceof TavrnApiError && e.status === 404) return null;
        throw e;
      }
    },
    // Deliveries change the state in the background.
    refetchInterval: 5000,
  });
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["message.create"]);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const loaded = sub.data;
  useEffect(() => {
    if (loaded) {
      setUrl(loaded.url);
      setEvents(loaded.events);
    }
    // Only when another subscription is loaded, not on every refetch (the form keeps the user's edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.url, loaded?.created_at]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" }) : "—");
  const act = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await f();
      await refresh();
      useToasts.getState().push({ kind: "info", title: done });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("subscriptions.title")} description={t("subscriptions.hint")}>
      <div data-testid="subscription-section" className="space-y-3">
        {sub.isError && <p className="text-sm text-danger">{describeError(sub.error)}</p>}
        {loaded && (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]" data-testid="subscription-status">
            <dt className="text-fg-2">{t("subscriptions.state")}</dt>
            <dd>
              <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${STATE_STYLE[loaded.state] ?? ""}`} data-testid="subscription-state" data-state={loaded.state}>
                {t(`subscriptions.state.${loaded.state}`)}
              </span>
            </dd>
            <dt className="text-fg-2">{t("subscriptions.last_success")}</dt>
            <dd data-testid="subscription-last-success">{date(loaded.last_success_at)}</dd>
            <dt className="text-fg-2">{t("subscriptions.last_error")}</dt>
            <dd className="break-words" data-testid="subscription-last-error">{loaded.last_error ?? "—"}</dd>
            <dt className="text-fg-2">{t("subscriptions.counters")}</dt>
            <dd data-testid="subscription-counters">{t("subscriptions.counters_value", { queued: String(loaded.queued), dropped: String(loaded.dropped) })}</dd>
          </dl>
        )}
        {loaded && loaded.state !== "active" && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg-2 p-2 text-sm">
            <span className="flex-1 text-fg-1">{t(loaded.state === "disabled" ? "subscriptions.disabled_hint" : "subscriptions.failing_hint")}</span>
            <Button disabled={busy} onClick={() => void act(() => api.applications.enableSubscription(app.id), t("subscriptions.enabled"))} data-testid="subscription-enable">
              {t("subscriptions.enable")}
            </Button>
          </div>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.applications.putSubscription(app.id, { url: url.trim(), events }), t("subscriptions.saved"));
          }}
        >
          <Field label={t("subscriptions.url")} hint={t("subscriptions.url_hint")}>
            <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} placeholder="https://bot.example/tavrn/events" required data-testid="subscription-url" />
          </Field>
          <fieldset className="grid gap-1 sm:grid-cols-2" data-testid="subscription-events">
            <legend className="mb-1 text-xs text-fg-2">{t("subscriptions.events")}</legend>
            {SUBSCRIPTION_EVENTS.map((ev) => (
              <label key={ev} className="flex min-h-9 items-center gap-2 text-sm text-fg-1">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? SUBSCRIPTION_EVENTS.filter((x) => x === ev || events.includes(x)) : events.filter((x) => x !== ev))} data-event={ev} />
                <code className="text-xs">{ev}</code>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-fg-2">{t("subscriptions.privacy")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            {loaded && (
              <Button variant="ghost" onClick={() => setRemoving(true)} data-testid="subscription-delete">
                {t("subscriptions.delete")}
              </Button>
            )}
            <Button type="submit" disabled={busy || !url.trim() || events.length === 0} data-testid="subscription-save">
              {busy ? t("subscriptions.verifying") : t("subscriptions.save")}
            </Button>
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={removing}
        title={t("subscriptions.delete")}
        text={t("subscriptions.delete_text")}
        actionLabel={t("subscriptions.delete")}
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          await api.applications.deleteSubscription(app.id);
          setRemoving(false);
          setUrl("");
          await refresh();
        }}
      />
    </Section>
  );
}
