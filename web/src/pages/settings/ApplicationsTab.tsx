// SPDX-License-Identifier: Apache-2.0
/**
 * Applications (bots) of the signed-in user (tavrn-protocol/APPLICATIONS.md §1.3–§1.6, §2.2, §3.4): create, edit and
 * delete applications, manage their tokens (the secret is shown exactly once), transfer them to another local
 * user and reset a bot's identity. Bot tokens are a single factor: the UI says so wherever a secret appears.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ALL_PERMISSIONS, Permission, SCOPE_NAMES, parsePermissions, type Application, type AppToken, type TokenSecret } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { UserAvatar } from "../../components/Avatar";
import { BotBadge } from "../../components/Badges";
import { Button, Dialog, ErrorText, Field, Input } from "../../components/ui";
import { ConfirmDialog, PermissionCheckboxes, Section, Select, Textarea } from "./common";
import { SubscriptionSection } from "./SubscriptionSection";

const KEY = ["applications"];

export function ApplicationsTab() {
  const t = useT();
  const apps = useQuery({ queryKey: KEY, queryFn: () => api.applications.list() });
  const [selected, setSelected] = useState<string | null>(null);
  const current = apps.data?.find((a) => a.id === selected);
  return (
    <div className="space-y-4" data-testid="applications-tab">
      <IncomingTransfers />
      <CreateApplication onCreated={setSelected} />
      <Section title={t("apps.list_title")} description={t("apps.list_hint")}>
        {apps.isError && <p className="text-sm text-danger">{describeError(apps.error)}</p>}
        {apps.data?.length === 0 && <p className="text-sm text-fg-2">{t("apps.none")}</p>}
        <ul className="divide-y divide-line" data-testid="application-list">
          {apps.data?.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setSelected(a.id === selected ? null : a.id)} className={`flex min-h-12 w-full items-center gap-3 rounded-md px-2 text-left text-sm ${a.id === selected ? "bg-bg-3" : "hover:bg-bg-3/60"}`} data-testid="application-row" aria-expanded={a.id === selected}>
                <UserAvatar user={a.bot} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    <BotBadge />
                    {a.disabled && <span className="text-xs text-danger">{t("apps.disabled")}</span>}
                  </span>
                  <span className="block truncate text-xs text-fg-2">{a.bot.address}</span>
                </span>
                <span className="text-xs text-fg-2">{t("apps.token_count", { count: String(a.tokens) })}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      {current && <ApplicationEditor key={current.id} app={current} onDeleted={() => setSelected(null)} />}
    </div>
  );
}

function ScopeCheckboxes({ value, onChange, allowed, idPrefix }: { value: string[]; onChange: (next: string[]) => void; allowed?: string[]; idPrefix: string }) {
  const t = useT();
  return (
    <fieldset className="grid gap-1 sm:grid-cols-2" data-testid={`${idPrefix}-scopes`}>
      <legend className="mb-1 text-xs text-fg-2">{t("apps.scopes")}</legend>
      {SCOPE_NAMES.filter((s) => !allowed || allowed.includes(s)).map((s) => (
        <label key={s} className="flex min-h-9 items-center gap-2 text-sm text-fg-1" title={t(`apps.scope.${s}`)}>
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={value.includes(s)} onChange={(e) => onChange(e.target.checked ? SCOPE_NAMES.filter((x) => x === s || value.includes(x)) : value.filter((x) => x !== s))} data-scope={s} />
          <span>
            <code className="text-xs">{s}</code> <span className="text-xs text-fg-2">{t(`apps.scope.${s}`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CreateApplication({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<string[]>(SCOPE_NAMES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const app = await api.applications.create({ name, username: username.trim() || null, description, scopes });
      setName("");
      setUsername("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: KEY });
      onCreated(app.id);
      useToasts.getState().push({ kind: "info", title: t("apps.created", { name: app.name }) });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <Section title={t("apps.create_title")} description={t("apps.create_hint")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("apps.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={32} required data-testid="app-name" />
          </Field>
          <Field label={t("apps.username")} hint={t("apps.username_hint")}>
            <Input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} maxLength={32} pattern="[a-z0-9][a-z0-9_.\-]{1,31}" data-testid="app-username" />
          </Field>
        </div>
        <Field label={t("apps.description")}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={400} />
        </Field>
        <ScopeCheckboxes value={scopes} onChange={setScopes} idPrefix="create" />
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || name.trim().length < 2} data-testid="app-create">
            {t("apps.create")}
          </Button>
        </div>
      </Section>
    </form>
  );
}

function ApplicationEditor({ app, onDeleted }: { app: Application; onDeleted: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [isPublic, setPublic] = useState(app.public);
  const [scopes, setScopes] = useState<string[]>(app.scopes);
  const [requested, setRequested] = useState(parsePermissions(app.requested_permissions));
  const [dmPolicy, setDmPolicy] = useState(app.dm_policy);
  const [confirm, setConfirm] = useState<"delete" | "identity" | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.applications.update(app.id, { name, description, public: isPublic, scopes, requested_permissions: (requested & ~Permission.ADMINISTRATOR).toString(), dm_policy: dmPolicy });
      await refresh();
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div className="space-y-4" data-testid="application-editor">
      <form onSubmit={save}>
        <Section title={app.name} description={t("apps.editor_hint", { address: app.bot.address })}>
          <div className="flex flex-wrap items-center gap-3">
            <UserAvatar user={app.bot} size={48} />
            <label className="cursor-pointer text-sm text-accent hover:underline">
              {t("apps.avatar_upload")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
                className="sr-only"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    await api.applications.uploadAvatar(app.id, file);
                    await refresh();
                  } catch (err) {
                    toastError(err);
                  }
                }}
              />
            </label>
            {app.bot.avatar && (
              <Button variant="ghost" onClick={async () => { try { await api.applications.deleteAvatar(app.id); await refresh(); } catch (err) { toastError(err); } }}>
                {t("apps.avatar_remove")}
              </Button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("apps.name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={32} required />
            </Field>
            <Field label={t("apps.dm_policy")}>
              <Select value={dmPolicy} onChange={(e) => setDmPolicy(e.target.value)}>
                {["friends", "everyone_shared", "everyone"].map((p) => (
                  <option key={p} value={p}>
                    {t(`privacy.dm.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("apps.description")}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={400} />
          </Field>
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
            {t("apps.public")}
          </label>
          <ScopeCheckboxes value={scopes} onChange={setScopes} idPrefix="edit" />
          <details>
            <summary className="cursor-pointer text-sm text-fg-1">{t("apps.requested_permissions")}</summary>
            <p className="my-2 text-xs text-fg-2">{t("apps.requested_permissions_hint")}</p>
            <PermissionCheckboxes value={requested} onChange={setRequested} limit={ALL_PERMISSIONS & ~Permission.ADMINISTRATOR} idPrefix={`app-${app.id}`} />
          </details>
          <div className="flex justify-end">
            <Button type="submit">{t("common.save")}</Button>
          </div>
        </Section>
      </form>
      <Tokens app={app} />
      <SubscriptionSection app={app} />
      <TransferSection app={app} />
      <Section title={t("settings.danger")}>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setConfirm("identity")} data-testid="app-identity-reset">
            {t("apps.identity_reset")}
          </Button>
          <Button variant="danger" onClick={() => setConfirm("delete")} data-testid="app-delete">
            {t("apps.delete")}
          </Button>
        </div>
      </Section>
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("apps.delete")}
        text={t("apps.delete_text", { name: app.name })}
        confirmWord={app.name}
        actionLabel={t("apps.delete_action")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.applications.delete(app.id, app.name);
          setConfirm(null);
          onDeleted();
          await refresh();
        }}
      />
      <ConfirmDialog
        open={confirm === "identity"}
        title={t("apps.identity_reset")}
        text={t("apps.identity_reset_text")}
        actionLabel={t("apps.identity_reset_action")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.applications.resetIdentity(app.id);
          setConfirm(null);
          useToasts.getState().push({ kind: "info", title: t("apps.identity_reset_done") });
        }}
      />
    </div>
  );
}

function Tokens({ app }: { app: Application }) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = ["application-tokens", app.id];
  const tokens = useQuery({ queryKey: key, queryFn: () => api.applications.tokens(app.id) });
  const [name, setName] = useState("");
  const [days, setDays] = useState(365);
  const [shown, setShown] = useState<TokenSecret | null>(null);
  const [revoke, setRevoke] = useState<AppToken | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await queryClient.invalidateQueries({ queryKey: KEY });
  };
  const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(intlLocale()) : "—");
  return (
    <Section title={t("apps.tokens")} description={t("apps.tokens_hint")}>
      {tokens.isError && <p className="text-sm text-danger">{describeError(tokens.error)}</p>}
      <ul className="divide-y divide-line" data-testid="token-list">
        {tokens.data?.map((tok) => (
          <li key={tok.id} className="flex min-h-12 flex-wrap items-center gap-2 py-1 text-sm" data-testid="token-row">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{tok.name}</p>
              <p className="truncate text-xs text-fg-2">
                {t("apps.token_meta", { expires: date(tok.expires_at), used: date(tok.last_used_at) })} · {tok.scopes.join(", ") || t("apps.no_scopes")}
              </p>
            </div>
            <Button variant="ghost" onClick={async () => { try { setShown(await api.applications.resetToken(app.id, tok.id)); await refresh(); } catch (e) { toastError(e); } }} data-testid="token-reset">
              {t("apps.token_reset")}
            </Button>
            <Button variant="ghost" onClick={() => setRevoke(tok)} data-testid="token-revoke">
              {t("apps.token_revoke")}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setShown(await api.applications.createToken(app.id, { name, expires_in_days: days }));
            setName("");
            await refresh();
          } catch (err) {
            toastError(err);
          }
        }}
      >
        <div className="min-w-40 flex-1">
          <Field label={t("apps.token_name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required data-testid="token-name" />
          </Field>
        </div>
        <div className="w-32">
          <Field label={t("apps.token_days")}>
            <Input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </Field>
        </div>
        <Button type="submit" disabled={!name.trim()} data-testid="token-create">
          {t("apps.token_create")}
        </Button>
      </form>
      <Dialog title={t("apps.secret_title")} open={!!shown} onClose={() => setShown(null)}>
        <div className="space-y-3 text-sm">
          <p className="text-fg-1">{t("apps.secret_once")}</p>
          <textarea readOnly value={shown?.secret ?? ""} rows={4} className="w-full break-all rounded-md border border-line bg-bg-0 p-2 font-mono text-xs" onFocus={(e) => e.target.select()} data-testid="token-secret" aria-label={t("apps.secret_title")} />
          <p className="text-xs text-warn">{t("apps.secret_warning")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(shown?.secret ?? "")}>
              {t("common.copy")}
            </Button>
            <Button onClick={() => setShown(null)} data-testid="token-secret-done">
              {t("apps.secret_done")}
            </Button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!revoke}
        title={t("apps.token_revoke")}
        text={t("apps.token_revoke_text", { name: revoke?.name ?? "" })}
        actionLabel={t("apps.token_revoke")}
        onClose={() => setRevoke(null)}
        onConfirm={async () => {
          if (revoke) await api.applications.revokeToken(app.id, revoke.id);
          setRevoke(null);
          await refresh();
        }}
      />
    </Section>
  );
}

function TransferSection({ app }: { app: Application }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [to, setTo] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  if (app.transfer) {
    return (
      <Section title={t("apps.transfer")}>
        <p className="text-sm text-fg-1" data-testid="transfer-pending">
          {t("apps.transfer_pending", { to: app.transfer.to, date: new Date(app.transfer.expires_at).toLocaleDateString(intlLocale()) })}
        </p>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={async () => { try { await api.applications.cancelTransfer(app.id); await refresh(); } catch (e) { toastError(e); } }}>
            {t("apps.transfer_cancel")}
          </Button>
        </div>
      </Section>
    );
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.applications.transfer(app.id, to.trim());
          setTo("");
          await refresh();
        } catch (err) {
          toastError(err);
        }
      }}
    >
      <Section title={t("apps.transfer")} description={t("apps.transfer_hint")}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <Field label={t("apps.transfer_to")}>
              <Input value={to} onChange={(e) => setTo(e.target.value)} maxLength={64} required />
            </Field>
          </div>
          <Button type="submit" variant="ghost" disabled={!to.trim()}>
            {t("apps.transfer_start")}
          </Button>
        </div>
      </Section>
    </form>
  );
}

function IncomingTransfers() {
  const t = useT();
  const queryClient = useQueryClient();
  const incoming = useQuery({ queryKey: ["application-transfers"], queryFn: () => api.applications.incomingTransfers() });
  if (!incoming.data?.length) return null;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["application-transfers"] });
    await queryClient.invalidateQueries({ queryKey: KEY });
  };
  return (
    <Section title={t("apps.incoming_title")} description={t("apps.incoming_hint")}>
      <ul className="divide-y divide-line">
        {incoming.data.map((x) => (
          <li key={x.application_id} className="flex min-h-12 flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{t("apps.incoming_item", { name: x.name, from: x.from })}</span>
            <Button onClick={async () => { try { await api.applications.acceptTransfer(x.application_id); await refresh(); } catch (e) { toastError(e); } }}>{t("apps.accept")}</Button>
            <Button variant="ghost" onClick={async () => { try { await api.applications.declineTransfer(x.application_id); await refresh(); } catch (e) { toastError(e); } }}>{t("apps.decline")}</Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
