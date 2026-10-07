// SPDX-License-Identifier: Apache-2.0
/**
 * Room settings, "Webhooks" (tavrn-protocol/APPLICATIONS.md §6.1, `manage_webhooks`): incoming webhooks per channel.
 * Create one with a name (the URL with its secret is shown exactly once), set its avatar, rename it, move it to
 * another channel, reset its URL or delete it. In end-to-end encrypted channels the creator chooses who seals the
 * messages (APPLICATIONS.md §6.1a): the service itself (default) or the node; the list shows the mode and whether
 * the webhook still waits for a member's inbox key.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type Channel, type CreatedWebhook, type RoomDetail, type Webhook } from "@tavrn/sdk";
import { qualify } from "@tavrn/e2ee";
import { intlLocale, useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { UserAvatar } from "../../components/Avatar";
import { WebhookBadge } from "../../components/Badges";
import { Button, Dialog, Field, Input } from "../../components/ui";
import { channelName } from "../../lib/names";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { getMls } from "../../stores/mls";
import { ConfirmDialog, Section, Select } from "./common";

/** Channels webhooks can post in (the node refuses others with `channel.no_text`). */
const WEBHOOK_KINDS = ["text", "announcement"];

type Sealing = "sender" | "node";

/** How a service seals a message itself (libsodium sealed box to the channel's current inbox key). */
const SEAL_SNIPPET = `// Node.js, npm i libsodium-wrappers
const key = await (await fetch(URL + "/inbox-key")).json();
await sodium.ready;
const box = sodium.crypto_box_seal(JSON.stringify({ content: { type: "text", body: "Deployed" } }),
  sodium.from_base64(key.public_key, sodium.base64_variants.URLSAFE_NO_PADDING));
await fetch(URL, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ epoch: key.epoch,
    sealed: sodium.to_base64(box, sodium.base64_variants.URLSAFE_NO_PADDING) }) });`;

/** The mode choice for encrypted channels, with what each mode means. */
function SealingChoice({ value, onChange }: { value: Sealing; onChange: (v: Sealing) => void }) {
  const t = useT();
  return (
    <fieldset className="space-y-2 text-sm sm:col-span-3" data-testid="webhook-sealing">
      <legend className="mb-1 text-fg-1">{t("webhooks.sealing")}</legend>
      {(["sender", "node"] as const).map((mode) => (
        <label key={mode} className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2">
          <input type="radio" name="webhook-sealing" className="mt-1 h-4 w-4 accent-accent" checked={value === mode} onChange={() => onChange(mode)} data-testid={`webhook-sealing-${mode}`} />
          <span>
            <span className="block font-medium text-fg-0">{t(`webhooks.sealing_${mode}`)}</span>
            <span className="block text-xs text-fg-2">{t(`webhooks.sealing_${mode}_hint`)}</span>
          </span>
        </label>
      ))}
      {value === "sender" && (
        <details className="text-xs text-fg-2">
          <summary className="cursor-pointer text-accent">{t("webhooks.sealing_howto")}</summary>
          <pre className="mt-1 overflow-x-auto rounded-md bg-bg-0 p-2 font-mono text-[11px] text-fg-1">{SEAL_SNIPPET}</pre>
        </details>
      )}
    </fieldset>
  );
}

