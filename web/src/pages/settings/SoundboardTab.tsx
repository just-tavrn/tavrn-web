// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { Button, Field, Input } from "../../components/ui";
import { toastError, useToasts } from "../../stores/toasts";
import { useSoundboard } from "../../voice/useVoiceRealtime";
import { voiceErrorMessage } from "../../voice/errors";
import { Section } from "./common";
import { useQueryClient } from "@tanstack/react-query";
import type { Sound } from "@tavrn/sdk";
import { SoundEmojiField } from "../../components/SoundEmojiField";
import { InlineEmoji } from "../../components/InlineEmoji";

/** Plays a clip locally (preview) without a call. */
async function preview(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

/**
 * Soundboard clips of the room (VOICE.md §8), `manage_emojis`: upload (at most 5 s, 1 MiB, 50 per room;
 * longer clips are trimmed to their first five seconds) and delete. Clips are played in calls from the
 * soundboard panel of the voice controls.
 */
export function SoundboardTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, domain } = useNode();
  const queryClient = useQueryClient();
  const sounds = useSoundboard(room.id);
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_EMOJIS);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["soundboard", domain, room.id] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { prepareClip } = await import("../../voice/clip");
      const clip = await prepareClip(file);
      await api.soundboard.create(room.id, name.trim(), clip.blob, clip.durationMs, emoji || undefined);
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
    <Section title={t("soundboard.title")} description={t("soundboard.hint")}>
      {canManage && (
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" data-testid="soundboard-upload">
          <Field label={t("soundboard.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required name="sound_name" />
          </Field>
          <Field label={t("soundboard.file")}>
            <input ref={fileInput} type="file" accept="audio/*" required className="block w-full text-sm text-fg-1 file:mr-2 file:rounded-md file:border-0 file:bg-bg-3 file:px-3 file:py-2 file:text-fg-0" aria-label={t("soundboard.file")} />
          </Field>
          <div className="flex items-center gap-2 text-sm sm:col-span-2">
            <span className="text-fg-1">{t("soundboard.emoji")}</span>
            <SoundEmojiField value={emoji} onChange={setEmoji} node={domain} label={t("soundboard.emoji")} />
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {t("soundboard.add")}
          </Button>
        </form>
      )}
      <ul className="divide-y divide-line" data-testid="soundboard-list">
        {sounds.data?.map((s) => (
          <li key={s.id} className="flex min-h-10 items-center gap-3 text-sm">
            <Button variant="ghost" aria-label={t("soundboard.preview", { name: s.name })} onClick={() => void api.soundboard.audio(room.id, s.id).then(preview).catch(toastError)}>
              ▶
            </Button>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {canManage ? <RoomSoundEmoji roomId={room.id} sound={s} node={domain} onSaved={refresh} /> : <InlineEmoji value={s.emoji} node={domain} />}
            <span className="text-xs tabular-nums text-fg-2">
              {(s.duration_ms / 1000).toFixed(1)} s · {Math.ceil(s.size / 1024)} KB
            </span>
            {canManage && (
              <button
                type="button"
                aria-label={t("soundboard.delete", { name: s.name })}
                className="min-h-8 min-w-8 text-fg-2 hover:text-danger"
                onClick={async () => {
                  try {
                    await api.soundboard.delete(room.id, s.id);
                    await refresh();
                  } catch (err) {
                    toastError(err);
                  }
                }}
              >
                ×
              </button>
            )}
          </li>
        ))}
        {sounds.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("soundboard.none")}</li>}
      </ul>
    </Section>
  );
}

/** The emoji of a room clip, editable with `manage_emojis` (design note 4.13). */
function RoomSoundEmoji({ roomId, sound, node, onSaved }: { roomId: string; sound: Sound; node: string; onSaved: () => Promise<unknown> }) {
  const t = useT();
  const { api } = useNode();
  const [value, setValue] = useState(sound.emoji ?? "");
  const dirty = value !== (sound.emoji ?? "");
  return (
    <span className="flex items-center gap-1" data-testid="room-sound-emoji">
      <SoundEmojiField value={value} onChange={setValue} node={node} label={t("soundboard.emoji_label", { name: sound.name })} />
      {dirty && (
        <Button
          variant="ghost"
          data-testid="sound-save"
          onClick={async () => {
            try {
              await api.soundboard.update(roomId, sound.id, { emoji: value || null });
              await onSaved();
            } catch (err) {
              toastError(err);
            }
          }}
        >
          {t("common.save")}
        </Button>
      )}
    </span>
  );
}
