// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { Permission, hasPermission, type Channel, type RoomDetail, type VoiceParticipant } from "@tavrn/sdk";
import { useLocale, useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { channelName } from "../../lib/names";
import { channelPermissions } from "../../pages/ChannelPage";
import { participantsOf, useVoicePresence } from "../presence";
import { ownVoiceChannel, useVoice } from "../store";
import { joinVoice } from "../index";
import { useRoomVoiceStates } from "../useVoiceRealtime";
import { AvatarTile } from "./AvatarTile";
import { ConnectionGlyph, ParticipantFlags, levelStyle, useMemberLooks, useParticipantStatus, usePriority } from "./common";
import { useParticipantMenu } from "./useParticipantMenu";
import { MegaphoneIcon, SpeakerIcon } from "./icons";
import { AccessMark, LockMark, accessMarkKey } from "../../components/Badges";
import { channelAccessMarks } from "../../lib/channelPermissions";
import { sortByRank, type ParticipantLook } from "../order";
import { WhiteboardOwnerBadge } from "../../whiteboard/WhiteboardStage";
import { useToasts } from "../../stores/toasts";
import { voiceErrorMessage } from "../errors";
import { useChannelMenu } from "../../components/menus/ChannelMenu";
import { MenuButton } from "../../components/ContextMenu";

/** Drag-and-drop payload of a voice participant (moving between channels). */
const DRAG_TYPE = "application/x-tavrn-voice-member";

/**
 * A voice channel in the sidebar (VOICE.md §9, design note 4.5 item 6): its participants for everybody who
 * can see the channel (also outside the call) with mute/deafen/stream/camera flags, the user limit as
 * `3/5`, and joining by clicking. Speakers of the own call get a glow ring around the 24 px avatar. With
 * `move_members` participants can be dragged onto another voice channel. The channel's context menu
 * (right-click, long press or ⋯) is the one of text channels plus the mass moves (design note 4.11).
 * Participants are sorted by their highest role, then name, and shown in their role colour; each has the
 * member list's context menu (design note 4.13 item 3).
 */
export function VoiceChannelRow({ room, channel, onNavigate }: { room: RoomDetail; channel: Channel; onNavigate: () => void }) {
  const t = useT();
  const { api, domain, me, roomPath } = useNode();
  const navigate = useNavigate();
  useRoomVoiceStates(room.id);
  const unsorted = useVoicePresence((s) => participantsOf(s, domain, channel.id));
  const locale = useLocale((s) => s.locale);
  const { look, version } = useMemberLooks(room);
  const participants = useMemo(
    () =>
      sortByRank(
        unsorted,
        (p) => look(p.user),
        (p) => p.identity,
        locale,
      ),
    // `look` is new on every render; `version` changes with the members and roles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unsorted, version, locale],
  );
  const connected = useVoice((s) => s.status !== "idle" && s.target?.domain === domain && s.target.channelId === channel.id);
  const voiceChannelId = useVoice((s) => ownVoiceChannel(s, domain, room.id));
  const perms = channelPermissions(room, channel.id, me?.id ?? "", voiceChannelId);
  const limit = channel.user_limit ?? 0;
  const count = limit > 0 ? `${participants.length}/${limit}` : participants.length > 0 ? String(participants.length) : "";
  const canMove = hasPermission(perms, Permission.MOVE_MEMBERS);
  // Access marks (private first, then restricted for this viewer); the link's own name repeats them.
  const marks = channelAccessMarks(room, channel.id, perms);
  const canConnect = hasPermission(perms, Permission.CONNECT);
  const [dropping, setDropping] = useState(false);
  const { menu, overlay } = useChannelMenu(room, channel);

  // Drag a participant of another channel onto this one (`move_members`, design note 4.11).
  const accepts = (e: React.DragEvent) => canMove && e.dataTransfer.types.includes(DRAG_TYPE);
  const onDrop = async (e: React.DragEvent) => {
    setDropping(false);
    if (!accepts(e)) return;
    e.preventDefault();
    let data: { roomId: string; channelId: string; address: string };
    try {
      data = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
    } catch {
      return;
    }
    if (data.roomId !== room.id || data.channelId === channel.id) return;
    try {
      await api.voice.move(room.id, data.channelId, data.address, channel.id);
    } catch (err) {
      useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(err) });
    }
  };

  const open = () => {
    onNavigate();
    navigate(roomPath(room.id, channel.id));
    // Without connect the stage explains it ("You may not join this voice channel."); no join attempt to refuse.
    if (!connected && canConnect) void joinVoice({ domain, roomId: room.id, channelId: channel.id }, { canCreate: hasPermission(perms, Permission.SEND_MESSAGES) });
  };

  return (
    <div
      data-testid="voice-channel"
      data-channel={channel.id}
      data-drop={dropping || undefined}
      className={`rounded-md ${dropping ? "bg-accent-soft ring-1 ring-accent" : ""}`}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="group/vc relative" data-testid="voice-channel-header">
      {/* The context menu (right-click, long press) sits on the link; the ⋯ button next to it stays clickable. */}
      <NavLink
        to={roomPath(room.id, channel.id)}
        {...menu.triggerProps}
        onClick={(e) => {
          e.preventDefault();
          open();
        }}
        className={({ isActive }) => `flex min-h-10 items-center gap-2 rounded-md px-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : connected ? "text-fg-0 hover:bg-bg-3/60" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}
        aria-label={[t("voice.channel_label", { name: channelName(channel) }), ...marks.map((m) => t(accessMarkKey(m)))].join(", ")}
      >
        {/* Voice is always end-to-end encrypted: the speaker and the 16 px lock, aligned with the text channels. */}
        <span className="flex w-9 shrink-0 items-center gap-1">
          <SpeakerIcon size={16} className={connected ? "text-accent" : "text-fg-2"} />
          <LockMark testId="voice-channel-lock" />
        </span>
        <span className={`min-w-0 flex-1 truncate ${canConnect ? "" : "text-fg-2"}`}>{channelName(channel)}</span>
        {marks.map((m) => (
          <AccessMark key={m} kind={m} />
        ))}
        {count && (
          <span className="text-[11px] tabular-nums text-fg-2" data-testid="voice-count" title={limit > 0 ? t("voice.limit_hint", { limit }) : undefined}>
            {count}
          </span>
        )}
        <span className="w-7 shrink-0" aria-hidden="true" />
      </NavLink>
      <MenuButton
        menu={menu}
        label={t("voice.channel_menu", { name: channelName(channel) })}
        className="absolute right-0.5 top-1/2 min-h-7 min-w-7 -translate-y-1/2 opacity-0 focus:opacity-100 group-hover/vc:opacity-100 pointer-coarse:opacity-100"
        testId="voice-channel-menu-button"
      />
      </div>
      {overlay}
      {participants.length > 0 && (
        <ul className="mb-1 ml-7 space-y-0.5" data-testid="voice-participants">
          {participants.map((p) => (
            <ParticipantRow key={p.identity} room={room} channelId={channel.id} p={p} look={look(p.user)} draggable={canMove && p.user_id !== me?.id} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ParticipantRow({ room, channelId, p, look, draggable }: { room: RoomDetail; channelId: string; p: VoiceParticipant; look: ParticipantLook; draggable: boolean }) {
  const t = useT();
  const { status, level } = useParticipantStatus(p);
  const priority = usePriority(p.identity);
  const { menu, overlay } = useParticipantMenu(room, channelId, p);
  const speaking = status === "speaking";
  const name = look.name;
  return (
    <li
      className={`group flex min-h-8 items-center gap-2 rounded-md px-1 text-[13px] hover:bg-bg-3/60 ${priority ? "voice-priority-row" : ""}`}
      data-testid="voice-participant"
      data-user={p.user}
      data-speaking={speaking || undefined}
      data-priority={priority || undefined}
      data-connection={status === "reconnecting" ? "reconnecting" : undefined}
      draggable={draggable || undefined}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ roomId: room.id, channelId, address: p.user }));
        e.dataTransfer.effectAllowed = "move";
      }}
      {...menu.triggerProps}
      title={draggable ? `${p.user} – ${t("voice.mod.drag_hint")}` : p.user}
    >
      <span className={`voice-ring relative rounded-full ${status === "reconnecting" ? "opacity-70" : ""}`} data-speaking={speaking || undefined} style={levelStyle(level)}>
        <AvatarTile roomId={room.id} name={name} address={p.user} size={24} speaking={speaking} />
        {status === "reconnecting" && <ConnectionGlyph status={status} size={10} className="absolute -bottom-1 -right-1" />}
      </span>
      <span className={`voice-name min-w-0 flex-1 truncate ${speaking ? "text-fg-0" : "text-fg-1"}`} style={look.color ? { color: look.color } : undefined} data-testid="voice-participant-name">
        {name}
      </span>
      {priority && (
        <span role="img" className="text-accent" title={t("voice.priority.active", { name })} aria-label={t("voice.priority.active", { name })} data-testid="priority-glyph">
          <MegaphoneIcon size={13} />
        </span>
      )}
      {status === "poor" && <ConnectionGlyph status={status} />}
      <WhiteboardOwnerBadge channelId={channelId} address={p.user} />
      <ParticipantFlags p={p} size={13} />
      <MenuButton menu={menu} label={t("voice.participant_menu", { name })} className="min-h-7 min-w-7 opacity-0 focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100" testId="voice-participant-menu-button" />
      {overlay}
    </li>
  );
}