export function WebhooksTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, domain } = useNode();
  const queryClient = useQueryClient();
  const key = ["webhooks", domain, room.id];
  const hooks = useQuery({ queryKey: key, queryFn: () => api.webhooks.list(room.id) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const channels = room.channels.filter((c) => WEBHOOK_KINDS.includes(c.kind));
  const [shown, setShown] = useState<CreatedWebhook | null>(null);
  const mayEveryone = hasPermission(parsePermissions(room.my_permissions), Permission.MENTION_EVERYONE);
  return (
    <div className="space-y-4" data-testid="webhooks-tab">
      <CreateWebhook room={room} channels={channels} mayEveryone={mayEveryone} onCreated={async (c) => { setShown(c); await refresh(); }} />
      <Section title={t("webhooks.list_title")} description={t("webhooks.list_hint")}>
        {hooks.isError && <p className="text-sm text-danger">{describeError(hooks.error)}</p>}
        {hooks.data?.length === 0 && <p className="text-sm text-fg-2">{t("webhooks.none")}</p>}
        <ul className="divide-y divide-line" data-testid="webhook-list">
          {hooks.data?.map((w) => (
            <WebhookRow key={w.id} room={room} webhook={w} channels={channels} onChanged={refresh} onUrl={setShown} />
          ))}
        </ul>
      </Section>
      <UrlDialog created={shown} onClose={() => setShown(null)} />
    </div>
  );
}

function CreateWebhook({ room, channels, mayEveryone, onCreated }: { room: RoomDetail; channels: Channel[]; mayEveryone: boolean; onCreated: (c: CreatedWebhook) => Promise<void> }) {
  const t = useT();
  const { api, domain } = useNode();
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [sealing, setSealing] = useState<Sealing>("sender");
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const encrypted = !!channels.find((c) => c.id === channelId)?.encrypted;
  return (
    <Section title={t("webhooks.create_title")} description={t("webhooks.create_hint")}>
      {channels.length === 0 && <p className="text-sm text-fg-2" data-testid="webhook-no-channel">{t("webhooks.no_channel")}</p>}
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const created = await api.webhooks.create(room.id, channelId, { name: name.trim(), allow_mentions_everyone: everyone, ...(encrypted ? { sealing } : {}) });
            // The webhook is usable once a member published the channel's inbox key: this device does it if it can.
            if (encrypted) await (await getMls())?.publishInboxKey(qualify(domain, channelId)).catch(() => false);
            setName("");
            setEveryone(false);
            await onCreated(created);
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("webhooks.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required data-testid="webhook-name" />
        </Field>
        <Field label={t("webhooks.channel")}>
          <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} data-testid="webhook-channel">
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{channelName(c)}
                {c.encrypted ? ` (${t("webhooks.encrypted_channel")})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={busy || !name.trim() || !channelId} data-testid="webhook-create">
          {t("webhooks.create")}
        </Button>
        {encrypted && <SealingChoice value={sealing} onChange={setSealing} />}
        {mayEveryone && (
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1 sm:col-span-3">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} data-testid="webhook-everyone" />
            {t("webhooks.allow_everyone")}
          </label>
        )}
      </form>
    </Section>
  );
}

function WebhookRow({ room, webhook, channels, onChanged, onUrl }: { room: RoomDetail; webhook: Webhook; channels: Channel[]; onChanged: () => Promise<void>; onUrl: (c: CreatedWebhook) => void }) {
  const t = useT();
  const { api, domain } = useNode();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(webhook.name);
  const [channelId, setChannelId] = useState(webhook.channel_id);
  const [sealing, setSealing] = useState<Sealing>(webhook.sealing === "node" ? "node" : "sender");
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null);
  const targetEncrypted = !!room.channels.find((c) => c.id === channelId)?.encrypted;
  const channel = room.channels.find((c) => c.id === webhook.channel_id);
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await onChanged();
    } catch (err) {
      toastError(err);
    }
  };
  const used = webhook.last_used_at ? new Date(webhook.last_used_at).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" }) : t("webhooks.never_used");
  return (
    <li className="space-y-2 py-2" data-testid="webhook-row" data-webhook-id={webhook.id} data-sealing={webhook.sealing ?? undefined} data-pending={webhook.pending_key || undefined}>
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar user={webhook.user} size={36} node={domain} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium" data-testid="webhook-row-name">{webhook.name}</span>
            <WebhookBadge />
          </p>
          <p className="truncate text-xs text-fg-2">
            #{channel ? channelName(channel) : "?"} · {t("webhooks.last_used", { date: used })}
            {webhook.sealing && <span data-testid="webhook-mode"> · 🔒 {t(`webhooks.mode_${webhook.sealing === "node" ? "node" : "sender"}`)}</span>}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing} data-testid="webhook-edit">
          {t("webhooks.edit")}
        </Button>
      </div>
      {webhook.pending_key && (
        <p className="rounded-md bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="webhook-pending">
          ⏳ {t("webhooks.pending_key")}
        </p>
      )}
      {editing && (
        <div className="space-y-3 rounded-md border border-line p-3" data-testid="webhook-editor">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const mode = targetEncrypted && sealing !== webhook.sealing ? sealing : undefined;
              void run(() => api.webhooks.update(room.id, webhook.id, { name: name.trim() !== webhook.name ? name.trim() : undefined, channel_id: channelId !== webhook.channel_id ? channelId : undefined, sealing: mode }));
            }}
          >
            <Field label={t("webhooks.name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required data-testid="webhook-rename" />
            </Field>
            <Field label={t("webhooks.channel")}>
              <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} data-testid="webhook-move">
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{channelName(c)}
                    {c.encrypted ? ` (${t("webhooks.encrypted_channel")})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" data-testid="webhook-save">
              {t("common.save")}
            </Button>
            {targetEncrypted && <SealingChoice value={sealing} onChange={setSealing} />}
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <label className="cursor-pointer text-sm text-accent hover:underline">
              {t("webhooks.avatar_upload")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm"
                className="sr-only"
                data-testid="webhook-avatar"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void run(() => api.webhooks.uploadAvatar(room.id, webhook.id, file));
                }}
              />
            </label>
            {webhook.avatar && (
              <Button variant="ghost" onClick={() => void run(() => api.webhooks.deleteAvatar(room.id, webhook.id))}>
                {t("webhooks.avatar_remove")}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => setConfirm("reset")} data-testid="webhook-reset">
              {t("webhooks.reset")}
            </Button>
            <Button variant="danger" onClick={() => setConfirm("delete")} data-testid="webhook-delete">
              {t("webhooks.delete")}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm === "reset"}
        title={t("webhooks.reset")}
        text={t("webhooks.reset_text", { name: webhook.name })}
        actionLabel={t("webhooks.reset_action")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const created = await api.webhooks.reset(room.id, webhook.id);
          setConfirm(null);
          onUrl(created);
          await onChanged();
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("webhooks.delete")}
        text={t("webhooks.delete_text", { name: webhook.name })}
        actionLabel={t("webhooks.delete_action")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.webhooks.delete(room.id, webhook.id);
          setConfirm(null);
          await onChanged();
        }}
      />
    </li>
  );
}

