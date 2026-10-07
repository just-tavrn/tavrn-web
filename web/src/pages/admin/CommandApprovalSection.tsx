// SPDX-License-Identifier: Apache-2.0
/**
 * Node admin: approval of application commands (tavrn-protocol/APPLICATIONS.md §5.2). Lists the command definitions of every
 * application known on this node per state (pending, approved, rejected), grouped by application, with approve and
 * reject; shows whether `TAVRN_APP_COMMANDS_REQUIRE_APPROVAL` is on. Any change of a definition makes it pending again.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandApproval } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { useT } from "../../i18n";
import { describeError, toastError } from "../../stores/toasts";
import { BotBadge } from "../../components/Badges";
import { Button } from "../../components/ui";
import { Section } from "../settings/common";

const STATES = ["pending", "approved", "rejected"] as const;
type State = (typeof STATES)[number];

export function CommandApprovalSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>("pending");
  const settings = useQuery({ queryKey: ["admin", "command-approval"], queryFn: () => api.commands.approvalSettings() });
  const list = useQuery({ queryKey: ["admin", "command-approvals", state], queryFn: () => api.commands.approvals(state) });
  const apps = useQuery({ queryKey: ["admin", "applications"], queryFn: () => api.admin.applications() });
  const [busy, setBusy] = useState(false);
  const nameOf = (ref: string) => (Array.isArray(apps.data) ? apps.data : []).find((a) => ref.endsWith(`/${a.id}`))?.name ?? ref;
  const groups = new Map<string, CommandApproval[]>();
  for (const c of Array.isArray(list.data) ? list.data : []) {
    if (typeof c.application === "string") groups.set(c.application, [...(groups.get(c.application) ?? []), c]);
  }
  const decide = async (application: string, hashes: string[], approve: boolean) => {
    setBusy(true);
    try {
      const req = { application, hashes };
      await (approve ? api.commands.approve(req) : api.commands.reject(req));
      await queryClient.invalidateQueries({ queryKey: ["admin", "command-approvals"] });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const required = settings.data?.required;
  return (
    <Section title={t("admin.apps.approval.title")} description={required === undefined ? undefined : required ? t("admin.apps.approval.on") : t("admin.apps.approval.off")}>
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={t("admin.apps.approval.filter")} data-testid="command-approval-filter" data-required={required === undefined ? undefined : String(required)}>
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={state === s}
            onClick={() => setState(s)}
            data-testid={`command-approval-state-${s}`}
            className={`min-h-10 rounded-md px-3 text-sm ${state === s ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60"}`}
          >
            {t(`admin.apps.approval.state.${s}`)}
          </button>
        ))}
      </div>
      {list.isError && <p className="text-sm text-danger">{describeError(list.error)}</p>}
      {list.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      <ul className="space-y-3" data-testid="command-approval-list">
        {[...groups.entries()].map(([application, commands]) => (
          <li key={application} className="rounded-md border border-line p-3" data-testid="command-approval-app" data-application={application}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{nameOf(application)}</span>
              <BotBadge />
              <span className="break-all text-xs text-fg-2">{application}</span>
              {state !== "approved" && commands.length > 1 && (
                <Button variant="ghost" className="ml-auto" disabled={busy} onClick={() => void decide(application, commands.map((c) => c.definition_hash), true)} data-testid="command-approval-approve-all">
                  {t("admin.apps.approval.approve_all", { count: commands.length })}
                </Button>
              )}
            </div>
            <ul className="mt-2 divide-y divide-line">
              {commands.map((c) => (
                <li key={c.definition_hash} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="command-approval-row" data-command={c.command.name} data-state={c.state}>
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="font-mono text-fg-0">/{c.command.name}</span>
                    <span className="block break-words text-xs text-fg-2">
                      {c.command.description} · {t("admin.apps.approval.args", { count: c.command.args?.length ?? 0 })}
                    </span>
                  </span>
                  {c.state !== "approved" && (
                    <Button variant="ghost" disabled={busy} onClick={() => void decide(application, [c.definition_hash], true)} data-testid="command-approval-approve">
                      {t("admin.apps.approval.approve")}
                    </Button>
                  )}
                  {c.state !== "rejected" && (
                    <Button variant="danger" disabled={busy} onClick={() => void decide(application, [c.definition_hash], false)} data-testid="command-approval-reject">
                      {t("admin.apps.approval.reject")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
        {groups.size === 0 && list.isSuccess && <li className="py-2 text-sm text-fg-2">{t("admin.apps.approval.none")}</li>}
      </ul>
    </Section>
  );
}
