// SPDX-License-Identifier: Apache-2.0
/**
 * The moderation inbox (protocol MODERATION.md §1.4): the room's reports for its moderators (room settings →
 * Reports) and every report of the node for node admins (Admin → Reports). A report shows the snapshot of a
 * plaintext message or the evidence the reporter released for an encrypted one, labelled as such: the node cannot
 * verify it. Triage (status, assignee, note) and the action shortcuts run on the report's node with the moderator's
 * own permissions.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModerationReport, ReportActionRequest, TavrnApi } from "@tavrn/sdk";
import { intlLocale, useT } from "../i18n";
import { formatFullTime } from "../lib/format";
import { TIMEOUT_CHOICES } from "../lib/menus";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { Button, ErrorText, Field } from "../components/ui";
import { ConfirmAction } from "../components/menus/common";
import { ConfirmDialog, Section, Select, Textarea } from "../pages/settings/common";
import { reportKeys } from "./hooks";

export type InboxMode = { kind: "room"; roomId: string; node: string | null } | { kind: "admin" };

const STATUSES = ["open", "resolved", "dismissed"] as const;

function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const tone = status === "open" ? "bg-warn/20 text-fg-0" : status === "resolved" ? "bg-ok/20 text-fg-0" : "bg-bg-3 text-fg-2";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{t(`reports.status.${status}`)}</span>;
}

/** What a report is about, in one line. */
function targetLine(r: ModerationReport, t: ReturnType<typeof useT>): string {
  const who = r.target?.display_name ? `${r.target.display_name} (${r.target_address})` : r.target_address;
  if (r.kind === "room") return t("reports.about_room", { room: r.room_name ?? r.room_id ?? "?" });
  if (r.kind === "message") return t("reports.about_message", { user: who });
  return t("reports.about_user", { user: who });
}

/** Where it happened. */
function placeLine(r: ModerationReport, t: ReturnType<typeof useT>): string | null {
  if (r.node) return t("reports.place_remote", { node: r.node });
  if (r.conversation_kind === "dm") return t("reports.place_dm");
  if (r.conversation_kind === "group") return t("reports.place_group");
  if (r.room_name) return t("reports.place_room", { room: r.room_name });
  return null;
}

export function ReportsInbox({ client, mode, meId }: { client: TavrnApi; mode: InboxMode; meId: string | undefined }) {
  const t = useT();
  const [status, setStatus] = useState<string>("open");
  const [scope, setScope] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const key = mode.kind === "room" ? reportKeys.room(mode.node, mode.roomId) : reportKeys.admin();
  const list = useQuery({
    queryKey: [...key, status, scope],
    queryFn: () =>
      mode.kind === "room"
        ? client.reports.room(mode.roomId, { status: status || undefined, limit: 50 })
        : client.reports.admin({ status: status || undefined, scope: scope || undefined, limit: 50 }),
  });
  const node = mode.kind === "room" ? mode.node : null;
  return (
    <div className="space-y-4" data-testid="reports-inbox">
      <Section title={t("reports.title")} description={mode.kind === "room" ? t("reports.hint_room") : t("reports.hint_admin")}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("reports.filter_status")}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="reports-status-filter">
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`reports.status.${s}`)}
                </option>
              ))}
              <option value="">{t("reports.status.all")}</option>
            </Select>
          </Field>
          {mode.kind === "admin" && (
            <Field label={t("reports.filter_scope")}>
              <Select value={scope} onChange={(e) => setScope(e.target.value)} data-testid="reports-scope-filter">
                <option value="">{t("reports.scope.all")}</option>
                <option value="node">{t("reports.scope.node")}</option>
                <option value="room">{t("reports.scope.room")}</option>
              </Select>
            </Field>
          )}
          {list.data && (
            <p className="pb-2 text-xs text-fg-2" data-testid="reports-open-count">
              {t("reports.open_count", { count: list.data.open })}
            </p>
          )}
        </div>
        {list.isError && <ErrorText>{describeError(list.error)}</ErrorText>}
        {list.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
        <ul className="divide-y divide-line" data-testid="reports-list">
          {list.data?.reports.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelected(selected === r.id ? null : r.id)}
                aria-expanded={selected === r.id}
                className={`flex w-full flex-wrap items-start gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left text-sm hover:bg-bg-3/60 ${selected === r.id ? "bg-accent-soft" : ""}`}
                data-testid="report-row"
                data-report={r.id}
                data-status={r.status}
              >
                <span className="min-w-0 flex-1 basis-56">
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span className="font-medium">{t(`report.category.${r.category}`)}</span>
                    {r.source === "automod" && <span className="rounded bg-bg-3 px-1.5 py-0.5 text-[11px]">{t("reports.automod")}</span>}
                    {r.evidence_count > 0 && <span className="rounded bg-warn/20 px-1.5 py-0.5 text-[11px]">{t("reports.evidence_badge", { count: r.evidence_count })}</span>}
                  </span>
                  <span className="block truncate text-fg-1">{targetLine(r, t)}</span>
                  <span className="block truncate text-xs text-fg-2">{[placeLine(r, t), r.reporter ? t("reports.by", { user: r.reporter.address }) : null].filter(Boolean).join(" · ")}</span>
                </span>
                <time className="text-xs text-fg-2" dateTime={r.created_at}>
                  {new Date(r.created_at).toLocaleString(intlLocale())}
                </time>
              </button>
              {selected === r.id && <ReportDetail client={client} node={node} id={r.id} admin={mode.kind === "admin"} meId={meId} onGone={() => setSelected(null)} />}
            </li>
          ))}
          {list.data?.reports.length === 0 && <li className="py-3 text-sm text-fg-2">{t("reports.none")}</li>}
        </ul>
      </Section>
    </div>
  );
}

