// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { useEmojiImage, useRoomEmojis } from "../../lib/emojis";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { Section } from "./common";

function EmojiRow({ roomId, emoji, canManage, onDelete }: { roomId: string; emoji: { id: string; name: string; size: number; animated?: boolean }; canManage: boolean; onDelete: () => void }) {
  const t = useT();
  const [hover, setHover] = useState(false);
  const url = useEmojiImage(roomId, emoji.id, !!emoji.animated && !hover);
  return (
    <li className="flex min-h-10 items-center gap-3 text-sm">
      {url ? <img src={url} alt={emoji.name} className="h-8 w-8 object-contain" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} /> : <span className="h-8 w-8 rounded bg-bg-3" />}
      <code className="flex-1">:{emoji.name}:</code>
      <span className="text-xs text-fg-2">
        {emoji.animated ? `${t("emojis.animated")} · ` : ""}
        {Math.ceil(emoji.size / 1024)} KB
      </span>
      {canManage && (
        <button type="button" aria-label={t("emojis.delete", { name: emoji.name })} onClick={onDelete} className="min-h-8 min-w-8 text-fg-2 hover:text-danger">
          ×
        </button>
      )}
    </li>
  );
}

export function EmojisTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  const emojis = useRoomEmojis(room.id);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_EMOJIS);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["emojis", room.id] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await api.emojis.create(room.id, name.trim().toLowerCase(), file);
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
    <Section title={t("emojis.title")} description={t("emojis.hint")}>
      {canManage && (
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={t("emojis.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z0-9_]{2,32}" required />
          </Field>
          <Field label={t("emojis.file")}>
            <input ref={fileInput} type="file" accept="image/png,image/gif,image/webp,image/jpeg" required className="block w-full text-sm text-fg-1 file:mr-2 file:rounded-md file:border-0 file:bg-bg-3 file:px-3 file:py-2 file:text-fg-0" aria-label={t("emojis.file")} />
          </Field>
          <Button type="submit" disabled={busy}>
            {t("emojis.add")}
          </Button>
        </form>
      )}
      <ul className="divide-y divide-line" data-testid="emoji-list">
        {emojis.data?.map((e) => (
          <EmojiRow key={e.id} roomId={room.id} emoji={e} canManage={canManage} onDelete={async () => { try { await api.emojis.delete(room.id, e.id); await refresh(); } catch (err) { toastError(err); } }} />
        ))}
        {emojis.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("emojis.none")}</li>}
      </ul>
    </Section>
  );
}
