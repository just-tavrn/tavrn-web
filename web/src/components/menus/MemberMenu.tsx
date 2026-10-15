// SPDX-License-Identifier: Apache-2.0
/**
 * The context menu of a room member (design note 4.11): profile, message, call, friend request, invite to room, mention, copy
 * address; for moderators kick, ban (with reason), timeout, roles, and for members in voice server mute,
 * disconnect, move, the per-user voice volume (plus the stream volume while they stream) and "mute for you"; block. Gated by permissions and the role hierarchy
 * (`lib/menus.ts`); the node enforces the same rules. Voice list rows and stage tiles open the same menu
 * (design note 4.13 item 3).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { Member, RoomDetail, VoiceParticipant } from "@tavrn/sdk";
import { isBotKind, parsePermissions } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { api as homeApi } from "../../lib/api";
import { memberMenu, voiceParticipantMenu } from "../../lib/menus";
import { localPart } from "../../voice/order";
import { topPosition } from "../../lib/hierarchy";
import { insertIntoComposer, mentionToken } from "../../lib/composerBridge";
import { channelName } from "../../lib/names";
import { toastError, useToasts } from "../../stores/toasts";
import { useAction } from "../../hooks/useAction";
import { participantsOf, useVoicePresence, voiceChannelOfUser } from "../../voice/presence";
import { useVoice } from "../../voice/store";
import { useVoiceSettings } from "../../voice/settings";
import { setLocalMute, useLocalMute } from "../../voice/localMute";
import { VolumeSlider } from "../../voice/ui/StreamAudio";
import { ContextMenu, useContextMenu, type ContextMenuTrigger, type MenuEntry } from "../ContextMenu";
import { ProfileCard } from "../ProfilePopover";
import { useNode } from "../NodeScope";
import { useShell } from "../AppShell";
import { openDm, useFriends } from "../../pages/DirectMessages";
import { ConfirmAction, copyWithToast } from "./common";
import type { AnchorRect } from "../../lib/position";
import { useCapabilities } from "../../moderation/hooks";
import { ReportDialog } from "../../moderation/ReportDialog";
import { sendRoomInvite, useInviteRooms } from "./inviteToRoom";

/** A voice participant the menu is opened on (voice list rows and stage tiles, design note 4.13 item 3). */
export interface VoiceMenuTarget {
  participant: Pick<VoiceParticipant, "user" | "user_id" | "server_muted">;
  channelId: string;
}

/**
 * Menu state, entries and overlays (dialogs, profile card) for one member. Voice rows and tiles pass the
 * participant too: with its member entry they get the member menu (plus "copy id"); without one (not
 * loaded, or a member of another node) the reduced voice menu (`voiceParticipantMenu`).
 */