function ReportDetail({ client, node, id, admin, meId, onGone }: { client: TavrnApi; node: string | null; id: string; admin: boolean; meId: string | undefined; onGone: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: reportKeys.detail(node, id), queryFn: () => client.reports.get(id) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["reports"] });
  if (q.isPending) return <p className="px-2 py-3 text-sm text-fg-2">{t("common.loading")}</p>;
  if (q.isError) return <ErrorText>{describeError(q.error)}</ErrorText>;
  const r = q.data;
  return (
    <div className="space-y-3 rounded-md border border-line bg-bg-0 p-3 text-sm" data-testid="report-detail">
      <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        <dt className="text-fg-2">{t("reports.field.reporter")}</dt>
        <dd data-testid="report-reporter">{r.reporter ? `${r.reporter.display_name} (${r.reporter.address})` : t("reports.automod")}</dd>
        <dt className="text-fg-2">{t("reports.field.target")}</dt>
        <dd data-testid="report-target">{targetLine(r, t)}</dd>
        {placeLine(r, t) && (
          <>
            <dt className="text-fg-2">{t("reports.field.place")}</dt>
            <dd>{placeLine(r, t)}</dd>
          </>
        )}
        <dt className="text-fg-2">{t("reports.field.time")}</dt>
        <dd>{formatFullTime(r.created_at)}</dd>
      </dl>
      {r.detail && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-bg-1 px-3 py-2" data-testid="report-text">
          {r.detail}
        </p>
      )}
      {r.snapshot && (
        <div className="space-y-1 rounded-md border border-line px-3 py-2" data-testid="report-snapshot">
          <p className="text-xs font-semibold text-fg-1">{r.message_exists ? t("reports.snapshot") : t("reports.snapshot_deleted")}</p>
          <p className="text-xs text-fg-2">
            {r.snapshot.author} · {formatFullTime(r.snapshot.created_at)}
          </p>
          <p className="whitespace-pre-wrap break-words">{r.snapshot.text}</p>
          {r.snapshot.attachments.length > 0 && <p className="text-xs text-fg-2">📎 {r.snapshot.attachments.join(", ")}</p>}
        </div>
      )}
      {r.evidence && r.evidence.length > 0 && (
        <div className="space-y-2 rounded-md border border-warn/60 bg-warn/5 px-3 py-2" data-testid="report-evidence-view">
          <p className="text-xs font-semibold text-fg-0" data-testid="report-evidence-label">
            {t("reports.evidence_label")}
          </p>
          <p className="text-xs text-fg-2">{t("reports.evidence_hint")}</p>
          <ol className="space-y-1">
            {r.evidence.map((e, i) => {
              const reported = e.message_id === r.message_id;
              return (
                <li key={`${e.message_id ?? i}`} className={`rounded px-2 py-1 ${reported ? "bg-warn/15" : ""}`} data-testid="report-evidence-entry" data-reported={reported || undefined}>
                  <p className="text-xs text-fg-2">
                    <span className="font-medium text-fg-1">{e.author}</span> · {formatFullTime(e.created_at)}
                    {e.device_id ? ` · ${t("reports.device", { device: e.device_id })}` : ""}
                    {reported && <span className="ml-1 rounded bg-warn/30 px-1 text-[10px] font-semibold uppercase">{t("report.evidence.reported_badge")}</span>}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{e.text}</p>
                  {(e.attachments ?? []).length > 0 && <p className="text-xs text-fg-2">📎 {(e.attachments ?? []).join(", ")}</p>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {r.kind === "message" && !r.snapshot && !(r.evidence && r.evidence.length) && <p className="text-xs text-fg-2">{t("reports.no_evidence")}</p>}
      {r.actions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-fg-1">{t("reports.actions_taken")}</p>
          <ul className="text-xs text-fg-2" data-testid="report-actions-taken">
            {r.actions.map((a, i) => (
              <li key={i}>
                {t(`reports.action.${a.action}`)}
                {a.minutes ? ` (${t(`menu.duration.${a.minutes}m`)})` : ""} · {a.actor} · {formatFullTime(a.at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ActionBar client={client} report={r} admin={admin} onDone={refresh} />
      <Triage client={client} report={r} meId={meId} admin={admin} onDone={refresh} onDeleted={onGone} />
    </div>
  );
}

type Pending = { action: "delete_message" | "kick" | "ban" } | { action: "timeout"; minutes: number } | { action: "purge"; count: number; token: string };

function ActionBar({ client, report, admin, onDone }: { client: TavrnApi; report: ModerationReport; admin: boolean; onDone: () => void }) {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const [minutes, setMinutes] = useState<number>(60);
  const [resolve, setResolve] = useState(true);
  const inRoom = !!report.room_id && report.scope === "room";
  const hasUser = !!report.target;
  const canDelete = report.kind === "message" && !report.node && report.message_exists && (report.conversation_kind === "channel" || admin);
  const canRoomActions = !!report.room_id && hasUser && (inRoom || admin);
  const canBan = !!report.target_address && (inRoom || admin);
  const canPurge = hasUser && (inRoom || admin);
  const run = async (req: ReportActionRequest) => {
    const res = await client.reports.act(report.id, { ...req, resolve });
    useToasts.getState().push({ kind: "info", title: t("reports.action_done") });
    onDone();
    return res;
  };
  const previewPurge = async () => {
    try {
      const res = await client.reports.act(report.id, { action: "purge", reason: "" });
      if (res.purge?.confirm_token) setPending({ action: "purge", count: res.purge.messages, token: res.purge.confirm_token });
    } catch (e) {
      toastError(e);
    }
  };
  if (!canDelete && !canRoomActions && !canBan && !canPurge) return null;
  const name = report.target?.display_name ?? report.target_address;
  return (
    <div className="space-y-2 border-t border-line pt-3" data-testid="report-action-bar">
      <p className="text-xs font-semibold text-fg-1">{t("reports.actions")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {canDelete && (
          <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => setPending({ action: "delete_message" })} data-testid="report-action-delete">
            🗑 {t("reports.action.delete_message")}
          </Button>
        )}
        {canRoomActions && (
          <span className="flex shrink-0 flex-nowrap items-center gap-1">
            <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} aria-label={t("reports.timeout_length")} data-testid="report-timeout-minutes" className="w-auto! shrink-0">
              {TIMEOUT_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {t(`menu.duration.${m}m`)}
                </option>
              ))}
            </Select>
            <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => setPending({ action: "timeout", minutes })} data-testid="report-action-timeout">
              ⏳ {t("reports.action.timeout")}
            </Button>
          </span>
        )}
        {canRoomActions && (
          <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => setPending({ action: "kick" })} data-testid="report-action-kick">
            🚪 {t("reports.action.kick")}
          </Button>
        )}
        {canBan && (
          <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => setPending({ action: "ban" })} data-testid="report-action-ban">
            ⛔ {inRoom ? t("reports.action.ban") : t("reports.action.node_ban")}
          </Button>
        )}
        {canPurge && (
          <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => void previewPurge()} data-testid="report-action-purge">
            🧹 {t("reports.action.purge")}
          </Button>
        )}
      </div>
      <label className="flex min-h-9 items-center gap-2 text-xs text-fg-1">
        <input type="checkbox" className="h-4 w-4" checked={resolve} onChange={(e) => setResolve(e.target.checked)} data-testid="report-resolve-after" />
        {t("reports.resolve_after")}
      </label>
      {pending && pending.action !== "purge" && (
        <ConfirmAction
          title={t(`reports.confirm.${pending.action}`, { name })}
          text={pending.action === "timeout" ? t("reports.confirm.timeout_text", { name, duration: t(`menu.duration.${pending.minutes}m`) }) : t(`reports.confirm.${pending.action}_text`, { name })}
          action={t(`reports.action.${pending.action}`)}
          reasonLabel={pending.action === "delete_message" ? undefined : t("member.reason")}
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            await run({ action: pending.action, reason, ...(pending.action === "timeout" ? { minutes: pending.minutes } : {}) });
          }}
          testId="report-action-confirm"
        />
      )}
      <ConfirmDialog
        open={pending?.action === "purge"}
        title={t("reports.confirm.purge", { name })}
        text={t("reports.confirm.purge_text", { name, count: pending?.action === "purge" ? pending.count : 0 })}
        confirmWord={t("moderation.confirm_word")}
        actionLabel={t("moderation.confirm_action")}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.action !== "purge") return;
          try {
            await run({ action: "purge", reason: "", confirm_token: pending.token });
          } catch (e) {
            toastError(e);
          }
          setPending(null);
        }}
      />
    </div>
  );
}

