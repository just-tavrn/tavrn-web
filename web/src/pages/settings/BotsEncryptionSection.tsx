// SPDX-License-Identifier: Apache-2.0
/**
 * Bots and encrypted channels (design note 4.7, APPLICATIONS.md §3.5): the room switch `bots_in_encrypted_channels` in the
 * overview and the per-channel "Bots allowed" toggle of encrypted channels in `per_channel` rooms. Both need
 * `manage_room` (the channel toggle also `manage_channels`), like the "no bots" flags.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError } from "../../stores/toasts";
import { Section } from "./common";
import { explicitNoBots } from "../../lib/botAccess";

/** The room switch: "keep bots out of encrypted channels unless a channel allows them" (`per_channel`). */
export function BotsInEncryptedSection({ room, canManage }: { room: RoomDetail; canManage: boolean }) {
  const { api } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const perChannel = room.bots_in_encrypted_channels !== "allowed";
  const apply = async (next: boolean) => {
    setBusy(true);
    try {
      await api.rooms.update(room.id, { bots_in_encrypted_channels: next ? "per_channel" : "allowed" });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("apps.bots_encrypted.title")} description={t("apps.bots_encrypted.hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={perChannel} disabled={!canManage || busy || room.no_bots} onChange={(e) => void apply(e.target.checked)} data-testid="room-bots-encrypted" />
        {t("apps.bots_encrypted.toggle")}
      </label>
      <p className="text-xs text-fg-2" data-testid="room-bots-encrypted-state">
        {room.no_bots ? t("apps.no_bots.room_wide") : perChannel ? t("apps.bots_encrypted.per_channel") : t("apps.bots_encrypted.allowed")}
      </p>
    </Section>
  );
}

/** "Bots allowed" for an encrypted channel of a `per_channel` room; hidden everywhere else. */
export function ChannelBotsAllowed({ channel, room, onChanged }: { channel: Channel; room: RoomDetail; onChanged: () => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!channel.encrypted || channel.kind === "system" || room.bots_in_encrypted_channels !== "per_channel") return null;
  const perms = parsePermissions(room.my_permissions);
  const allowed = hasPermission(perms, Permission.MANAGE_ROOM) && hasPermission(perms, Permission.MANAGE_CHANNELS);
  const blocked = explicitNoBots(channel, room);
  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await api.channels.update(room.id, channel.id, { bots_allowed: next });
      await onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("apps.bots_allowed.title")} description={t("apps.bots_allowed.hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={!!channel.bots_allowed} disabled={!allowed || busy} onChange={(e) => void toggle(e.target.checked)} data-testid="channel-bots-allowed" />
        {t("apps.bots_allowed.toggle")}
      </label>
      {blocked && <p className="text-xs text-warn">{t("apps.bots_allowed.no_bots_wins")}</p>}
    </Section>
  );
}