export function useMemberMenu(room: RoomDetail, member: Member | null, voiceTarget?: VoiceMenuTarget): { menu: ContextMenuTrigger; overlay: ReactNode } {
  const t = useT();
  const menu = useContextMenu();
  const { api, domain, me, home } = useNode();
  const canReport = !!useCapabilities(home ? null : domain)?.includes("reports.v1");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { closeMembers } = useShell();
  const friends = useFriends();
  const [dialog, setDialog] = useState<"kick" | "ban" | "block" | "report" | null>(null);
  const [profile, setProfile] = useState<AnchorRect | null>(null);
  const [roles, setRoles] = useState<string[] | null>(null);
  const userId = member?.user.id ?? voiceTarget?.participant.user_id ?? "";
  const presenceChannel = useVoicePresence((s) => voiceChannelOfUser(s, domain, room.id, userId));
  const voiceChannelId = voiceTarget?.channelId ?? presenceChannel;
  const participant = useVoicePresence((s) => (voiceChannelId ? participantsOf(s, domain, voiceChannelId).find((p) => p.user_id === userId) : undefined)) ?? voiceTarget?.participant;
  const inMyCall = useVoice((s) => !!voiceChannelId && s.status === "connected" && s.target?.domain === domain && s.target.channelId === voiceChannelId);
  const address = member?.user.address ?? voiceTarget?.participant.user ?? "";
  const volume = useVoiceSettings((s) => s.settings.userVolumes[address] ?? 100);
  const streamVolume = useVoiceSettings((s) => s.settings.streamVolumes[address] ?? 100);
  const setUserVolume = useVoiceSettings((s) => s.setUserVolume);
  const setStreamVolume = useVoiceSettings((s) => s.setStreamVolume);
  const streaming = !!(participant && "streaming" in participant && participant.streaming);
  // Muted for this user only (voice/localMute.ts, issue #124).
  const localMuted = useLocalMute((s) => !!s.muted[address]);
  const name = member ? member.nickname || member.user.display_name : localPart(address);
  const currentRoles = roles ?? member?.roles ?? [];
  // "Invite to room": the user's other rooms (the target is in this one).
  const inviteRooms = useInviteRooms(menu.open && !!member).filter((r) => r.id !== room.id);
  // Role toggles keep the menu open; once it closes the member list is the truth again.
  useEffect(() => {
    if (!menu.open) setRoles(null);
  }, [menu.open]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["members", room.id] });
    await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
  };
  // Menu actions run one at a time; the member list's refetch afterwards is not part of the action.
  const { run: act } = useAction({ refresh });
  const run = (fn: () => Promise<unknown>, done?: string) => act(fn, { done });
  const otherVoiceChannels = room.channels.filter((c) => c.kind === "voice" && c.id !== voiceChannelId).map((c) => ({ id: c.id, name: channelName(c) }));
  const voiceActions = {
    serverMute: (muted: boolean) => voiceChannelId && void run(() => api.voice.serverMute(room.id, voiceChannelId, address, muted)),
    disconnect: () => voiceChannelId && void run(() => api.voice.disconnect(room.id, voiceChannelId, address)),
    moveTo: (target: string) => voiceChannelId && void run(() => api.voice.move(room.id, voiceChannelId, address, target)),
    volume: (v: number): MenuEntry => ({ kind: "custom", id: "volume", render: () => <VolumeSlider label={t("menu.member.volume")} value={v} onChange={(p) => setUserVolume(address, p)} testid="menu-volume" /> }),
    streamVolume: (v: number): MenuEntry => ({ kind: "custom", id: "stream-volume", render: () => <VolumeSlider label={t("menu.member.stream_volume")} value={v} onChange={(p) => setStreamVolume(address, p)} testid="menu-stream-volume" /> }),
    localMute: (muted: boolean) => setLocalMute(address, muted),
    copyAddress: () => void copyWithToast(address, t("menu.copied")),
  };
  const copyId = voiceTarget ? () => void copyWithToast(userId, t("menu.copied")) : undefined;

  let entries: MenuEntry[] = [];
  if (menu.open && !member) {
    entries = voiceParticipantMenu(
      { self: userId === me?.id, perms: parsePermissions(room.my_permissions), serverMuted: !!participant?.server_muted, inMyCall, volume, streaming, streamVolume, localMuted, channels: otherVoiceChannels },
      { ...voiceActions, copyId: copyId ?? (() => undefined) },
      t,
    );
  } else if (menu.open && member) {
    const self = member.user.id === me?.id;
    const friendList = friends.data;
    entries = memberMenu(
      {
        self,
        target: { address, name, isOwner: member.user.id === room.owner_id, top: topPosition(room.roles, currentRoles), roles: currentRoles, timedOut: !!member.timeout_until && Date.parse(member.timeout_until) > Date.now(), bot: isBotKind(member.user.kind) },
        room: { perms: parsePermissions(room.my_permissions), isOwner: room.is_owner, myTop: topPosition(room.roles, room.my_roles, room.is_owner), roles: room.roles },
        voice: voiceChannelId ? { channelId: voiceChannelId, serverMuted: !!participant?.server_muted, channels: otherVoiceChannels, inMyCall, volume, streaming, streamVolume, localMuted } : undefined,
        friend: !!friendList?.friends.some((f) => f.user.address === address),
        friendPending: !!friendList?.outgoing.some((r) => r.user.address === address),
        callsAvailable: false,
        canMention: true,
        canReport,
        inviteRooms,
      },
      {
        ...voiceActions,
        profile: () => setProfile(menu.anchor),
        message: () =>
          void openDm(address, queryClient)
            .then((path) => {
              closeMembers();
              navigate(path);
            })
            .catch(toastError),
        call: () => undefined,
        addFriend: () => void run(async () => {
          await homeApi.friends.request(address);
          await queryClient.invalidateQueries({ queryKey: ["friends"] });
        }, t("menu.member.friend_sent")),
        mention: () => {
          if (!insertIntoComposer(mentionToken(address, domain))) useToasts.getState().push({ kind: "warning", title: t("menu.member.mention_no_composer") });
          else closeMembers();
        },
        kick: () => setDialog("kick"),
        ban: () => setDialog("ban"),
        timeout: (minutes) => void run(() => api.members.timeout(room.id, member.user.id, { minutes }), t("member.timeout_done")),
        clearTimeout: () => void run(() => api.members.timeout(room.id, member.user.id, { minutes: 0 }), t("menu.member.timeout_cleared")),
        toggleRole: (roleId, on) => {
          const next = on ? [...new Set([...currentRoles, roleId])] : currentRoles.filter((r) => r !== roleId);
          setRoles(next);
          void api.members
            .update(room.id, member.user.id, { roles: next })
            .then((m) => {
              setRoles(m.roles);
              return refresh();
            })
            .catch((e: unknown) => {
              setRoles(null);
              toastError(e);
            });
        },
        block: () => setDialog("block"),
        report: () => setDialog("report"),
        inviteToRoom: (target) => void sendRoomInvite(target, address, name),
        copyId,
      },
      t,
    );
  }

  const overlay = (
    <>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label={t("menu.label", { name })} testId="member-menu" />}
      {profile && <ProfileCard address={address} anchor={profile} onClose={() => setProfile(null)} node={undefined} />}
      {dialog === "kick" && member && (
        <ConfirmAction title={t("menu.member.kick_title", { name })} text={t("menu.member.kick_text", { address })} action={t("menu.member.kick")} onClose={() => setDialog(null)} onConfirm={async () => { await api.members.kick(room.id, member.user.id); useToasts.getState().push({ kind: "info", title: t("member.kicked") }); await refresh(); }} testId="kick-dialog" />
      )}
      {dialog === "ban" && member && (
        <ConfirmAction title={t("menu.member.ban_title", { name })} text={t("menu.member.ban_text", { address })} action={t("menu.member.ban")} reasonLabel={t("member.reason")} onClose={() => setDialog(null)} onConfirm={async (reason) => { await api.members.ban(room.id, { subject: address, reason }); useToasts.getState().push({ kind: "info", title: t("member.banned") }); await refresh(); }} testId="ban-dialog" />
      )}
      {dialog === "report" && member && (
        <ReportDialog subject={{ kind: "user", address, name, roomId: room.id, roomName: room.name }} client={api} node={domain} onClose={() => setDialog(null)} />
      )}
      {dialog === "block" && member && (
        <ConfirmAction title={t("menu.member.block_title", { name })} text={t("menu.member.block_text", { address })} action={t("menu.member.block")} reasonLabel={t("menu.member.block_reason")} onClose={() => setDialog(null)} onConfirm={async (reason) => { await homeApi.blocks.block(address, reason || null); useToasts.getState().push({ kind: "info", title: t("menu.member.blocked") }); await queryClient.invalidateQueries({ queryKey: ["blocks"] }); }} testId="block-dialog" />
      )}
    </>
  );
  return { menu, overlay };
}
