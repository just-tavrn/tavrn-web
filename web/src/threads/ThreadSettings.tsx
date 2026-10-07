// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { Channel, RoomDetail, TagInput } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { Button, Input } from "../components/ui";
import { Section, Select } from "../pages/settings/common";
import { toastError, useToasts } from "../stores/toasts";

/** Auto-archive choices in minutes (the node takes 60 … 43200). */
export const AUTO_ARCHIVE_CHOICES = [60, 1440, 4320, 10080, 43200] as const;
export const MAX_TAGS = 20;

/**
 * Thread settings of a text, announcement or forum channel (PROTOCOL.md §7e, `manage_channels`): when idle threads
 * are archived, and the tags of a forum.
 */
export function ThreadSettingsSection({ channel, room, canManage, onChanged }: { channel: Channel; room: RoomDetail; canManage: boolean; onChanged: () => Promise<void> }) {
  const t = useT();
  const { api } = useNode();
  const [minutes, setMinutes] = useState(channel.auto_archive_minutes ?? 10080);
  const [tags, setTags] = useState<TagInput[]>(() => (channel.tags ?? []).map((tg) => ({ id: tg.id, name: tg.name, emoji: tg.emoji ?? null })));
  const [busy, setBusy] = useState(false);
  const forum = channel.kind === "forum";
  const choices = AUTO_ARCHIVE_CHOICES.includes(minutes as (typeof AUTO_ARCHIVE_CHOICES)[number]) ? [...AUTO_ARCHIVE_CHOICES] : [...AUTO_ARCHIVE_CHOICES, minutes].sort((a, b) => a - b);
  const save = async () => {
    setBusy(true);
    try {
      await api.channels.update(room.id, channel.id, { auto_archive_minutes: minutes, ...(forum ? { tags: tags.map((tg) => ({ ...tg, name: tg.name.trim(), emoji: tg.emoji?.trim() || null })) } : {}) });
      await onChanged();
      useToasts.getState().push({ kind: "info", title: t("channels.saved") });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const label = (m: number) => (m % 1440 === 0 ? t("threads.archive_days", { count: m / 1440 }) : t("threads.archive_hours", { count: Math.round(m / 60) }));
  return (
    <Section title={t("threads.settings_title")} description={forum ? t("threads.settings_forum_hint") : t("threads.settings_hint")}>
      <div className="space-y-3" data-testid="thread-settings">
        <label className="block space-y-1 text-sm">
          <span className="block text-fg-1">{t("threads.auto_archive")}</span>
          <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={!canManage || busy} data-testid="auto-archive">
            {choices.map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </Select>
        </label>
        {forum && (
          <fieldset className="space-y-2">
            <legend className="text-sm text-fg-1">{t("forum.tags")}</legend>
            {tags.map((tg, i) => (
              <div key={tg.id ?? `new-${i}`} className="flex items-center gap-2" data-testid="forum-tag-row">
                <Input value={tg.emoji ?? ""} onChange={(e) => setTags((cur) => cur.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)))} placeholder="🏷" aria-label={t("forum.tag_emoji")} className="!w-16" maxLength={64} disabled={!canManage} />
                <Input value={tg.name} onChange={(e) => setTags((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={t("forum.tag_name")} maxLength={32} disabled={!canManage} data-testid="forum-tag-name" />
                {canManage && (
                  <button type="button" onClick={() => setTags((cur) => cur.filter((_, j) => j !== i))} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:text-danger" aria-label={t("forum.tag_remove", { name: tg.name })}>
                    ×
                  </button>
                )}
              </div>
            ))}
            {canManage && tags.length < MAX_TAGS && (
              <Button variant="ghost" onClick={() => setTags((cur) => [...cur, { name: "", emoji: null }])} data-testid="forum-tag-add">
                {t("forum.tag_add")}
              </Button>
            )}
          </fieldset>
        )}
        {canManage && (
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={busy || (forum && tags.some((tg) => !tg.name.trim()))} data-testid="thread-settings-save">
              {t("threads.settings_save")}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
