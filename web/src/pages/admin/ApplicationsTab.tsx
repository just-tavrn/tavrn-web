// SPDX-License-Identifier: Apache-2.0
/**
 * Node admin: the applications of this node, the approval of their commands (§5.2) and the bot blocklist
 * (tavrn-protocol/APPLICATIONS.md §4.4).
 * Disabling stops an application at once (its tokens get `403 app.disabled`); blocking a bot address, of
 * this node or another, uninstalls it from every room here and refuses it from then on.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminApplication } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError } from "../../stores/toasts";
import { BotBadge } from "../../components/Badges";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, Section } from "../settings/common";
import { CommandApprovalSection } from "./CommandApprovalSection";

/** Disabled by an admin (and not only because the owner is disabled or the bot is blocked): "Enable" undoes it. */
export function adminDisabled(app: Pick<AdminApplication, "disabled" | "disabled_reason">): boolean {
  return app.disabled && app.disabled_reason !== "owner_disabled" && app.disabled_reason !== "blocked";
}

export function ApplicationsTab() {
  return (
    <div className="space-y-4">
      <ApplicationList />
      <CommandApprovalSection />
      <BlockList />
    </div>
  );
}

function ApplicationList() {
  const t = useT();
  const queryClient = useQueryClient();
  const apps = useQuery({ queryKey: ["admin", "applications"], queryFn: () => api.admin.applications() });
  const [deleting, setDeleting] = useState<AdminApplication | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "applications"] });
  const toggle = async (app: AdminApplication) => {
    try {
      await api.admin.updateApplication(app.id, { disabled: !adminDisabled(app) });
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Section title={t("admin.apps.title")} description={t("admin.apps.hint")}>
      {apps.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      {apps.isError && <p className="text-sm text-danger">{describeError(apps.error)}</p>}
      <ul className="divide-y divide-line" data-testid="admin-app-list">
        {apps.data?.map((a) => (
          <li key={a.id} className="space-y-2 py-3 text-sm" data-testid="admin-app-row" data-id={a.id} data-disabled={a.disabled ? "true" : "false"}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.name}</span>
              <BotBadge />
              <span className="break-all text-xs text-fg-2">{a.bot.address}</span>
              {a.disabled && (
                <span className="rounded bg-danger/15 px-1.5 text-xs text-danger" data-testid="admin-app-disabled">
                  {t("admin.apps.disabled", { reason: t(`admin.apps.reason.${a.disabled_reason ?? "admin"}`) })}
                </span>
              )}
            </div>
            <p className="break-words text-xs text-fg-2">
              {t("admin.apps.owner", { owner: a.owner })}
              {" · "}
              {a.public ? t("admin.apps.public") : t("admin.apps.private")}
              {" · "}
              <span data-testid="admin-app-stats">{t("admin.apps.stats", { tokens: a.tokens, installations: a.installations })}</span>
              {" · "}
              {t("admin.apps.created", { date: new Date(a.created_at).toLocaleDateString(intlLocale()) })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" data-testid="admin-app-toggle" onClick={() => void toggle(a)}>
                {adminDisabled(a) ? t("admin.apps.enable") : t("admin.apps.disable")}
              </Button>
              <Button variant="danger" data-testid="admin-app-delete" onClick={() => setDeleting(a)}>
                {t("admin.apps.delete")}
              </Button>
            </div>
          </li>
        ))}
        {apps.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("admin.apps.none")}</li>}
      </ul>
      {deleting && (
        <ConfirmDialog
          open
          title={t("admin.apps.delete_title", { name: deleting.name })}
          text={t("admin.apps.delete_text", { bot: deleting.bot.address })}
          confirmWord={deleting.bot.username}
          actionLabel={t("admin.apps.delete")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.admin.deleteApplication(deleting.id);
            setDeleting(null);
            await refresh();
          }}
        />
      )}
    </Section>
  );
}

function BlockList() {
  const t = useT();
  const queryClient = useQueryClient();
  const blocks = useQuery({ queryKey: ["admin", "application-blocks"], queryFn: () => api.admin.applicationBlocks() });
  const [bot, setBot] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "application-blocks"] }), queryClient.invalidateQueries({ queryKey: ["admin", "applications"] })]);
  return (
    <Section title={t("admin.apps.blocks")} description={t("admin.apps.blocks_hint")}>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        data-testid="admin-app-block-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            // The SDK's request type is named like the user block request (same schema name), hence the cast.
            await api.admin.blockApplication({ bot: bot.trim(), reason: reason.trim() || null });
            setBot("");
            setReason("");
            await refresh();
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("admin.apps.block_bot")}>
          <Input value={bot} onChange={(e) => setBot(e.target.value)} placeholder="bot@node.example" maxLength={320} required data-testid="admin-app-block-bot" />
        </Field>
        <Field label={t("admin.apps.block_reason")}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-testid="admin-app-block-reason" />
        </Field>
        <Button type="submit" variant="danger" disabled={busy || !bot.trim()} data-testid="admin-app-block-submit">
          {t("admin.apps.block")}
        </Button>
      </form>
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="admin-app-block-error">
          {error}
        </p>
      )}
      {blocks.isError && <p className="text-sm text-danger">{describeError(blocks.error)}</p>}
      <ul className="divide-y divide-line" data-testid="admin-app-block-list">
        {blocks.data?.map((b) => (
          <li key={b.bot} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="admin-app-block" data-bot={b.bot}>
            <span className="min-w-0 flex-1 basis-48">
              <span className="block break-all font-mono text-xs text-fg-0">{b.bot}</span>
              {b.reason && <span className="block break-words text-fg-1">{b.reason}</span>}
              <span className="block text-xs text-fg-2">
                {t("admin.apps.blocked_at", { date: new Date(b.created_at).toLocaleString(intlLocale()) })}
                {b.created_by && ` · ${t("admin.apps.blocked_by", { name: b.created_by })}`}
              </span>
            </span>
            <Button
              variant="ghost"
              data-testid="admin-app-unblock"
              onClick={async () => {
                try {
                  await api.admin.unblockApplication(b.bot);
                  await refresh();
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              {t("admin.apps.unblock")}
            </Button>
          </li>
        ))}
        {blocks.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("admin.apps.blocks_none")}</li>}
      </ul>
    </Section>
  );
}
