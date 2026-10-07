// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserSound } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { useT } from "../../i18n";
import { homeDomain } from "../../stores/nodes";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { SoundEmojiField } from "../../components/SoundEmojiField";
import { voiceErrorMessage } from "../../voice/errors";
import { Section } from "./common";

export function usePersonalSounds(enabled = true) {
  return useQuery({ queryKey: ["sounds", "personal"], queryFn: () => api.soundboard.personal.list(), enabled, staleTime: 60_000 });
}

function SoundRow({ sound, onChanged }: { sound: UserSound; onChanged: () => Promise<unknown> }) {
  const t = useT();
  const [name, setName] = useState(sound.name);
  const [emoji, setEmoji] = useState(sound.emoji ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== sound.name || emoji !== (sound.emoji ?? "");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.soundboard.personal.update(sound.id, { name: name.trim(), emoji: emoji || null });
      await onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-h-12 flex-wrap items-center gap-2 py-1 text-sm" data-testid="personal-sound" data-name={sound.name}>
      <Button variant="ghost" aria-label={t("soundboard.preview", { name: sound.name })} onClick={() =>
          void fetch(api.soundboard.audioUrl(sound.id))
            .then((r) => r.blob())
            .then((b) => {
              // A blob URL: media-src allows only 'self' and blob:.
              const url = URL.createObjectURL(b);
              const audio = new Audio(url);
              audio.onended = () => URL.revokeObjectURL(url);
              return audio.play();
            })
            .catch(toastError)
        }>
        ▶
      </Button>
      <form onSubmit={save} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required aria-label={t("soundboard.rename_label", { name: sound.name })} className="max-w-40" />
        <SoundEmojiField value={emoji} onChange={setEmoji} node={homeDomain() ?? ""} label={t("soundboard.emoji_label", { name: sound.name })} />
        {dirty && (
          <Button type="submit" variant="ghost" disabled={busy} data-testid="sound-save">
            {t("common.save")}
          </Button>
        )}
      </form>
      <span className="text-xs tabular-nums text-fg-2">{(sound.duration_ms / 1000).toFixed(1)} s</span>
      <button
        type="button"
        aria-label={t("soundboard.delete", { name: sound.name })}
        className="min-h-8 min-w-8 text-fg-2 hover:text-danger"
        onClick={async () => {
          try {
            await api.soundboard.personal.delete(sound.id);
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
 * Personal soundboard clips (design note 4.13) on the home node: playable in voice channels that grant
 * `use_external_sounds`. Upload (trimmed to 5 s like room clips) with an optional emoji, rename, emoji, delete.
 */
export function PersonalSoundsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const list = usePersonalSounds();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sounds", "personal"] });
  const items = list.data?.items ?? [];
  const max = list.data?.max_personal ?? 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { prepareClip } = await import("../../voice/clip");
      const clip = await prepareClip(file);
      await api.soundboard.personal.create(name.trim(), clip.blob, clip.durationMs, emoji || undefined);
      setName("");
      setEmoji("");
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
      useToasts.getState().push({ kind: "info", title: clip.trimmed ? t("soundboard.added_trimmed") : t("soundboard.added") });
    } catch (err) {
      useToasts.getState().push({ kind: "warning", title: err instanceof DOMException ? t("soundboard.decode_failed") : voiceErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("personal_sounds.title")} description={t("personal_sounds.hint")}>
      <p className="text-xs text-fg-1" data-testid="personal-sound-limit">
        {max > 0 ? t("personal.limit", { count: items.length, max }) : t("personal.count", { count: items.length })}
      </p>
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-2 sm:items-end" data-testid="personal-sound-upload">
        <Field label={t("soundboard.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required name="sound_name" />
        </Field>
        <Field label={t("soundboard.file")}>
          <input ref={fileInput} type="file" accept="audio/*" required className="block w-full text-sm text-fg-1 file:mr-2 file:rounded-md file:border-0 file:bg-bg-3 file:px-3 file:py-2 file:text-fg-0" aria-label={t("soundboard.file")} />
        </Field>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg-1">{t("soundboard.emoji")}</span>
          <SoundEmojiField value={emoji} onChange={setEmoji} node={homeDomain() ?? ""} label={t("soundboard.emoji")} />
        </div>
        <Button type="submit" disabled={busy || !name.trim() || (!!list.data && max > 0 && items.length >= max)}>
          {t("soundboard.add")}
        </Button>
      </form>
      <ul className="divide-y divide-line" data-testid="personal-sound-list">
        {items.map((s) => (
          <SoundRow key={`${s.id}:${s.name}:${s.emoji ?? ""}`} sound={s} onChanged={refresh} />
        ))}
        {list.data && items.length === 0 && <li className="py-2 text-sm text-fg-2">{t("soundboard.none")}</li>}
      </ul>
    </Section>
  );
}
