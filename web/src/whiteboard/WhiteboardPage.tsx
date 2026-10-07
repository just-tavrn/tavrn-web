// SPDX-License-Identifier: Apache-2.0
/**
 * Routes of a conversation's whiteboard, full screen: `/rooms/<room>/channels/<channel>/whiteboard`,
 * `/conversations/<id>/whiteboard` and their `/n/<domain>/…` variants for other nodes. Joins the
 * conversation's MLS group like the message view does (ephemeral content is encrypted with its content
 * key), then shows {@link WhiteboardSession}.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { Permission, hasPermission, type Conversation } from "@tavrn/sdk";
import { useT } from "../i18n";
import { api as homeApi } from "../lib/api";
import { useNode, conversationPath } from "../components/NodeScope";
import { useRoom } from "../pages/ChannelSidebar";
import { channelPermissions, useRoomMembers } from "../pages/ChannelPage";
import { conversationTitle } from "../pages/DirectMessages";
import { channelName } from "../lib/names";
import { mayManageRoom } from "../lib/rooms";
import { useAuth } from "../stores/auth";
import { describeError } from "../stores/toasts";
import { useE2eeConversation, type E2eeConversation } from "../hooks/useE2eeConversation";
import { qualify } from "@tavrn/e2ee";
import { LockedNotice } from "../components/E2eeNotices";
import { WhiteboardSession, type Member, type WhiteboardSessionProps } from "./WhiteboardSession";
import type { ShareTarget } from "./share";

export function WhiteboardPage() {
  const { roomId, channelId, conversationId } = useParams();
  if (roomId && channelId) return <ChannelBoard roomId={roomId} channelId={channelId} />;
  if (conversationId) return <ConversationBoard conversationId={conversationId} />;
  return null;
}

/** DMs and group DMs of the home node as share targets. */
function useDirectTargets(): ShareTarget[] {
  const me = useAuth((s) => s.user);
  const list = useQuery({ queryKey: ["conversations"], queryFn: () => homeApi.conversations.list(), staleTime: 30_000 });
  return useMemo(() => (list.data ?? []).map((c: Conversation) => ({ domain: me?.domain ?? "", conversationId: c.id, encrypted: true, label: `@ ${conversationTitle(c, me?.address)}` })), [list.data, me?.domain, me?.address]);
}

function notReadyText(t: (k: string) => string, e2ee: E2eeConversation, encrypted: boolean) {
  if (!encrypted) return null;
  if (e2ee.phase === "locked") return <LockedNotice />;
  if (e2ee.phase === "error") return <p className="text-sm text-danger">{e2ee.error}</p>;
  return <p className="text-sm text-fg-2">{t("whiteboard.joining_e2ee")}</p>;
}

/** The props of a room channel's board (shared by the full-screen route and the voice stage tile). */
export function useChannelBoard(roomId: string, channelId: string): { props: WhiteboardSessionProps | null; pending: boolean; error: unknown } {
  const t = useT();
  const { api, me, domain, home, roomPath } = useNode();
  const room = useRoom(roomId);
  const members = useRoomMembers(roomId);
  const direct = useDirectTargets();
  const channel = room.data?.channels.find((c) => c.id === channelId);
  const perms = room.data && channel ? channelPermissions(room.data, channelId, me?.id ?? "") : 0n;
  const isVoice = channel?.kind === "voice";
  // Opening needs use_whiteboard (voice channels also connect), like the node (WHITEBOARD.md §2).
  const canOpen = hasPermission(perms, isVoice ? Permission.CONNECT | Permission.USE_WHITEBOARD : Permission.USE_WHITEBOARD);
  const encrypted = channel?.encrypted ?? true;
  const memberAddresses = useMemo(() => members.data?.map((m) => m.user.address) ?? null, [members.data]);
  const e2ee = useE2eeConversation({ conversationId: qualify(domain, channelId), encrypted, canCreate: canOpen, members: memberAddresses, mayManage: room.data ? mayManageRoom(room.data) : false });
  const memberList: Member[] = useMemo(() => (members.data ?? []).map((m) => ({ address: m.user.address, name: m.nickname || m.user.display_name })), [members.data]);
  const targets = useMemo<ShareTarget[]>(() => {
    if (!room.data) return direct;
    const channels = room.data.channels
      .filter((c) => c.kind === "text" && hasPermission(channelPermissions(room.data!, c.id, me?.id ?? ""), Permission.SEND_MESSAGES) && hasPermission(channelPermissions(room.data!, c.id, me?.id ?? ""), Permission.ATTACH_FILES))
      .map((c) => ({ domain, conversationId: c.id, encrypted: c.encrypted, label: `# ${channelName(c)}` }));
    return [...channels, ...direct];
  }, [room.data, direct, domain, me?.id]);
  if (!channel) return { props: null, pending: room.isPending, error: room.error };
  return {
    pending: false,
    error: null,
    props: {
      ctx: { domain, conversationId: channelId, api, home, encrypted },
      title: channelName(channel),
      backTo: roomPath(roomId, channelId),
      canOpen,
      canModerate: hasPermission(perms, Permission.MANAGE_WHITEBOARD),
      ready: !encrypted || e2ee.phase === "ready",
      notReady: notReadyText(t, e2ee, encrypted),
      members: memberList,
      shareTargets: targets,
    },
  };
}

function ChannelBoard({ roomId, channelId }: { roomId: string; channelId: string }) {
  const t = useT();
  const board = useChannelBoard(roomId, channelId);
  if (board.pending) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  if (board.error) return <p className="p-4 text-sm text-danger">{describeError(board.error)}</p>;
  if (!board.props) return <p className="p-4 text-sm text-fg-2">{t("room.channel_not_found")}</p>;
  return <WhiteboardSession {...board.props} />;
}

function ConversationBoard({ conversationId }: { conversationId: string }) {
  const t = useT();
  const { api, me, domain, home } = useNode();
  const conv = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => api.conversations.get(conversationId) });
  const direct = useDirectTargets();
  const addresses = useMemo(() => conv.data?.members.map((m) => m.address) ?? null, [conv.data]);
  const e2ee = useE2eeConversation({ conversationId: qualify(domain, conversationId), encrypted: true, canCreate: true, members: addresses, direct: addresses ?? undefined, mayManage: true });
  const memberList: Member[] = useMemo(() => (conv.data?.members ?? []).map((m) => ({ address: m.address, name: m.display_name })), [conv.data]);
  if (conv.isPending) return <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>;
  if (conv.isError) return <p className="p-4 text-sm text-danger">{describeError(conv.error)}</p>;
  return (
    <WhiteboardSession
      ctx={{ domain, conversationId, api, home, encrypted: true }}
      title={conversationTitle(conv.data, me?.address)}
      backTo={conversationPath(home ? null : domain, conversationId)}
      canOpen
      canModerate={false}
      ready={e2ee.phase === "ready"}
      notReady={notReadyText(t, e2ee, true)}
      members={memberList}
      shareTargets={direct}
    />
  );
}
