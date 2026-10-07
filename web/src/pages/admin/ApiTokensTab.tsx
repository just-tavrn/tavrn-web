// SPDX-License-Identifier: Apache-2.0
/**
 * Node admin: admin API tokens (design note 4.13 item 1, tavrn-protocol/ENTITLEMENTS.md §5). A token is valid for the
 * `/api/v1/admin/*` routes its scopes cover and acts as its creator; the secret is shown exactly once.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminToken } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, Section } from "../settings/common";
import { toIso } from "./EntitlementsTab";

export const ADMIN_TOKEN_SCOPES = ["entitlements", "users:read", "users:write", "invites"] as const;

export function ApiTokensTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: ["admin", "tokens"], queryFn: () => api.admin.tokens() });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["entitlements"]);
  const [expires, setExpires] = useState("");
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<AdminToken | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "tokens"] });
  const date = (iso: string) => new Date(iso).toLocaleString(intlLocale());
  return (
    <Section title={t("admin_tokens.title")} description={t("admin_tokens.hint")}>
      <form
        className="space-y-3 rounded-md border border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const created = await api.admin.createToken({ name, scopes, expires_at: toIso(expires) });
            setSecret({ name: created.name, value: created.secret });
            setName("");
            setExpires("");
            await refresh();
          } catch (err) {
            toastError(err);
          }
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t("admin_tokens.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </Field>
          <Field label={t("admin_tokens.expires")} hint={t("admin_tokens.expires_hint")}>
            <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-1">{t("admin_tokens.scopes")}</legend>
          {ADMIN_TOKEN_SCOPES.map((s) => (
            <label key={s} className="flex min-h-9 items-start gap-2 text-sm text-fg-1">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-accent"
                checked={scopes.includes(s)}
                onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
              />
              <span>
                <span className="font-mono text-xs">{s}</span>
                <span className="block text-xs text-fg-2">{t(`admin_tokens.scope.${s}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end">
          <Button type="submit" disabled={scopes.length === 0}>
            {t("admin_tokens.create")}
          </Button>
        </div>
      </form>

      {secret && (
        <div className="space-y-2 rounded-md border border-warn/50 bg-warn/10 p-3 text-sm" role="status" data-testid="admin-token-secret">
          <p className="font-medium">{t("admin_tokens.secret_title", { name: secret.name })}</p>
          <p className="text-xs text-fg-1">{t("admin_tokens.secret_hint")}</p>
          <code className="block break-all rounded bg-bg-0 px-2 py-1 font-mono text-xs" data-testid="admin-token-secret-value">
            {secret.value}
          </code>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(secret.value)}>
              {t("common.copy")}
            </Button>
            <Button variant="ghost" onClick={() => setSecret(null)}>
              {t("admin_tokens.secret_done")}
            </Button>
          </div>
        </div>
      )}

      {tokens.isError && <p className="text-sm text-danger">{describeError(tokens.error)}</p>}
      <ul className="divide-y divide-line" data-testid="admin-token-list">
        {tokens.data?.map((tok) => (
          <li key={tok.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className="font-medium">{tok.name}</span>
            <span className="flex flex-wrap gap-1">
              {tok.scopes.map((s) => (
                <span key={s} className="rounded bg-bg-3 px-1.5 font-mono text-xs text-fg-1">
                  {s}
                </span>
              ))}
            </span>
            {tok.expired && <span className="rounded bg-danger/15 px-1.5 text-xs text-danger">{t("entitlements.expired")}</span>}
            <span className="basis-full text-xs text-fg-2 sm:basis-auto">
              {t("admin_tokens.created", { date: date(tok.created_at) })}
              {" · "}
              {tok.last_used_at ? t("admin_tokens.last_used", { date: date(tok.last_used_at) }) : t("admin_tokens.never_used")}
              {" · "}
              {tok.expires_at ? t("entitlements.expires_on", { date: date(tok.expires_at) }) : t("entitlements.no_expiry")}
            </span>
            <span className="flex-1" />
            <Button variant="danger" onClick={() => setRevoking(tok)}>
              {t("admin_tokens.revoke")}
            </Button>
          </li>
        ))}
        {tokens.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("admin_tokens.none")}</li>}
      </ul>
      {revoking && (
        <ConfirmDialog
          open
          title={t("admin_tokens.revoke_title", { name: revoking.name })}
          text={t("admin_tokens.revoke_text")}
          actionLabel={t("admin_tokens.revoke")}
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.admin.revokeToken(revoking.id);
            setRevoking(null);
            await refresh();
          }}
        />
      )}
    </Section>
  );
}
