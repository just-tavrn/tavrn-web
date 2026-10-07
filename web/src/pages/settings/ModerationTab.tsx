// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PurgeResponse, RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { intlLocale, useT } from "../../i18n";
import { describeError, useToasts } from "../../stores/toasts";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { ConfirmDialog, Section, Select } from "./common";
import { useMembers } from "./MembersTab";
import { channelName } from "../../lib/names";

function toRfc3339(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function ModerationTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  const members = useMembers(room.id);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [authorId, setAuthorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<PurgeResponse | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const request = () => ({ channel_ids: channelIds, author_id: authorId || null, from: toRfc3339(from), to: toRfc3339(to) });

  const runPreview = async () => {
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.rooms.purge(room.id, request()));
    } catch (e) {
      setError(describeError(e));
    }
  };

  const execute = async () => {
    if (!preview?.confirm_token) return;
    const result = await api.rooms.purge(room.id, { ...request(), confirm_token: preview.confirm_token });
    setPreview(null);
    setConfirm(false);
    for (const c of channelIds.length ? channelIds : room.channels.map((x) => x.id)) await queryClient.invalidateQueries({ queryKey: ["messages", c] });
    useToasts.getState().push({ kind: "info", title: t("moderation.deleted", { count: result.messages }) });
  };

  const textChannels = room.channels.filter((c) => c.kind !== "voice");
  const scope = [
    channelIds.length ? t("moderation.scope.channels", { count: channelIds.length }) : t("moderation.scope.all"),
    authorId ? t("moderation.scope.author", { name: members.data?.find((m) => m.user.id === authorId)?.user.display_name ?? authorId }) : null,
    from ? t("moderation.scope.from", { date: new Date(from).toLocaleString(intlLocale()) }) : null,
    to ? t("moderation.scope.to", { date: new Date(to).toLocaleString(intlLocale()) }) : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-4">
      <Section title={t("moderation.purge")} description={t("moderation.purge_hint")}>
        <Field label={t("moderation.channels")}>
          <div className="grid gap-1 sm:grid-cols-2" data-testid="purge-channels">
            {textChannels.map((c) => (
              <label key={c.id} className="flex min-h-9 items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={channelIds.includes(c.id)} onChange={(e) => setChannelIds(e.target.checked ? [...channelIds, c.id] : channelIds.filter((x) => x !== c.id))} />#{channelName(c)}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("moderation.author")}>
          <Select value={authorId} onChange={(e) => setAuthorId(e.target.value)} aria-label={t("moderation.author")}>
            <option value="">{t("moderation.all_authors")}</option>
            {members.data?.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.display_name} ({m.user.address})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("moderation.from")}>
            <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("moderation.to")}>
            <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {preview && (
            <p className="text-sm" data-testid="purge-preview">
              {t("moderation.preview_result", { count: preview.messages, scope })}
            </p>
          )}
          <Button variant="ghost" onClick={() => void runPreview()}>
            {t("moderation.preview")}
          </Button>
          <Button variant="danger" disabled={!preview || preview.messages === 0} onClick={() => setConfirm(true)}>
            {t("moderation.delete")}
          </Button>
        </div>
      </Section>
      <ConfirmDialog
        open={confirm}
        title={t("moderation.confirm_title")}
        text={t("moderation.confirm_text", { count: preview?.messages ?? 0, scope })}
        confirmWord={t("moderation.confirm_word")}
        actionLabel={t("moderation.confirm_action")}
        onClose={() => setConfirm(false)}
        onConfirm={execute}
      />
    </div>
  );
}

export function AuditTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  const members = useMembers(room.id);
  const [before, setBefore] = useState<string | undefined>();
  const entries = useQuery({ queryKey: ["audit", room.id, before], queryFn: () => api.rooms.auditLog(room.id, { limit: 50, before }) });
  const name = (id: string | null | undefined) => (id ? (members.data?.find((m) => m.user.id === id)?.user.display_name ?? id) : t("audit.system"));
  return (
    <Section title={t("audit.title")}>
      {entries.isError && <p className="text-sm text-danger">{describeError(entries.error)}</p>}
      <ul className="divide-y divide-line text-sm" data-testid="audit-list">
        {entries.data?.map((e) => (
          <li key={e.id} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{name(e.actor_id)}</span>
              <span className="text-fg-1">{e.action}</span>
              {e.target && <span className="text-fg-2">→ {e.target}</span>}
              <time className="ml-auto text-xs text-fg-2" dateTime={e.created_at}>
                {new Date(e.created_at).toLocaleString(intlLocale())}
              </time>
            </div>
            {e.reason && <p className="text-xs text-fg-2">{t("audit.reason", { reason: e.reason })}</p>}
            {e.meta && Object.keys(e.meta).length > 0 && <p className="truncate text-xs text-fg-2">{JSON.stringify(e.meta)}</p>}
          </li>
        ))}
        {entries.data?.length === 0 && <li className="py-2 text-fg-2">{t("audit.none")}</li>}
      </ul>
      {entries.data && entries.data.length === 50 && (
        <Button variant="ghost" onClick={() => setBefore(entries.data.at(-1)?.id)}>
          {t("audit.older")}
        </Button>
      )}
    </Section>
  );
}
