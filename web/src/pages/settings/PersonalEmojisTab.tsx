// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UserEmoji } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { useT } from "../../i18n";
import { emojiImageUrl, usePersonalEmojis } from "../../lib/emojis";
import { homeDomain } from "../../stores/nodes";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { Section } from "./common";

const NAME = "[a-z0-9_]{2,32}";

function PersonalEmojiRow({ emoji, onChanged }: { emoji: UserEmoji; onChanged: () => Promise<unknown> }) {
  const t = useT();
  const [name, setName] = useState(emoji.name);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.emojis.personal.rename(emoji.id, name.trim().toLowerCase());
      await onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-h-12 flex-wrap items-center gap-3 py-1 text-sm" data-testid="personal-emoji" data-name={emoji.name}>
      <img src={emojiImageUrl(homeDomain(), emoji.id, emoji.animated && !hover)} alt={`:${emoji.name}:`} className="h-8 w-8 object-contain" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />
      <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} pattern={NAME} required aria-label={t("emojis.rename_label", { name: emoji.name })} className="max-w-48" />
        {name.trim().toLowerCase() !== emoji.name && (
          <Button type="submit" variant="ghost" disabled={busy}>
            {t("common.save")}
          </Button>
        )}
      </form>
      <span className="text-xs text-fg-2">
        {emoji.animated ? `${t("emojis.animated")} · ` : ""}
        {Math.ceil(emoji.size / 1024)} KB
      </span>
      <button
        type="button"
        aria-label={t("emojis.delete", { name: emoji.name })}
        className="min-h-8 min-w-8 text-fg-2 hover:text-danger"
        onClick={async () => {
          try {
            await api.emojis.personal.delete(emoji.id);
            await onChanged();
          } catch (err) {
            toastError(err);
          }
        }}
      >
        ×
      </button>
    </li>
  );
}

/**
 * Personal emojis (design note 4.13) on the home node: usable in DMs and in every room that grants
 * `use_external_emojis`. Upload (converted by the node like room emojis), rename, delete, the limit shown.
 */
export function PersonalEmojisTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const list = usePersonalEmojis();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["emojis", "personal"] });
  const items = list.data?.items ?? [];
  const max = list.data?.max_personal ?? 0;
  const full = !!list.data && max > 0 && items.length >= max;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await api.emojis.personal.create(name.trim().toLowerCase(), file);
      setName("");
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
      useToasts.getState().push({ kind: "info", title: t("emojis.added") });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("personal_emojis.title")} description={t("personal_emojis.hint")}>
      <p className="text-xs text-fg-1" data-testid="personal-emoji-limit">
        {max > 0 ? t("personal.limit", { count: items.length, max }) : t("personal.count", { count: items.length })}
      </p>
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" data-testid="personal-emoji-upload">
        <Field label={t("emojis.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} pattern={NAME} required name="emoji_name" />
        </Field>
        <Field label={t("emojis.file")}>
          <input ref={fileInput} type="file" accept="image/png,image/gif,image/webp,image/jpeg" required className="block w-full text-sm text-fg-1 file:mr-2 file:rounded-md file:border-0 file:bg-bg-3 file:px-3 file:py-2 file:text-fg-0" aria-label={t("emojis.file")} />
        </Field>
        <Button type="submit" disabled={busy || full}>
          {t("emojis.add")}
        </Button>
      </form>
      <ul className="divide-y divide-line" data-testid="personal-emoji-list">
        {items.map((e) => (
          <PersonalEmojiRow key={`${e.id}:${e.name}`} emoji={e} onChanged={refresh} />
        ))}
        {list.data && items.length === 0 && <li className="py-2 text-sm text-fg-2">{t("emojis.none")}</li>}
      </ul>
    </Section>
  );
}
