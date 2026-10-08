// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EVERYONE_RESTRICTED, Permission, hasPermission, parsePermissions, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useSearchParams } from "react-router";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, OverrideTriState, Section, Select } from "./common";
import { categoryName, channelName } from "../../lib/names";
import { BotsAllowedIcon, NoBotsIcon } from "../../components/Badges";
import { botMarker } from "../../lib/botAccess";
import { ChannelBotsAllowed } from "./BotsEncryptionSection";
import { HistoryPolicySection } from "./HistoryPolicy";
import { ThreadSettingsSection } from "../../threads/ThreadSettings";
import { StorageSection } from "../../files/StorageSection";
import { VoiceQualitySection } from "./VoiceQualitySection";

export function ChannelsTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  // `?channel=<id>`: opened from a channel's context menu ("Edit channel"); otherwise the first regular
  // channel (the welcome channel, kind "system", is fixed).
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(params.get("channel") ?? (room.channels.find((c) => c.kind !== "system") ?? room.channels[0])?.id ?? "");
  const selected = room.channels.find((c) => c.id === selectedId) ?? room.channels[0];
  const [newCategory, setNewCategory] = useState("");
  const queryClient = useQueryClient();
  const perms = parsePermissions(room.my_permissions);
  const canManage = hasPermission(perms, Permission.MANAGE_CHANNELS);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["room", room.id] });

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <Section title={t("channels.title")}>
        {room.categories.map((cat) => (
          <div key={cat.id}>
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-fg-2">
              <span>{categoryName(cat)}</span>
              {canManage && (
                <button type="button" aria-label={t("channels.delete_category", { name: categoryName(cat) })} className="min-h-6 min-w-6 text-fg-2 hover:text-danger" onClick={async () => { try { await api.channels.deleteCategory(room.id, cat.id); await refresh(); } catch (e) { toastError(e); } }}>
                  ×
                </button>
              )}
            </div>
            <ChannelButtons room={room} channels={room.channels.filter((c) => c.category_id === cat.id)} selectedId={selected?.id} onSelect={setSelectedId} />
          </div>
        ))}
        {room.channels.some((c) => !c.category_id) && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{t("channels.uncategorized")}</div>
            <ChannelButtons room={room} channels={room.channels.filter((c) => !c.category_id)} selectedId={selected?.id} onSelect={setSelectedId} />
          </div>
        )}
        {canManage && (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.channels.createCategory(room.id, { name: newCategory });
                setNewCategory("");
                await refresh();
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder={t("channels.new_category")} aria-label={t("channels.new_category")} maxLength={100} />
            <Button type="submit" variant="ghost" disabled={!newCategory.trim()}>
              +
            </Button>
          </form>
        )}
      </Section>
      {selected && <ChannelEditor key={selected.id} channel={selected} room={room} canManage={canManage} onChanged={refresh} />}
    </div>
  );
}