/** The execution URL, shown once after creating or resetting a webhook. */
function UrlDialog({ created, onClose }: { created: CreatedWebhook | null; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog title={t("webhooks.url_title", { name: created?.webhook.name ?? "" })} open={!!created} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-fg-1">{t("webhooks.url_once")}</p>
        <textarea readOnly value={created?.url ?? ""} rows={3} className="w-full break-all rounded-md border border-line bg-bg-0 p-2 font-mono text-xs" onFocus={(e) => e.target.select()} data-testid="webhook-url" aria-label={t("webhooks.url_label")} />
        <p className="text-xs text-warn">{t("webhooks.url_warning")}</p>
        {created?.webhook.sealing === "sender" && (
          <div className="space-y-1">
            <p className="text-xs text-fg-1">{t("webhooks.inbox_url_label")}</p>
            <textarea readOnly value={`${created.url}/inbox-key`} rows={3} className="w-full break-all rounded-md border border-line bg-bg-0 p-2 font-mono text-xs" onFocus={(e) => e.target.select()} data-testid="webhook-inbox-url" aria-label={t("webhooks.inbox_url_label")} />
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(`${created.url}/inbox-key`).then(() => useToasts.getState().push({ kind: "info", title: t("menu.copied") }), () => undefined)} data-testid="webhook-inbox-url-copy">
              {t("common.copy")}
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(created?.url ?? "");
                useToasts.getState().push({ kind: "info", title: t("menu.copied") });
              } catch {
                /* the field stays selectable */
              }
            }}
            data-testid="webhook-url-copy"
          >
            {t("common.copy")}
          </Button>
          <Button onClick={onClose} data-testid="webhook-url-done">
            {t("webhooks.url_done")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
