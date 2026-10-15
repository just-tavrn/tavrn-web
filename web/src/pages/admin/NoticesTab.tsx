// SPDX-License-Identifier: Apache-2.0
/**
 * Admin "Notices" tab (design note 4.14 item 1): takedown cases with filters, the reported content inline when the node
 * holds it in plaintext (never encrypted content), the actions (remove content, disable account, reject, forward to
 * the content's node, set state), the counter-notice decision, the trail and the JSON export. Everything the reporter
 * typed is shown as text.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NoticeAction, NoticeDetail } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { Section, Select, Textarea } from "../settings/common";
import { downloadJson } from "../settings/AccountDataSections";
import { nodeInfoQuery } from "../../lib/queries";

const STATES = ["received", "in_review", "actioned", "rejected", "counter_notice"] as const;
type ActionKind = "remove_content" | "disable_account" | "reject" | "forward" | "set_state";

function Detail({ caseId, onBack }: { caseId: string; onBack: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["admin", "notice", caseId], queryFn: () => api.legal.notice(caseId) });
  const [action, setAction] = useState<ActionKind>("remove_content");
  const [reason, setReason] = useState("");
  const [statement, setStatement] = useState("");
  const [nextState, setNextState] = useState<string>("in_review");
  const [decisionReason, setDecisionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const date = (s?: string | null) => (s ? new Date(s).toLocaleString(intlLocale()) : "—");
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "notice", caseId] }), queryClient.invalidateQueries({ queryKey: ["admin", "notices"] })]);
  if (detail.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (detail.isError) return <ErrorText>{describeError(detail.error)}</ErrorText>;
  const d: NoticeDetail = detail.data;
  const remote = d.locations.some((l) => !l.local && l.node);
  const run = async () => {
    const body: NoticeAction = { action, reason, statement };
    if (action === "set_state") body.state = nextState;
    setBusy(true);
    try {
      const r = await api.legal.act(caseId, body);
      useToasts.getState().push({ kind: "info", title: t("admin.notices.done", { state: t(`legal.state.${r.notice.state}`) }), detail: r.skipped.length ? r.skipped.join("; ") : undefined });
      setReason("");
      setStatement("");
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (decision: "restore" | "uphold") => {
    try {
      await api.legal.decideCounter(caseId, { decision, reason: decisionReason });
      setDecisionReason("");
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const openCounter = d.counter_notices.find((c) => !c.decision);
  return (
    <div className="space-y-4" data-testid="notice-detail">
      <Button variant="ghost" onClick={onBack}>
        ← {t("admin.notices.back")}
      </Button>
      <Section title={t("admin.notices.case", { id: d.case_id })}>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-2">{t("legal.notice.state")}</dt>
          <dd data-testid="notice-detail-state">{t(`legal.state.${d.state}`)}</dd>
          <dt className="text-fg-2">{t("legal.notice.basis")}</dt>
          <dd>{t(`legal.notice.basis.${d.basis}`)}</dd>
          {d.origin && (
            <>
              <dt className="text-fg-2">{t("admin.notices.origin")}</dt>
              <dd>
                {d.origin} ({d.origin_case})
              </dd>
            </>
          )}
          <dt className="text-fg-2">{t("admin.notices.reporter")}</dt>
          <dd className="break-words">
            {d.reporter_name} · {d.reporter_email}
            {d.reporter_address ? ` · ${d.reporter_address}` : ""}
            {d.reporter_phone ? ` · ${d.reporter_phone}` : ""}
          </dd>
          <dt className="text-fg-2">{t("legal.notice.work")}</dt>
          <dd className="whitespace-pre-wrap break-words">{d.work}</dd>
          {d.explanation && (
            <>
              <dt className="text-fg-2">{t("legal.notice.explanation")}</dt>
              <dd className="whitespace-pre-wrap break-words">{d.explanation}</dd>
            </>
          )}
          <dt className="text-fg-2">{t("admin.notices.statements")}</dt>
          <dd>
            {[d.good_faith && t("admin.notices.good_faith"), d.accuracy && t("admin.notices.accuracy"), d.perjury && t("admin.notices.perjury")].filter(Boolean).join(" · ")} — {d.signature}
          </dd>
          <dt className="text-fg-2">{t("admin.notices.received")}</dt>
          <dd>{date(d.created_at)}</dd>
          <dt className="text-fg-2">{t("admin.notices.retain")}</dt>
          <dd>{date(d.retain_until)}</dd>
          {d.target_address && (
            <>
              <dt className="text-fg-2">{t("admin.notices.target")}</dt>
              <dd>
                {d.target_address} · {t("admin.notices.repeat", { count: d.repeat_count })}
              </dd>
            </>
          )}
        </dl>
        {d.repeat_suggest_disable && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="repeat-suggestion">
            {t("admin.notices.repeat_suggest", { count: d.repeat_count, threshold: d.repeat_threshold })}
          </p>
        )}
      </Section>
      <Section title={t("admin.notices.content")} description={t("admin.notices.content_hint")}>
        <ul className="space-y-2">
          {d.locations.map((l, i) => {
            const p = d.content.find((c) => c.location === i);
            return (
              <li key={i} className="space-y-1 rounded-md border border-line bg-bg-0 p-2 text-sm" data-testid="notice-location-item">
                <p className="text-xs text-fg-2">
                  {t(`legal.notice.location.${l.kind}`)} · <span className="break-all">{l.value}</span>
                  {!l.local && ` · ${t("admin.notices.on_node", { node: l.node })}`}
                  {l.removed && ` · ${t("admin.notices.removed")}`}
                </p>
                {p?.encrypted && <p className="text-xs text-warn">{t("admin.notices.encrypted")}</p>}
                {p && !p.gone && p.text && (
                  <p className="whitespace-pre-wrap break-words text-fg-0" data-testid="notice-content-text">
                    {p.text}
                  </p>
                )}
                {p && (
                  <p className="text-xs text-fg-2">
                    {[p.author, p.context, p.created_at && date(p.created_at), p.mime, p.gone && l.local ? t("admin.notices.gone") : null].filter(Boolean).join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={t("admin.notices.act")}>
        <Field label={t("admin.notices.action")}>
          <Select value={action} onChange={(e) => setAction(e.target.value as ActionKind)} data-testid="notice-action">
            {(["remove_content", "disable_account", "reject", "forward", "set_state"] as ActionKind[])
              .filter((a) => a !== "forward" || remote)
              .map((a) => (
                <option key={a} value={a}>
                  {t(`admin.notices.action.${a}`)}
                </option>
              ))}
          </Select>
        </Field>
        {(action === "remove_content" || action === "disable_account") && (
          <Field label={t("admin.notices.statement")} hint={t("admin.notices.statement_hint")}>
            <Textarea rows={4} value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={5000} data-testid="notice-statement" />
          </Field>
        )}
        {action === "set_state" && (
          <Field label={t("legal.notice.state")}>
            <Select value={nextState} onChange={(e) => setNextState(e.target.value)}>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`legal.state.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t(action === "reject" ? "admin.notices.reason_reporter" : "admin.notices.reason")}>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} data-testid="notice-reason" />
        </Field>
        <Button variant={action === "reject" || action === "set_state" || action === "forward" ? "primary" : "danger"} disabled={busy} onClick={() => void run()} data-testid="notice-run">
          {t(`admin.notices.action.${action}`)}
        </Button>
      </Section>
      {d.counter_notices.length > 0 && (
        <Section title={t("admin.notices.counter")}>
          {d.counter_notices.map((c) => (
            <div key={c.id} className="space-y-1 text-sm" data-testid="counter-notice">
              <p className="whitespace-pre-wrap break-words">{c.statement}</p>
              <p className="text-xs text-fg-2">
                {c.name} · {c.address} · {c.signature} · {date(c.created_at)}
                {c.decision && ` · ${t(`admin.notices.decision.${c.decision}`)}`}
              </p>
            </div>
          ))}
          {openCounter && (
            <div className="space-y-2">
              <Input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder={t("admin.notices.reason")} aria-label={t("admin.notices.reason")} />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void decide("restore")} disabled={!decisionReason.trim()}>
                  {t("admin.notices.decision.restore")}
                </Button>
                <Button variant="danger" onClick={() => void decide("uphold")} disabled={!decisionReason.trim()}>
                  {t("admin.notices.decision.uphold")}
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}
      <Section title={t("admin.notices.trail")}>
        <ol className="space-y-1 text-xs" data-testid="notice-trail">
          {d.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-2">
              <span className="text-fg-2">{date(e.created_at)}</span>
              <span className="font-mono">{e.action}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

export function NoticesTab() {
  const t = useT();
  const [state, setState] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["admin", "notices", state, q], queryFn: () => api.legal.notices({ state: state || undefined, q: q || undefined, limit: 100 }) });
  const node = useQuery(nodeInfoQuery(null));
  if (open) return <Detail caseId={open} onBack={() => setOpen(null)} />;
  return (
    <Section title={t("admin.notices.title")} description={t(node.data?.legal?.notices?.enabled ? "admin.notices.hint" : "admin.notices.hint_off")}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={state} onChange={(e) => setState(e.target.value)} aria-label={t("legal.notice.state")} className="sm:w-48" data-testid="notices-filter-state">
          <option value="">{t("admin.notices.all")}</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {t(`legal.state.${s}`)}
            </option>
          ))}
        </Select>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} aria-label={t("common.search")} />
        <Button
          variant="ghost"
          className="border border-line"
          onClick={async () => {
            try {
              await downloadJson(await api.legal.exportNotices(), "tavrn-legal-notices.json");
            } catch (e) {
              toastError(e);
            }
          }}
        >
          {t("admin.notices.export")}
        </Button>
      </div>
      {list.isError && <ErrorText>{describeError(list.error)}</ErrorText>}
      <ul className="divide-y divide-line" data-testid="notice-list">
        {list.data?.map((n) => (
          <li key={n.case_id}>
            <button type="button" className="flex w-full flex-col gap-1 py-2 text-left text-sm hover:bg-bg-3/40 sm:flex-row sm:items-center sm:gap-3" onClick={() => setOpen(n.case_id)} data-testid="notice-row">
              <span className="rounded bg-bg-3 px-1.5 text-xs">{t(`legal.state.${n.state}`)}</span>
              <span className="min-w-0 flex-1 truncate">{n.work}</span>
              <span className="text-xs text-fg-2">
                {t(`legal.notice.basis.${n.basis}`)} · {n.reporter_name} · {new Date(n.created_at).toLocaleDateString(intlLocale())}
                {n.origin ? ` · ${n.origin}` : ""}
              </span>
            </button>
          </li>
        ))}
        {list.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("admin.notices.none")}</li>}
      </ul>
    </Section>
  );
}