function ChannelButtons({ room, channels, selectedId, onSelect }: { room: RoomDetail; channels: Channel[]; selectedId?: string; onSelect: (id: string) => void }) {
  const t = useT();
  return (
    <ul className="mt-1 space-y-0.5">
      {channels.map((c) => (
        <li key={c.id}>
          <button type="button" onClick={() => onSelect(c.id)} className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selectedId === c.id ? "bg-bg-3 text-fg-0" : "text-fg-1 hover:bg-bg-3/60"}`}>
            <span className="text-fg-2">{c.kind === "voice" ? "🔊" : c.kind === "files" ? "📁" : "#"}</span>
            <span className="truncate">{channelName(c)}</span>
            {!c.encrypted && c.kind !== "voice" && <span title={t("channel.unencrypted")} className="text-[10px]">🔓</span>}
            {botMarker(c, room) === "no_bots" && <NoBotsIcon />}
            {botMarker(c, room) === "bots_allowed" && <BotsAllowedIcon />}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChannelEditor({ channel, room, canManage, onChanged }: { channel: Channel; room: RoomDetail; canManage: boolean; onChanged: () => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [categoryId, setCategoryId] = useState(channel.category_id ?? "");
  const [slowmode, setSlowmode] = useState(channel.slowmode_secs);
  const [encrypted, setEncrypted] = useState(channel.encrypted);
  const [sync, setSync] = useState(channel.sync_with_category);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmEncryption, setConfirmEncryption] = useState(false);
  const isVoice = channel.kind === "voice";
  // Files channels have no messages and are never end-to-end encrypted (design note 4.13 item 9).
  const isFiles = channel.kind === "files";
  const canManageRoles = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROLES);

  const save = async () => {
    try {
      await api.channels.update(room.id, channel.id, { name, topic, category_id: categoryId || null, slowmode_secs: slowmode, sync_with_category: sync, encrypted: isVoice || isFiles ? null : encrypted });
      await onChanged();
      useToasts.getState().push({ kind: "info", title: t("channels.saved") });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="space-y-4" data-testid="channel-editor">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isVoice && encrypted !== channel.encrypted && !encrypted) setConfirmEncryption(true);
          else void save();
        }}
      >
        <Section title={`${isVoice ? "🔊" : isFiles ? "📁" : "#"} ${channelName(channel)}`}>
          <Field label={t("common.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={100} required />
          </Field>
          {!isVoice && (
            <Field label={t("channel.topic")}>
              <Input value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!canManage} maxLength={1024} />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("channel.category")}>
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!canManage}>
                <option value="">{t("common.none")}</option>
                {room.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryName(c)}
                  </option>
                ))}
              </Select>
            </Field>
            {!isVoice && !isFiles && (
              <Field label={t("channels.slowmode")} hint={t("channels.slowmode_hint")}>
                <Input type="number" min={0} max={21600} value={slowmode} onChange={(e) => setSlowmode(Number(e.target.value))} disabled={!canManage} />
              </Field>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={sync} onChange={(e) => setSync(e.target.checked)} disabled={!canManage || !categoryId} /> {t("channels.sync")}
          </label>
          {!isVoice && !isFiles && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} disabled={!canManage} data-testid="encrypted-toggle" />
              <span>
                {t("channels.encrypted")}
                <span className="block text-xs text-fg-2">{t("channels.encrypted_hint")}</span>
              </span>
            </label>
          )}
          {canManage && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                {t("channels.delete")}
              </Button>
              <Button type="submit">{t("common.save")}</Button>
            </div>
          )}
        </Section>
      </form>
      {isVoice && <VoiceQualitySection channel={channel} room={room} canManage={canManage} onChanged={onChanged} />}
      {isFiles && <StorageSection room={room} channel={channel} />}
      <NoBotsToggles channel={channel} room={room} onChanged={onChanged} />
      <ChannelBotsAllowed channel={channel} room={room} onChanged={onChanged} />
      {channel.encrypted && !isVoice && channel.kind !== "system" && <HistoryPolicySection channel={channel} room={room} canManage={canManage} onChanged={onChanged} />}
      {["text", "announcement", "forum"].includes(channel.kind) && <ThreadSettingsSection channel={channel} room={room} canManage={canManage} onChanged={onChanged} />}
      {canManageRoles && <OverridesEditor channel={channel} room={room} onChanged={onChanged} />}
      <ConfirmDialog open={confirmDelete} title={t("channels.delete")} text={t("channels.delete_text", { name: channel.name })} confirmWord={channel.name} actionLabel={t("room.delete_action")} onClose={() => setConfirmDelete(false)} onConfirm={async () => { await api.channels.delete(room.id, channel.id); setConfirmDelete(false); await onChanged(); }} />
      <ConfirmDialog open={confirmEncryption} title={t("channels.encryption_off_title")} text={t("channels.encryption_off_text")} actionLabel={t("channels.encryption_off_action")} onClose={() => setConfirmEncryption(false)} onConfirm={async () => { setConfirmEncryption(false); await save(); }} />
    </div>
  );
}

/**
 * "No bots" for this channel and its category (APPLICATIONS.md §3.5): needs `manage_room` and
 * `manage_channels`. Applied at once; bots lose the channel and their encryption leaves are removed.
 */
function NoBotsToggles({ channel, room, onChanged }: { channel: Channel; room: RoomDetail; onChanged: () => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const perms = parsePermissions(room.my_permissions);
  const allowed = hasPermission(perms, Permission.MANAGE_ROOM) && hasPermission(perms, Permission.MANAGE_CHANNELS);
  const category = room.categories.find((c) => c.id === channel.category_id);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("apps.no_bots.channel_title")} description={room.no_bots ? t("apps.no_bots.room_wide") : t("apps.no_bots.channel_hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={channel.no_bots} disabled={!allowed || busy} onChange={(e) => void run(() => api.channels.update(room.id, channel.id, { no_bots: e.target.checked }))} data-testid="channel-no-bots" />
        {t("apps.no_bots.channel_toggle")}
      </label>
      {category && (
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={category.no_bots} disabled={!allowed || busy} onChange={(e) => void run(() => api.channels.updateCategory(room.id, category.id, { no_bots: e.target.checked }))} data-testid="category-no-bots" />
          {t("apps.no_bots.category_toggle", { name: categoryName(category) })}
        </label>
      )}
    </Section>
  );
}

function OverridesEditor({ channel, room, onChanged }: { channel: Channel; room: RoomDetail; onChanged: () => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  const overrides = room.overrides.filter((o) => o.target_type === "channel" && o.target_id === channel.id);
  const subjects = room.roles.map((r) => ({ type: "role" as const, id: r.id, name: r.name }));
  const [subject, setSubject] = useState(`role:${room.roles.find((r) => r.is_everyone)?.id ?? ""}`);
  const [subjectType, subjectId] = subject.split(":") as ["role" | "member", string];
  const current = overrides.find((o) => o.subject_type === subjectType && o.subject_id === subjectId);
  const [allow, setAllow] = useState(parsePermissions(current?.allow));
  const [deny, setDeny] = useState(parsePermissions(current?.deny));
  const pick = (value: string) => {
    setSubject(value);
    const [ty, id] = value.split(":");
    const o = overrides.find((x) => x.subject_type === ty && x.subject_id === id);
    setAllow(parsePermissions(o?.allow));
    setDeny(parsePermissions(o?.deny));
  };
  const save = async () => {
    try {
      await api.channels.setOverride(room.id, { target_type: "channel", target_id: channel.id, subject_type: subjectType, subject_id: subjectId, allow: allow.toString(), deny: deny.toString() });
      await onChanged();
      useToasts.getState().push({ kind: "info", title: t("channels.overrides_saved") });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Section title={t("channels.overrides")} description={t("channels.overrides_hint")}>
      <Field label={t("channels.override_target")}>
        <Select value={subject} onChange={(e) => pick(e.target.value)} aria-label={t("channels.override_target")}>
          {subjects.map((s) => (
            <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      {subjectType === "role" && subjectId === room.roles.find((r) => r.is_everyone)?.id && <p className="text-xs text-fg-2">{t("members.everyone_restricted")}</p>}
      <OverrideTriState allow={allow} deny={deny} onChange={(a, d) => { setAllow(a); setDeny(d); }} restricted={subjectType === "role" && subjectId === room.roles.find((r) => r.is_everyone)?.id ? EVERYONE_RESTRICTED : 0n} />
      <div className="flex justify-end">
        <Button onClick={() => void save()}>{t("channels.save_overrides")}</Button>
      </div>
    </Section>
  );
}
