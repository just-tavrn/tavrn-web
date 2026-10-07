// SPDX-License-Identifier: Apache-2.0
/**
 * GDPR data rights in the settings (design note 4.14 item 3): "My data" in the profile settings (the summary of what the
 * home node holds and the JSON archive, Art. 15/20) and "Delete account" in the privacy settings (Art. 17) with the
 * username as confirmation phrase, the option to delete messages and files, and the progress of that deletion.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { TavrnApiError, type AccountDeletion, type DataSummary } from "@tavrn/sdk";
import { api, publicApi } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { useAuth } from "../../stores/auth";
import { signOut } from "../../stores/e2ee";
import { describeError } from "../../stores/toasts";
import { Button, Dialog, ErrorText, Input } from "../../components/ui";
import { Section } from "./common";

/** Saves a JSON value as a file download. */
export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportFilename(username: string, now = new Date()): string {
  return `tavrn-export-${username}-${now.toISOString().slice(0, 10)}.json`;
}

/** Retention entries worth showing (days; 0 = kept until deleted). */
const RETENTION_KEYS = ["session_refresh_days", "device_stale_days", "attachment_retention_days", "legal_notice_retention_days", "account_delete_grace_days"] as const;

function Summary({ data }: { data: DataSummary }) {
  const t = useT();
  const date = (s?: string | null) => (s ? new Date(s).toLocaleDateString(intlLocale()) : "");
  const retention = (data.retention ?? {}) as Record<string, number>;
  return (
    <div className="space-y-3 text-sm" data-testid="my-data-summary">
      <ul className="grid gap-1 sm:grid-cols-2">
        {data.categories
          .filter((c) => c.count > 0)
          .map((c) => (
            <li key={c.key} className="flex min-h-8 items-center justify-between gap-2 rounded-md bg-bg-0 px-2" data-testid={`data-category-${c.key}`}>
              <span>{t(`legal.data.cat.${c.key}`)}</span>
              <span className="text-xs text-fg-2">
                {c.count}
                {c.since ? ` · ${t("legal.data.since", { date: date(c.since) })}` : ""}
              </span>
            </li>
          ))}
      </ul>
      <p className="text-xs text-fg-2">{data.nodes.length ? t("legal.data.nodes", { nodes: data.nodes.join(", ") }) : t("legal.data.no_nodes")}</p>
      {data.applications.length > 0 && (
        <p className="text-xs text-fg-2">
          {t("legal.data.apps")}: {data.applications.map((a) => (a.room ? `${a.name} (${a.room})` : `${a.name} (${t("legal.data.app_owned")})`)).join(", ")}
        </p>
      )}
      <p className="text-xs text-fg-2">
        {t("legal.data.retention")}:{" "}
        {RETENTION_KEYS.map((k) => `${t(`legal.data.ret.${k}`)} ${retention[k] ? t("legal.data.days", { days: retention[k] }) : t("legal.data.forever")}`).join(" · ")}
      </p>
    </div>
  );
}

/** "My data" (profile settings): the summary and the download of the JSON archive. */
export function MyDataSection() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const remote = useAuth((s) => !!s.home);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = useQuery({ queryKey: ["my-data"], queryFn: () => api.legal.dataSummary(), enabled: open });
  if (!user) return null;
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      // Needs a fresh confirmation: the API client opens the dialog.
      const archive = await api.legal.exportData();
      downloadJson(archive, exportFilename(user.username));
    } catch (e) {
      if (!(e instanceof TavrnApiError && e.code === "auth.reauth_required")) setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("legal.data.title")} description={t(remote ? "legal.data.hint_remote" : "legal.data.hint")}>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" className="border border-line" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="my-data-show">
          {t(open ? "legal.data.hide" : "legal.data.show")}
        </Button>
        <Button onClick={() => void download()} disabled={busy} data-testid="my-data-download">
          {busy ? t("auth.wait") : t("legal.data.download")}
        </Button>
      </div>
      {open && summary.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      {open && summary.isError && <ErrorText>{describeError(summary.error)}</ErrorText>}
      {open && summary.data && <Summary data={summary.data} />}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

/** "Delete account" (privacy settings). */
export function DeleteAccountSection() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const remote = useAuth((s) => !!s.home);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [withMessages, setWithMessages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AccountDeletion | null>(null);
  // Stable, so the dialog keeps the focus while typing.
  const close = useCallback(() => setOpen((o) => (progress ? o : false)), [progress]);
  if (!user || remote) return null;
  const finish = async () => {
    await signOut().catch(() => undefined);
    navigate("/login?deleted=1", { replace: true });
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.legal.deleteAccount({ confirm: typed.trim(), delete_messages: withMessages });
      if (started.state === "done") return void (await finish());
      // Content deletion runs in the background: show its progress through the status link, then sign out.
      setProgress(started);
      const poll = async () => {
        try {
          const s = await publicApi.legal.deletionStatus(started.id, started.status_token);
          setProgress(s);
          if (s.state !== "processing") return void (await finish());
        } catch {
          return void (await finish());
        }
        setTimeout(() => void poll(), 1000);
      };
      setTimeout(() => void poll(), 500);
    } catch (e) {
      if (e instanceof TavrnApiError && e.code === "auth.reauth_required") return;
      const rooms = e instanceof TavrnApiError && e.code === "account.owns_rooms" ? ((e.problem as { meta?: { rooms?: { name: string }[] } }).meta?.rooms ?? []) : [];
      setError(rooms.length ? t("legal.delete.owns_rooms", { rooms: rooms.map((r) => r.name).join(", ") }) : describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("legal.delete.title")} description={t("legal.delete.hint")}>
      <Button variant="danger" onClick={() => setOpen(true)} data-testid="delete-account-open">
        {t("legal.delete.button")}
      </Button>
      <Dialog title={t("legal.delete.title")} open={open} onClose={close}>
        {progress ? (
          <div className="space-y-3 text-sm" role="status" data-testid="delete-progress">
            <p>{t("legal.delete.progress", { done: progress.messages_done, total: progress.messages_total })}</p>
            <progress className="w-full" max={Math.max(1, progress.messages_total)} value={progress.messages_done} />
          </div>
        ) : (
          <div className="space-y-3 text-sm text-fg-1" data-testid="delete-account-dialog">
            <p>{t("legal.delete.text")}</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-fg-2">
              <li>{t("legal.delete.always")}</li>
              <li>{t("legal.delete.kept")}</li>
              <li>{t("legal.delete.grace")}</li>
              <li>{t("legal.delete.federation")}</li>
            </ul>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 h-5 w-5" checked={withMessages} onChange={(e) => setWithMessages(e.target.checked)} data-testid="delete-messages" />
              <span>
                {t("legal.delete.messages")}
                <span className="block text-xs text-fg-2">{t("legal.delete.messages_hint")}</span>
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-fg-2">{t("legal.delete.type", { word: user.username })}</span>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("common.confirmation")} autoComplete="off" data-testid="delete-confirm" />
            </label>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={busy || typed.trim().toLowerCase() !== user.username} onClick={() => void submit()} data-testid="delete-account-confirm">
                {t("legal.delete.confirm")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Section>
  );
}
