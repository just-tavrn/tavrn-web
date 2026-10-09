// SPDX-License-Identifier: Apache-2.0
/**
 * Room settings → History requests (protocol ENCRYPTION.md §7b "History after a key reset"): members with
 * `restore_history` see who lost their key and asks for their encrypted history, what this device would share per
 * channel, and approve (which sends the keys from this device right away) or deny with a reason. Approving is a
 * security decision: the page recommends verifying the person on another channel first and asks to confirm it.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { HistoryRequest, RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { Avatar, Button } from "../../components/ui";
import { useT } from "../../i18n";
import { channelName } from "../../lib/names";
import { formatFullTime } from "../../lib/format";
import { toastError, useToasts } from "../../stores/toasts";
import { isPartial, planRestore, restoreKeys, shareRestore, useRestoreRequests, type ChannelPlan } from "../../history/restore";
import { Section, Textarea } from "./common";

const MAX_REASON = 500;

export function HistoryRequestsTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, home, domain } = useNode();
  const requests = useRestoreRequests(api, home ? null : domain, room.id, true);
  const items = requests.data?.items ?? [];
  return (
    <div className="space-y-4">
      <Section title={t("history_restore.tab_title")} description={t("history_restore.tab_hint")}>
        <div role="note" className="rounded-md border border-warn/40 bg-warn/10 p-3 text-xs text-fg-1" data-testid="history-verify-advice">
          <p className="font-semibold text-fg-0">{t("history_restore.verify_title")}</p>
          <p className="mt-1">{t("history_restore.verify_text")}</p>
        </div>
        {requests.isPending && <p className="text-sm text-fg-2">{t("room.loading")}</p>}
        {!requests.isPending && items.length === 0 && (
          <p className="text-sm text-fg-2" data-testid="history-requests-empty">
            {t("history_restore.none")}
          </p>
        )}
      </Section>
      {items.map((r) => (
        <RequestCard key={r.id} room={room} request={r} />
      ))}
    </div>
  );
}

function RequestCard({ room, request }: { room: RoomDetail; request: HistoryRequest }) {
  const t = useT();
  const { api, home, domain } = useNode();
  const node = home ? null : domain;
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: ["history-plan", node ?? "", request.id], queryFn: () => planRestore(domain, request), staleTime: 30_000 });
  const [verified, setVerified] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const plans = plan.data ?? [];
  const byChannel = new Map(plans.map((p) => [p.channelId, p]));
  const name = request.display_name || request.user;
  const refresh = () => queryClient.invalidateQueries({ queryKey: restoreKeys.requests(node, room.id) });

  const approve = async () => {
    setBusy(true);
    try {
      const decided = await api.historyRequests.approve(room.id, request.id, { partial: isPartial(plans) });
      // Approval is the key share itself (§7b): send the requester's keys from this device now.
      const result = await shareRestore(domain, { ...request, ...decided, channels: request.channels });
      useToasts.getState().push({
        kind: result.partial || result.skipped ? "warning" : "info",
        title: t("history_restore.approved_summary", { name }),
        detail: t("history_restore.approved_detail", { shared: result.shared, partial: result.partial, skipped: result.skipped }),
        testId: "history-approved-toast",
      });
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const deny = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.historyRequests.deny(room.id, request.id, reason.trim());
      useToasts.getState().push({ kind: "info", title: t("history_restore.denied_summary", { name }) });
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-bg-1 p-4" data-testid="history-request" data-user={request.user} aria-label={t("history_restore.request_label", { name })}>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={name} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg-0">{name}</p>
          <p className="truncate text-xs text-fg-2">{request.user}</p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        <dt className="text-fg-2">{t("history_restore.joined")}</dt>
        <dd className="text-fg-1">{formatFullTime(request.joined_at)}</dd>
        <dt className="text-fg-2">{t("history_restore.reset")}</dt>
        <dd className="text-fg-1">{request.key_reset_at ? formatFullTime(request.key_reset_at) : "–"}</dd>
        <dt className="text-fg-2">{t("history_restore.asked")}</dt>
        <dd className="text-fg-1">{formatFullTime(request.created_at)}</dd>
      </dl>
      {request.message && (
        <blockquote className="mt-3 whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-sm text-fg-1" data-testid="history-request-message">
          {request.message}
        </blockquote>
      )}
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-fg-2">{t("history_restore.what_title")}</h3>
      {request.channels.length === 0 ? (
        <p className="mt-1 text-sm text-fg-2">{t("history_restore.no_channels")}</p>
      ) : (
        <ul className="mt-1 space-y-1" data-testid="history-request-channels">
          {request.channels.map((c) => {
            const ch = room.channels.find((x) => x.id === c.channel_id);
            return (
              <li key={c.channel_id} className="flex flex-wrap items-baseline gap-x-2 text-sm" data-channel={c.channel_id}>
                <span className="font-medium text-fg-0">{ch ? `${c.kind === "files" ? "🗂 " : "#"}${channelName(ch)}` : c.channel_id}</span>
                <span className="text-xs text-fg-2">{c.window_start ? t("history_restore.window_since", { at: formatFullTime(c.window_start) }) : t("history_restore.window_all")}</span>
                <PlanText plan={byChannel.get(c.channel_id)} loading={plan.isPending} />
              </li>
            );
          })}
        </ul>
      )}
      {!plan.isPending && isPartial(plans) && (
        <p className="mt-2 text-xs text-warn" data-testid="history-request-partial">
          {t("history_restore.partial_warning")}
        </p>
      )}
      <label className="mt-4 flex min-h-10 items-start gap-2 text-sm text-fg-1">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={verified} onChange={(e) => setVerified(e.target.checked)} data-testid="history-verified" />
        <span>{t("history_restore.verified", { name })}</span>
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void approve()} disabled={!verified || busy} data-testid="history-approve">
          {t("history_restore.approve")}
        </Button>
        {!denying && (
          <Button variant="danger" onClick={() => setDenying(true)} disabled={busy} data-testid="history-deny-open">
            {t("history_restore.deny")}
          </Button>
        )}
      </div>
      {denying && (
        <form onSubmit={deny} className="mt-3 space-y-2">
          <label className="block text-xs text-fg-1">
            {t("history_restore.reason_label")}
            <Textarea className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_REASON} rows={2} required data-testid="history-deny-reason" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={busy || !reason.trim()} data-testid="history-deny">
              {t("history_restore.deny_confirm")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDenying(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** What this device would send for one channel. */
function PlanText({ plan, loading }: { plan: ChannelPlan | undefined; loading: boolean }) {
  const t = useT();
  if (loading) return <span className="text-xs text-fg-2">{t("history_restore.plan_loading")}</span>;
  if (!plan || plan.unknown) return <span className="text-xs text-warn">{t("history_restore.plan_unknown")}</span>;
  if (plan.epochs === 0) return <span className="text-xs text-fg-2">{t("history_restore.plan_nothing")}</span>;
  return (
    <span className="text-xs text-fg-1" data-testid="history-plan">
      {t("history_restore.plan", { count: plan.epochs, first: plan.first ?? 0, last: plan.last ?? 0 })}
      {plan.missing > 0 && <span className="text-warn"> {t("history_restore.plan_missing", { count: plan.missing })}</span>}
    </span>
  );
}
