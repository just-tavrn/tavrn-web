// SPDX-License-Identifier: Apache-2.0
/**
 * The context menu of a room in the rail and of the room header in the sidebar (design note 4.11): invite,
 * settings, mark as read, notification settings, leave. The room detail (channels, permissions) is loaded when the menu opens.
 */
import { usePreviewedRoom } from "../../stores/rolePreview";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Permission, hasPermission, parsePermissions, type Room } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { roomMenu } from "../../lib/menus";
import { apiFor } from "../../stores/nodes";
import { isUnread, markConversationRead, useUnread } from "../../stores/unread";
import { toastError, useToasts } from "../../stores/toasts";
import { indexLeftRoom } from "../../stores/conversationIndex";
import { ContextMenu, normalizeMenu, separator, useContextMenu, type ContextMenuTrigger, type MenuEntry } from "../ContextMenu";
import { NodeScope, roomPath } from "../NodeScope";
import { useShell } from "../AppShell";
import { InviteDialog } from "../../pages/ChannelSidebar";
import { ConfirmAction, copyWithToast } from "./common";
import { useNotifyMenu } from "./useNotifyMenu";
import { useCapabilities } from "../../moderation/hooks";
import { ReportDialog } from "../../moderation/ReportDialog";
import { useAuth } from "../../stores/auth";
import { RoomDocumentDialog, RoomRulesDialog } from "../RoomDocuments";
import { hasRules } from "../JoinRoomDialog";

/**
 * `node` = domain of the room's node, null for the home node. `openReports`: the moderators' open reports (badge
 * text) from the room header; "Room settings" then shows the count and opens the report inbox. `extra`: entries of
 * the place the room is shown in (the rail's folder entries), before "Leave". `header`: non-interactive entries at the
 * head (the rail's room card on touch devices).
 */
export function useRoomMenu(room: Pick<Room, "id" | "name">, node: string | null, { openReports = null, extra, header }: { openReports?: string | null; extra?: MenuEntry[]; header?: MenuEntry[] } = {}): { menu: ContextMenuTrigger; overlay: ReactNode } {
  const t = useT();
  const menu = useContextMenu();
  const client = apiFor(node);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { closeNav } = useShell();
  const [dialog, setDialog] = useState<"invite" | "leave" | "report" | "rules" | "privacy" | "legal" | null>(null);
  const canReport = !!useCapabilities(node)?.includes("reports.v1");
  const homeDomain = useAuth((s) => s.user?.domain ?? "");
  // The same cache entry as the sidebar's `useRoom`; fetched when the menu opens.
  const detail = useQuery({
    queryKey: ["room", room.id],
    queryFn: async () => {
      const r = await client.rooms.get(room.id);
      useUnread.getState().seed(r.read_states ?? [], node);
      return r;
    },
    enabled: menu.open,
    staleTime: 30_000,
  });
  // A role preview: the menu of the simulated member (lib/previewRoom.ts).
  const data = usePreviewedRoom(detail.data);
  const channelIds = (data?.channels ?? []).filter((c) => c.kind !== "voice").map((c) => c.id);
  const unread = useUnread((s) => channelIds.some((id) => isUnread(s.states, id)));
  const notify = useNotifyMenu("room", room.id, null);
  const perms = parsePermissions(data?.my_permissions);

  const entries = menu.open
    ? withExtra(
        roomMenu(
          {
            unread,
            canInvite: hasPermission(perms, Permission.CREATE_INVITES),
            isOwner: !!data?.is_owner,
            notify: notify.state,
            canReport,
            openReports,
            rules: !!data && hasRules(data),
            privacyNotice: !!data?.privacy_notice_updated_at,
            legalNotice: !!data?.legal_notice_updated_at,
          },
          {
            ...notify.actions,
            markRead: () =>
              void Promise.all(channelIds.map((id) => markConversationRead(client, id, node)))
                .then(() => useToasts.getState().push({ kind: "info", title: t("menu.marked_read") }))
                .catch(toastError),
            invite: () => setDialog("invite"),
            settings: () => {
              closeNav();
              navigate(roomPath(node, room.id, undefined, openReports ? "settings/reports" : "settings"));
            },
            leave: () => setDialog("leave"),
            copyId: () => void copyWithToast(room.id, t("menu.copied")),
            report: () => setDialog("report"),
            rules: () => setDialog("rules"),
            privacyNotice: () => setDialog("privacy"),
            legalNotice: () => setDialog("legal"),
          },
          t,
        ),
        extra,
        header,
      )
    : [];

  const overlay = (
    <>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label={t("menu.label", { name: room.name })} testId="room-menu" />}
      {dialog === "invite" &&
        (node ? (
          <NodeScope domain={node} quiet>
            <InviteDialog roomId={room.id} open onClose={() => setDialog(null)} />
          </NodeScope>
        ) : (
          <InviteDialog roomId={room.id} open onClose={() => setDialog(null)} />
        ))}
      {dialog === "rules" && <RoomRulesDialog client={client} roomId={room.id} roomName={room.name} onClose={() => setDialog(null)} />}
      {(dialog === "privacy" || dialog === "legal") && <RoomDocumentDialog client={client} roomId={room.id} roomName={room.name} kind={dialog} onClose={() => setDialog(null)} />}
      {dialog === "report" && <ReportDialog subject={{ kind: "room", roomId: room.id, name: room.name }} client={client} node={node ?? homeDomain} onClose={() => setDialog(null)} />}
      {dialog === "leave" && (
        <ConfirmAction
          title={t("room.leave")}
          text={t("room.leave_text")}
          action={t("room.leave_action")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await client.rooms.leave(room.id);
            void indexLeftRoom(node, room.id);
            await queryClient.invalidateQueries({ queryKey: ["rooms"] });
            navigate("/");
          }}
          testId="leave-dialog"
        />
      )}
    </>
  );
  return { menu, overlay };
}

/** Inserts `extra` before the "Leave" group and puts `header` (the room card on touch) first. */
function withExtra(base: MenuEntry[], extra?: MenuEntry[], header?: MenuEntry[]): MenuEntry[] {
  const head = header ?? [];
  if (!extra?.length) return head.length ? [...head, ...base] : base;
  const at = base.findIndex((e) => e.id === "sep-leave");
  const i = at >= 0 ? at : base.length;
  return [...head, ...normalizeMenu([...base.slice(0, i), separator("sep-place"), ...extra, ...base.slice(i)])];
}
