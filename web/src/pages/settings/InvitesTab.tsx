// SPDX-License-Identifier: Apache-2.0
/**
 * Room settings, "Invites" (design note 4.13 item 8, `manage_room`): every active invite with code, creator,
 * uses, expiry and creation date; revoke (with a confirmation) and create with custom max uses and validity
 * including "never". The list refreshes after every action and when the window regains focus.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Invite, RoomDetail } from "@tavrn/sdk";
import { intlLocale, useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { useNodes } from "../../stores/nodes";
import { homeWeb } from "../../stores/auth";
import { Button, Dialog } from "../../components/ui";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { DEFAULT_EXPIRY_HOURS, MAX_USES_CHOICES, expiryChoices, inviteActive } from "../../lib/inviteExpiry";
import { Section, Select } from "./common";

export function InvitesTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, home, domain } = useNode();
  const web = useNodes((s) => (home ? homeWeb() : (s.sessions[domain]?.web ?? `https://${domain}`)));
  const queryClient = useQueryClient();
  const key = ["invites", domain, room.id];
  const invites = useQuery({ queryKey: key, queryFn: () => api.invites.list(room.id) });
  const [maxUses, setMaxUses] = useState(0);
  const [hours, setHours] = useState(DEFAULT_EXPIRY_HOURS);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const date = (iso: string) => new Date(iso).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
  const link = (code: string) => `${web}/invite/${code}`;

  const create = async () => {
    setBusy(true);
    try {
      const invite = await api.invites.create(room.id, { max_uses: maxUses, expires_hours: hours });
      await refresh();
      void navigator.clipboard?.writeText(link(invite.code)).catch(() => undefined);
      useToasts.getState().push({ kind: "info", title: t("invites.created") });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (invite: Invite) => {
    try {
      await api.invites.delete(room.id, invite.code);
      setRevoking(null);
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const active = (invites.data ?? []).filter((i) => inviteActive(i));

  return (
    <div className="space-y-4">
      <Section title={t("invites.create_title")} description={t("invites.create_hint")}>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs text-fg-2">
            {t("invites.max_uses")}
            <Select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} data-testid="invite-max-uses">
              {MAX_USES_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t("invites.unlimited") : String(n)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs text-fg-2">
            {t("invites.expires")}
            <Select value={hours} onChange={(e) => setHours(Number(e.target.value))} data-testid="invite-expiry">
              {expiryChoices(true).map((h) => (
                <option key={h} value={h}>
                  {t(`invite.expiry.${h}`)}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" disabled={busy} data-testid="invite-create">
            {t("invites.create")}
          </Button>
        </form>
      </Section>
      <Section title={t("invites.title")} description={t("invites.hint")}>
        {invites.isError && <p className="text-sm text-danger">{describeError(invites.error)}</p>}
        {invites.data && active.length === 0 && <p className="text-sm text-fg-2">{t("invites.none")}</p>}
        <ul className="divide-y divide-line" data-testid="invite-list">
          {active.map((i) => (
            <li key={i.code} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm" data-testid="invite-row" data-code={i.code}>
              <div className="min-w-0 flex-[1_1_14rem]">
                <p className="truncate font-mono" title={link(i.code)}>
                  {i.code}
                  {i.direct && <span className="ml-2 rounded bg-bg-3 px-1 font-sans text-xs text-fg-2">{t("invites.direct", { user: i.user ?? "" })}</span>}
                </p>
                <p className="truncate text-xs text-fg-2">{t("invites.by", { name: i.creator ?? i.creator_id, date: date(i.created_at) })}</p>
              </div>
              <span className="text-xs text-fg-1" data-testid="invite-uses">
                {i.max_uses === 0 ? t("invites.uses_unlimited", { uses: i.uses }) : t("invites.uses", { uses: i.uses, max: i.max_uses })}
              </span>
              <span className="text-xs text-fg-1" data-testid="invite-expires">
                {i.expires_at ? t("invites.expires_at", { date: date(i.expires_at) }) : t("invites.never")}
              </span>
              <div className="ml-auto flex gap-1">
                <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(link(i.code)).catch(() => undefined)} aria-label={t("invites.copy", { code: i.code })}>
                  {t("common.copy")}
                </Button>
                <Button variant="ghost" onClick={() => setRevoking(i)} data-testid="invite-revoke">
                  {t("invites.revoke")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
      <Dialog title={t("invites.revoke_title")} open={!!revoking} onClose={() => setRevoking(null)}>
        <div className="space-y-3">
          <p className="break-words text-sm text-fg-1">{t("invites.revoke_body", { code: revoking?.code ?? "" })}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)} data-testid="invite-revoke-confirm">
              {t("invites.revoke")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
