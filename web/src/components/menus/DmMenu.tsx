// SPDX-License-Identifier: Apache-2.0
/**
 * The context menu of a DM or group DM in the home sidebar (design note 4.11): mark as read, profile and
 * address of the other person, notification settings and mute, close (hidden until a new message
 * arrives), block.
 */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { create } from "zustand";
import type { Conversation } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { api as homeApi } from "../../lib/api";
import { dmMenu } from "../../lib/menus";
import { apiFor, isHome } from "../../stores/nodes";
import { onAccountChange } from "../../stores/auth";
import { isUnread, markConversationRead, useUnread } from "../../stores/unread";
import { toastError, useToasts } from "../../stores/toasts";
import { ContextMenu, useContextMenu, type ContextMenuTrigger } from "../ContextMenu";
import { ProfileCard } from "../ProfilePopover";
import type { AnchorRect } from "../../lib/position";
import { ConfirmAction, copyWithToast } from "./common";
import { useNotifyMenu } from "./useNotifyMenu";
import { useFullHistory } from "../../search/useFullHistory";

const CLOSED_KEY = "tavrn.closed-dms";

function readClosed(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Closed DMs (per browser): conversation id → the newest message id when it was closed. A DM stays hidden
 * until a newer message arrives.
 */
export const useClosedDms = create<{ closed: Record<string, string>; close: (id: string, last: string | null) => void; reopen: (id: string) => void }>((set, get) => ({
  closed: readClosed(),
  close: (id, last) => {
    const closed = { ...get().closed, [id]: last ?? "" };
    set({ closed });
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify(closed));
    } catch {
      /* memory only */
    }
  },
  reopen: (id) => {
    const { [id]: _gone, ...closed } = get().closed;
    set({ closed });
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify(closed));
    } catch {
      /* memory only */
    }
  },
}));
// Closed DMs belong to the signed-in account: forget them when it signs out (the stored copy is removed by useAuth).
onAccountChange(() => useClosedDms.setState({ closed: {} }));


/** Is the DM hidden (closed, nothing newer since)? */
export function isClosed(closed: Record<string, string>, c: Pick<Conversation, "id" | "last_message_id">, newest: string | null = null): boolean {
  if (!(c.id in closed)) return false;
  const last = [c.last_message_id ?? "", newest ?? ""].sort().at(-1)!;
  return last <= closed[c.id]!;
}

export function useDmMenu(c: Conversation & { node: string }, meAddress: string | undefined): { menu: ContextMenuTrigger; overlay: ReactNode } {
  const t = useT();
  const menu = useContextMenu();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [dialog, setDialog] = useState<"block" | null>(null);
  const [profile, setProfile] = useState<AnchorRect | null>(null);
  const unread = useUnread((s) => isUnread(s.states, c.id));
  const notify = useNotifyMenu("channel", null, c.id);
  const peerUser = c.kind === "dm" ? c.members.find((m) => m.address !== meAddress) : undefined;
  const peer = peerUser ? { address: peerUser.address, name: peerUser.display_name } : null;
  const node = isHome(c.node) ? null : c.node;
  const fullHistory = useFullHistory(c.node, c.id, c.encrypted);

  const entries = menu.open
    ? dmMenu(
        { unread, kind: c.kind === "group" ? "group" : "dm", peer, notify: notify.state, fullHistory: fullHistory.value, fullHistoryUsage: fullHistory.usage },
        {
          ...notify.actions,
          toggleFullHistory: fullHistory.toggle,
          markRead: () => void markConversationRead(apiFor(node), c.id, node).catch(toastError),
          profile: () => setProfile(menu.anchor),
          copyAddress: () => peer && void copyWithToast(peer.address, t("menu.copied")),
          close: () => {
            const last = useUnread.getState().states[c.id]?.last ?? c.last_message_id ?? null;
            useClosedDms.getState().close(c.id, last);
            if (location.pathname.includes(c.id)) navigate("/");
          },
          block: () => setDialog("block"),
        },
        t,
      )
    : [];

  const overlay = (
    <>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label={t("menu.label", { name: peer?.name ?? c.name ?? "" })} testId="dm-menu" />}
      {profile && peer && <ProfileCard address={peer.address} node={node} anchor={profile} onClose={() => setProfile(null)} />}
      {dialog === "block" && peer && (
        <ConfirmAction
          title={t("menu.member.block_title", { name: peer.name })}
          text={t("menu.member.block_text", { address: peer.address })}
          action={t("menu.member.block")}
          reasonLabel={t("menu.member.block_reason")}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await homeApi.blocks.block(peer.address, reason || null);
            useToasts.getState().push({ kind: "info", title: t("menu.member.blocked") });
            await queryClient.invalidateQueries({ queryKey: ["blocks"] });
          }}
          testId="block-dialog"
        />
      )}
    </>
  );
  return { menu, overlay };
}
