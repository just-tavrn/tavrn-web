// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";
import { Permission, computePermissions, hasPermission, isBotKind, type Member, type RoomDetail, type TavrnApi } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { describeError } from "../stores/toasts";
import { ConversationView } from "../components/ConversationView";
import { useRoom } from "./ChannelSidebar";
import { channelName } from "../lib/names";
import { mayManageRoom } from "../lib/rooms";
import { VoiceStage } from "../voice/ui/VoiceStage";
import { useOriginDomain } from "../lib/origin";

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

/** Permissions of the signed-in user in a channel, computed client-side with the same logic as the node. */
export function channelPermissions(room: RoomDetail, channelId: string, userId: string): bigint {
  const channel = room.channels.find((c) => c.id === channelId);
  if (!channel) return 0n;
  const everyone = room.roles.find((r) => r.is_everyone);
  const memberRoles = room.roles.filter((r) => room.my_roles.includes(r.id) && !r.is_everyone).map((r) => [r.id, r.permissions] as [string, string]);
  const toEval = (o: { subject_type: string; subject_id: string; allow: string; deny: string }) => ({ subject_type: o.subject_type as "role" | "member", subject_id: o.subject_id, allow: o.allow, deny: o.deny });
  const perms = computePermissions({
    user_id: userId,
    is_owner: room.is_owner,
    everyone_role_id: everyone?.id ?? "",
    everyone_permissions: everyone?.permissions ?? "0",
    member_roles: memberRoles,
    category_overrides: room.overrides.filter((o) => o.target_type === "category" && o.target_id === channel.category_id).map(toEval),
    channel_overrides: room.overrides.filter((o) => o.target_type === "channel" && o.target_id === channel.id).map(toEval),
    sync_with_category: channel.sync_with_category && !!channel.category_id,
    timed_out: false,
    // The welcome channel is visible and read-only for everyone, owners included (SYSTEM_CHANNEL_FORCED/DENIED).
    system_channel: channel.kind === "system",
  });
  return perms;
}

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
  const { roomId = "", channelId = "" } = useParams();
  // The user as the room's node knows it (user ids are node-local).
  const { api, me: user, domain } = useNode();
  const originDomain = useOriginDomain();
  // The node domain is the identity domain from its discovery document, never the page host (design note 4.2c).
  const nodeDomain = domain || originDomain || "";
  const room = useRoom(roomId);
  const members = useRoomMembers(roomId);
  const queryClient = useQueryClient();
  const memberAddresses = useMemo(() => members.data?.map((m) => m.user.address) ?? null, [members.data]);
  const bots = useMemo(() => new Set((members.data ?? []).filter((m) => isBotKind(m.user.kind)).map((m) => m.user.address)), [members.data]);
  const roles = room.data?.roles;
  const mentionBase = useMemo(
    () => ({ users: (members.data ?? []).map((m) => ({ address: m.user.address })), roles: roles ?? [], memberRoles: Object.fromEntries((members.data ?? []).map((m) => [m.user.address, m.roles])) }),
    [members.data, roles],
  );

  if (room.isPending) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  if (room.isError) return <p className="p-4 text-sm text-danger">{describeError(room.error)}</p>;
  const channel = room.data.channels.find((c) => c.id === channelId);
  if (!channel) return <p className="p-4 text-sm text-fg-2">{t("room.channel_not_found")}</p>;
  const perms = channelPermissions(room.data, channelId, user?.id ?? "");
  const canSend = hasPermission(perms, Permission.SEND_MESSAGES);
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
  return (
    <ConversationView
      key={channelId}
      conversationId={channelId}
      encrypted={channel.encrypted}
      header={header}
      placeholder={t("messages.placeholder", { channel: channelName(channel) })}
      canSend={canSend && !system}
      canManage={hasPermission(perms, Permission.MANAGE_MESSAGES)}
      canAttach={canSend && hasPermission(perms, Permission.ATTACH_FILES)}
      canReact={hasPermission(perms, Permission.ADD_REACTIONS)}
      canPin={hasPermission(perms, Permission.PIN_MESSAGES)}
      noPermissionReason={t("messages.no_permission")}
      members={memberAddresses}
      refreshMembers={async () => (await queryClient.fetchQuery({ queryKey: ["members", roomId], queryFn: () => fetchRoomMembers(api, roomId), staleTime: 0 })).map((m) => m.user.address)}
      mayManage={mayManage}
      bots={bots}
      roomId={roomId}
      domain={nodeDomain}
      mentionContext={{ domain: nodeDomain, ...mentionBase, canMentionEveryone: hasPermission(perms, Permission.MENTION_EVERYONE) }}
      readOnlyNote={system ? t("members.welcome_read_only") : undefined}
      permissions={perms}
      room={room.data}
      roomMembers={members.data}
    />
  );
}