function Triage({ client, report, meId, admin, onDone, onDeleted }: { client: TavrnApi; report: ModerationReport; meId: string | undefined; admin: boolean; onDone: () => void; onDeleted: () => void }) {
  const t = useT();
  const [status, setStatus] = useState(report.status);
  const [note, setNote] = useState(report.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async (extra: { assignee_id?: string | null } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await client.reports.update(report.id, { status, note, ...extra });
      useToasts.getState().push({ kind: "info", title: t("reports.saved") });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const mine = !!meId && report.assignee?.id === meId;
  return (
    <div className="space-y-2 border-t border-line pt-3" data-testid="report-triage">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("reports.field.status")}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="report-status">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`reports.status.${s}`)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="pb-2 text-xs text-fg-2" data-testid="report-assignee">
          {report.assignee ? t("reports.assigned_to", { user: report.assignee.display_name }) : t("reports.unassigned")}
        </p>
        <Button variant="ghost" disabled={busy || !meId} onClick={() => void save({ assignee_id: mine ? null : (meId ?? null) })} data-testid="report-assign">
          {mine ? t("reports.unassign") : t("reports.assign_me")}
        </Button>
      </div>
      <Field label={t("reports.field.note")}>
        <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="report-note" />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        {admin && (
          <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(true)} data-testid="report-delete">
            {t("reports.delete")}
          </Button>
        )}
        <Button disabled={busy} onClick={() => void save()} data-testid="report-save">
          {t("common.save")}
        </Button>
      </div>
      {confirmDelete && (
        <ConfirmAction
          title={t("reports.delete")}
          text={t("reports.delete_text")}
          action={t("reports.delete")}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await client.reports.delete(report.id);
            onDeleted();
            onDone();
          }}
          testId="report-delete-confirm"
        />
      )}
    </div>
  );
}
