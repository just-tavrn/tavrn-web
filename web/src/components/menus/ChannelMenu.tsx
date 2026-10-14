// SPDX-License-Identifier: Apache-2.0
/**
 * The context menu of a channel in the sidebar (design note 4.11): mark as read, notification settings and
 * mute, edit/duplicate/delete with `manage_channels`, copy link and id. Voice channels get the same menu
 * plus, with `move_members`, "Move everyone here (N)" and "Move everyone from here to …" (both after a
 * confirmation, through the node's mass move).
 */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { useLocation, useNavigate } from "react-router";
import { Permission, hasPermission, parsePermissions, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { channelMenu } from "../../lib/menus";
import { channelName } from "../../lib/names";
import { isUnread, markConversationRead, useUnread } from "../../stores/unread";
import { toastError, useToasts } from "../../stores/toasts";
import { participantsOf, useVoicePresence } from "../../voice/presence";
import { MoveAllConfirm, type PendingMoveAll } from "../../voice/ui/VoiceChannelMenu";
import { channelPermissions } from "../../pages/ChannelPage";
import { ContextMenu, useContextMenu, type ContextMenuTrigger } from "../ContextMenu";
import { useNode } from "../NodeScope";
import { useShell } from "../AppShell";
import { ConfirmAction, copyWithToast } from "./common";
import { useNotifyMenu } from "./useNotifyMenu";
import { useFullHistory } from "../../search/useFullHistory";
import { webOrigin } from "../../platform";
import { patchRoom, withChannel, withoutChannel } from "../../lib/roomCache";

export function useChannelMenu(room: RoomDetail, channel: Channel): { menu: ContextMenuTrigger; overlay: ReactNode } {
  const t = useT();
  const menu = useContextMenu();
  const { api, domain, me, roomPath } = useNode();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { closeNav } = useShell();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const unread = useUnread((s) => isUnread(s.states, channel.id));
  const notify = useNotifyMenu("channel", room.id, channel.id);
  const roomPerms = parsePermissions(room.my_permissions);
  const canManage = hasPermission(roomPerms, Permission.MANAGE_CHANNELS);
  const [pendingMove, setPendingMove] = useState<PendingMoveAll | null>(null);
  // Voice: people per voice channel of the room (for the mass moves).
  const voice = channel.kind === "voice";
  const voiceChannels = voice ? room.channels.filter((c) => c.kind === "voice") : [];
  const counts = useVoicePresence(useShallow((s) => Object.fromEntries(voiceChannels.map((c) => [c.id, participantsOf(s, domain, c.id).length]))));
  const canMove = voice && hasPermission(channelPermissions(room, channel.id, me?.id ?? ""), Permission.MOVE_MEMBERS);
  const others = voiceChannels.filter((c) => c.id !== channel.id);
  const here = counts[channel.id] ?? 0;
  const elsewhere = others.reduce((n, c) => n + (counts[c.id] ?? 0), 0);
  const name = channelName(channel);
  const fullHistory = useFullHistory(domain, channel.id, channel.encrypted && !["voice", "files", "system"].includes(channel.kind));

  const entries = menu.open
    ? channelMenu(
        {
          kind: channel.kind,
          unread,
          canManage,
          system: channel.kind === "system",
          voiceMove: canMove ? { elsewhere, here, targets: others.map((c) => ({ id: c.id, name: channelName(c) })) } : undefined,
          notify: notify.state,
          fullHistory: fullHistory.value,
          fullHistoryUsage: fullHistory.usage,
        },
        {
          ...notify.actions,
          toggleFullHistory: fullHistory.toggle,
          markRead: () => void markConversationRead(api, channel.id).catch(toastError),
          edit: () => {
            closeNav();
            navigate(roomPath(room.id, undefined, `settings/channels?channel=${encodeURIComponent(channel.id)}`));
          },
          duplicate: () =>
            void api.channels
              .create(room.id, { kind: channel.kind, name: `${channel.name}-2`, category_id: channel.category_id ?? null, topic: channel.topic || null, encrypted: channel.kind === "voice" ? null : channel.encrypted, user_limit: channel.user_limit || null, bitrate_kbps: channel.bitrate_kbps || null })
              .then((created) => patchRoom(queryClient, room.id, withChannel(created)))
              .then(() => useToasts.getState().push({ kind: "info", title: t("menu.channel.duplicated", { name }) }))
              .catch(toastError),
          remove: () => setConfirmDelete(true),
          copyLink: () => void copyWithToast(`${webOrigin()}${roomPath(room.id, channel.id)}`, t("menu.copied")),
          copyId: () => void copyWithToast(channel.id, t("menu.copied")),
          moveEveryoneHere: () => setPendingMove({ to: channel, count: elsewhere }),
          moveEveryoneTo: (id) => {
            const to = others.find((c) => c.id === id);
            if (to) setPendingMove({ from: channel, to, count: here });
          },
        },
        t,
      )
    : [];

  const overlay = (
    <>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label={t("menu.label", { name })} testId="channel-menu" />}
      {pendingMove && <MoveAllConfirm roomId={room.id} pending={pendingMove} onClose={() => setPendingMove(null)} />}
      {confirmDelete && (
        <ConfirmAction
          title={t("menu.channel.delete")}
          text={t("channels.delete_text", { name: channel.name })}
          action={t("common.delete")}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.channels.delete(room.id, channel.id);
            patchRoom(queryClient, room.id, withoutChannel(channel.id));
            if (location.pathname.includes(channel.id)) navigate(roomPath(room.id));
          }}
          testId="channel-delete-dialog"
        />
      )}
    </>
  );
  return { menu, overlay };
}
