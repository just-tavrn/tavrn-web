// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router";
import { Permission, hasPermission, isBotKind, type Member, type Message, type TavrnApi } from "@tavrn/sdk";
import { channelPermissions } from "../lib/channelPermissions";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { describeError } from "../stores/toasts";
import { ConversationView } from "../components/ConversationView";
import { useRoom } from "./ChannelSidebar";
import { channelName } from "../lib/names";
import { mayManageRoom } from "../lib/rooms";
import { VoiceStage } from "../voice/ui/VoiceStage";
import { useOriginDomain } from "../lib/origin";
import { toastError } from "../stores/toasts";
import { ThreadPanel } from "../threads/ThreadPanel";
import { ThreadsButton } from "../threads/ThreadsButton";
import { ForumView } from "../threads/ForumView";
import { CreateThreadDialog } from "../threads/CreateThreadDialog";
import { ResizablePanel } from "../threads/ResizablePanel";
import { startThread } from "../threads/actions";
import { defaultTitle } from "../threads/titles";
import { useFollowedThreads } from "../threads/useFollowedThreads";

// Files channels (design note 4.13 item 9): the file browser, loaded on demand.
const FilesView = lazy(() => import("../files/FilesView"));

/** All members of a room (paged through), shared by the member list and the ghost check. */
export function useRoomMembers(roomId: string) {
  const { api } = useNode();
  return useQuery({ queryKey: ["members", roomId], queryFn: () => fetchRoomMembers(api, roomId), enabled: !!roomId });
}

/** Every member of a room (pages of 500), the data of `useRoomMembers`. */
export async function fetchRoomMembers(api: TavrnApi, roomId: string): Promise<Member[]> {
  const all: Member[] = [];
  for (let page = 0; page < 20; page++) {
    const batch = await api.members.list(roomId, { limit: 500, after: all.at(-1)?.user.id });
    all.push(...batch);
    if (batch.length < 500) break;
  }
  return all;
}

/** Permissions of the signed-in user in a channel (lib/channelPermissions.ts; re-exported for the existing imports). */
export { channelPermissions } from "../lib/channelPermissions";

export function RoomIndexRedirect() {
  const t = useT();
  const { roomId = "" } = useParams();
  const room = useRoom(roomId);
  const { roomPath } = useNode();
  if (room.isPending) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  if (room.isError) return <p className="p-4 text-sm text-danger">{describeError(room.error)}</p>;
  // The welcome channel (kind `system`) is never the landing channel.
  const first = room.data.channels.find((c) => c.kind !== "voice" && c.kind !== "system") ?? room.data.channels.find((c) => c.kind !== "voice") ?? room.data.channels[0];
  return first ? <Navigate to={roomPath(roomId, first.id)} replace /> : <p className="p-4 text-sm text-fg-2">{t("room.no_channels")}</p>;
}

export function ChannelPage() {
  const t = useT();
  const { roomId = "", channelId = "", threadId } = useParams();
  const navigate = useNavigate();
  // The user as the room's node knows it (user ids are node-local).
  const { api, me: user, domain, roomPath } = useNode();
  const originDomain = useOriginDomain();
  // The node domain is the identity domain from its discovery document, never the page host (design note 4.2c).
  const nodeDomain = domain || originDomain || "";
  const room = useRoom(roomId);
  const members = useRoomMembers(roomId);
  const queryClient = useQueryClient();
  const memberAddresses = useMemo(() => members.data?.map((m) => m.user.address) ?? null, [members.data]);
  const bots = useMemo(() => new Set((members.data ?? []).filter((m) => isBotKind(m.user.kind)).map((m) => m.user.address)), [members.data]);
  const roles = room.data?.roles;
  // Threads (PROTOCOL.md §7e): the followed threads of the room seed the badges and decide which thread messages notify.
  useFollowedThreads(roomId);
  /** "Create thread" from a message: the dialog asks for the title. */
  const [creating, setCreating] = useState<{ root?: Message; title: string } | null>(null);
  const channelPath = roomPath(roomId, channelId);
  const openThread = useCallback((id: string) => navigate(`${channelPath}/threads/${id}`), [navigate, channelPath]);
  const closeThread = useCallback(() => navigate(channelPath), [navigate, channelPath]);
  const mentionBase = useMemo(
    () => ({ users: (members.data ?? []).map((m) => ({ address: m.user.address })), roles: roles ?? [], memberRoles: Object.fromEntries((members.data ?? []).map((m) => [m.user.address, m.roles])) }),
    [members.data, roles],
  );

  if (room.isPending) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  if (room.isError) return <p className="p-4 text-sm text-danger">{describeError(room.error)}</p>;
  const channel = room.data.channels.find((c) => c.id === channelId);
  if (!channel) return <p className="p-4 text-sm text-fg-2">{t("room.channel_not_found")}</p>;
  const perms = channelPermissions(room.data, channelId, user?.id ?? "");
  // Announcement channels: only members with manage_messages post; the others react and reply in threads.
  const announcementBlocked = channel.kind === "announcement" && !hasPermission(perms, Permission.MANAGE_MESSAGES);
  const canSend = hasPermission(perms, Permission.SEND_MESSAGES);
  const threadsHere = ["text", "announcement", "forum"].includes(channel.kind);
  const canStartThreads = threadsHere && channel.kind !== "forum" && hasPermission(perms, Permission.CREATE_THREADS);
  const mayManage = mayManageRoom(room.data);
  const system = channel.kind === "system";
  const header = (
    <>
      <span className="text-fg-2" aria-hidden="true">
        {channel.kind === "voice" ? "🔊" : system ? "👋" : "#"}
      </span>
      <h1 className="truncate text-sm font-semibold" data-testid="channel-name">
        {channelName(channel)}
      </h1>
      {channel.topic && <span className="hidden truncate text-sm text-fg-2 md:inline">· {channel.topic}</span>}
    </>
  );
  if (channel.kind === "voice") return <VoiceStage room={room.data} channel={channel} />;
  if (channel.kind === "files")
    return (
      <Suspense fallback={<p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>}>
        <FilesView key={channel.id} room={room.data} channel={channel} />
      </Suspense>
    );
  const view = {
    conversationId: channelId,
    encrypted: channel.encrypted,
    canManage: hasPermission(perms, Permission.MANAGE_MESSAGES),
    canAttach: canSend && hasPermission(perms, Permission.ATTACH_FILES),
    canReact: hasPermission(perms, Permission.ADD_REACTIONS),
    canPin: hasPermission(perms, Permission.PIN_MESSAGES),
    noPermissionReason: t("messages.no_permission"),
    members: memberAddresses,
    refreshMembers: async () => (await queryClient.fetchQuery({ queryKey: ["members", roomId], queryFn: () => fetchRoomMembers(api, roomId), staleTime: 0 })).map((m) => m.user.address),
    mayManage,
    bots,
    roomId,
    domain: nodeDomain,
    mentionContext: { domain: nodeDomain, ...mentionBase, canMentionEveryone: hasPermission(perms, Permission.MENTION_EVERYONE) },
    permissions: perms,
    room: room.data,
    roomMembers: members.data,
  };
  /** Message menu and thread indicator: open the message's thread, or start one (with a title dialog for "create"). */
  const onThread = async (m: Message, mode: "create" | "reply", text: string) => {
    if (m.thread) return openThread(m.thread.id);
    const title = defaultTitle(text, t("threads.default_title"));
    if (mode === "create") return setCreating({ root: m, title });
    try {
      openThread(await startThread({ api, domain, roomId, channelId, encrypted: channel.encrypted, title, rootMessageId: m.id }));
    } catch (e) {
      toastError(e);
    }
  };
  const main =
    channel.kind === "forum" ? (
      <ForumView key={channelId} room={room.data} channel={channel} perms={perms} roomMembers={members.data} members={memberAddresses} refreshMembers={view.refreshMembers} mayManage={mayManage} domain={nodeDomain} onOpen={openThread} />
    ) : (
      <ConversationView
        {...view}
        key={channelId}
        header={
          <>
            {header}
            {threadsHere && <ThreadsButton channel={channel} onOpen={openThread} onNew={canStartThreads ? () => setCreating({ title: "" }) : undefined} />}
          </>
        }
        placeholder={t("messages.placeholder", { channel: channelName(channel) })}
        canSend={canSend && !system && !announcementBlocked}
        readOnlyNote={system ? t("members.welcome_read_only") : undefined}
        composerNote={announcementBlocked && canSend ? t("announcement.read_only") : undefined}
        onThread={threadsHere ? (m, mode, text) => void onThread(m, mode, text) : undefined}
        canStartThreads={canStartThreads}
        jumpEnabled={!threadId}
      />
    );
  return (
    <div className="flex min-h-0 flex-1" data-testid="channel-page">
      {/* Phones show the thread full screen (back button); larger screens keep the channel next to it. */}
      <div className={`${threadId ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>{main}</div>
      {threadId && threadsHere && (
        <ResizablePanel>
          <ThreadPanel key={threadId} threadId={threadId} channel={channel} perms={perms} onClose={closeThread} view={view} />
        </ResizablePanel>
      )}
      <CreateThreadDialog
        open={!!creating}
        initialTitle={creating?.title ?? ""}
        encrypted={channel.encrypted}
        onClose={() => setCreating(null)}
        onCreate={async (title) => {
          const id = await startThread({ api, domain, roomId, channelId, encrypted: channel.encrypted, title, rootMessageId: creating?.root?.id });
          setCreating(null);
          openThread(id);
        }}
      />
    </div>
  );
}
