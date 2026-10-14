// SPDX-License-Identifier: Apache-2.0
import { useRoomPreview } from "../../stores/rolePreview";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { Permission, hasPermission, type Channel, type RoomDetail, type VoiceParticipant } from "@tavrn/sdk";
import { useLocale, useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { channelName } from "../../lib/names";
import { channelPermissions } from "../../pages/ChannelPage";
import { participantsOf, sessionStartOf, useVoicePresence } from "../presence";
import { ownVoiceChannel, useVoice } from "../store";
import { joinStream, joinVoice } from "../index";
import { rowStreamAction } from "../streams";
import { useRoomVoiceStates } from "../useVoiceRealtime";
import { AvatarTile } from "./AvatarTile";
import { ConnectionGlyph, LocalMuteMark, ParticipantFlags, levelStyle, useMemberLooks, useParticipantStatus, usePriority } from "./common";
import { useParticipantMenu } from "./useParticipantMenu";
import { MegaphoneIcon, SpeakerIcon } from "./icons";
import { elapsedSince, formatElapsed, useNow } from "./VoiceHeaderMeta";
import { AccessMark, LockMark, accessMarkKey } from "../../components/Badges";
import { channelAccessMarks, type ChannelAccess } from "../../lib/channelPermissions";
import { sortByRank, type ParticipantLook } from "../order";
import { WhiteboardRowBadge } from "../../whiteboard/WhiteboardStage";
import { useWhiteboardSession } from "../../whiteboard/store";
import { presenterIdentity, rowBoardAction, setBoardPreview } from "../../whiteboard/stage";
import { useToasts } from "../../stores/toasts";
import { voiceErrorMessage } from "../errors";
import { useChannelMenu } from "../../components/menus/ChannelMenu";
import { MenuButton } from "../../components/ContextMenu";

/** Drag-and-drop payload of a voice participant (moving between channels). */
const DRAG_TYPE = "application/x-tavrn-voice-member";

/** Who can be dragged: the own participation (joins the target), somebody else (a moderator's move), or nobody. */
type Drag = "self" | "move" | null;

/**
 * The participant being dragged, from `dragstart` to `dragend`: browsers hide `dataTransfer` data during `dragover`
 * (only the types are readable), and the target has to know whose drag it is to say whether it accepts it.
 */
let dragging: { roomId: string; channelId: string; address: string; self: boolean } | null = null;

type DropState = "accept" | "refuse" | null;

/**
 * A voice channel in the sidebar (VOICE.md §9, design note 4.5 item 6): its participants for everybody who
 * can see the channel (also outside the call) with mute/deafen/stream/camera flags, the user limit as
 * `3/5`, and joining by clicking. Speakers of the own call get a glow ring around the 24 px avatar. With
 * `move_members` participants can be dragged onto another voice channel; the own row can be dragged onto any channel
 * one may join (issue #119; the non-drag equivalent is clicking the channel, for others the participant menu). A
 * channel highlights while an accepted drag is over it and refuses visibly otherwise. The channel's context menu
 * (right-click, long press or ⋯) is the one of text channels plus the mass moves (design note 4.11).
 * Participants are sorted by their highest role, then name, and shown in their role colour; each has the
 * member list's context menu (design note 4.13 item 3). A double-click (or Enter) on a streaming member (LIVE) joins
 * their stream and opens the stage, while this device is in the same voice channel (otherwise a hint); the same on
 * the member who presents the channel's whiteboard (the small board badge next to LIVE) joins the whiteboard.
 */
export function VoiceChannelRow({ room, channel, onNavigate, access }: { room: RoomDetail; channel: Channel; onNavigate: () => void; access?: ChannelAccess }) {
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
  // The channel list hands over what it computed for every channel once per room version (lib/channelPermissions.ts).
  const perms = access?.permissions ?? channelPermissions(room, channel.id, me?.id ?? "", voiceChannelId);
  const limit = channel.user_limit ?? 0;
  const count = limit > 0 ? `${participants.length}/${limit}` : participants.length > 0 ? String(participants.length) : "";
  const canMove = hasPermission(perms, Permission.MOVE_MEMBERS);
  // Access marks (private first, then restricted for this viewer); the link's own name repeats them.
  const marks = access?.marks ?? channelAccessMarks(room, channel.id, perms);
  const canConnect = hasPermission(perms, Permission.CONNECT);
  // Role preview: no joins, no moves (no drag and drop, the stage shows what the role may do instead).
  const preview = useRoomPreview(room.id);
  const [drop, setDrop] = useState<DropState>(null);
  // Entering a child fires dragleave on this element (and dragenter on the child, both bubbling here): the indicator
  // clears only when the drag left the whole channel, so it does not flicker over the name, the count or the rows.
  const depth = useRef(0);
  const leaveAll = () => {
    depth.current = 0;
    setDrop(null);
  };
  // A drag that ends over this channel without a drop (refused, Escape) does not always send a dragleave.
  useEffect(() => {
    if (!drop) return;
    window.addEventListener("dragend", leaveAll, true);
    return () => window.removeEventListener("dragend", leaveAll, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drop]);
  const { menu, overlay } = useChannelMenu(room, channel);
  const canCreate = hasPermission(perms, Permission.SEND_MESSAGES);
  // The tooltip: the channel's status (VOICE.md §2a) and how long the session has been running (§5). The clock
  // only ticks while the pointer or the focus is on the row, so idle rows never re-render.
  const sessionStart = useVoicePresence((s) => sessionStartOf(s, domain, channel.id));
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const now = useNow(tooltipOpen && sessionStart ? 1000 : 0);
  const tooltip = [channel.status || null, sessionStart ? t("voice.session.row_tooltip", { time: formatElapsed(elapsedSince(sessionStart, now)) }) : null].filter(Boolean).join("\n") || undefined;

  // A participant of another channel of this room dragged over this one (design note 4.11, issue #119): a moderator's
  // move needs `move_members` here, the own participation `connect` (the node decides either way); the source channel
  // is no target. `refuse` shows, `accept` also allows the drop.
  const dropState = (e: React.DragEvent): DropState => {
    if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE) || preview) return null;
    if (dragging.roomId !== room.id || dragging.channelId === channel.id) return null;
    return (dragging.self ? canConnect : canMove) ? "accept" : "refuse";
  };
  const onDrop = async (e: React.DragEvent) => {
    leaveAll();
    const d = dragging;
    if (!d || dropState(e) !== "accept") return;
    e.preventDefault();
    dragging = null;
    if (d.self) {
      void joinVoice({ domain, roomId: room.id, channelId: channel.id }, { canCreate });
      return;
    }
    try {
      await api.voice.move(room.id, d.channelId, d.address, channel.id);
    } catch (err) {
      useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(err) });
    }
  };

  const open = () => {
    onNavigate();
    navigate(roomPath(room.id, channel.id));
    // Without connect the stage explains it ("You may not join this voice channel."); no join attempt to refuse.
    if (!connected && canConnect && !preview) void joinVoice({ domain, roomId: room.id, channelId: channel.id }, { canCreate });
  };

  return (
    <div
      data-testid="voice-channel"
      data-channel={channel.id}
      data-drop={drop ?? undefined}
      className={`rounded-md ${drop === "accept" ? "bg-accent-soft ring-2 ring-accent" : drop === "refuse" ? "bg-danger/10 ring-2 ring-danger" : ""}`}
      onDragEnter={() => {
        depth.current += 1;
      }}
      onDragOver={(e) => {
        const state = dropState(e);
        setDrop(state);
        if (state !== "accept") {
          // No preventDefault: the browser shows "not allowed" and fires no drop here.
          if (state === "refuse") e.dataTransfer.dropEffect = "none";
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDrop(null);
      }}
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
        className={({ isActive }) => `group/ch flex min-h-10 items-center gap-2 rounded-md px-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : connected ? "text-fg-0 hover:bg-bg-3/60" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}
        aria-label={[t("voice.channel_label", { name: channelName(channel) }), ...marks.map((m) => t(accessMarkKey(m)))].join(", ")}
        aria-description={tooltip}
        title={tooltip}
        data-testid="voice-channel-link"
        onPointerEnter={() => setTooltipOpen(true)}
        onPointerLeave={() => setTooltipOpen(false)}
        onFocus={() => setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
      >
        {/* Voice is always end-to-end encrypted: the speaker and the 16 px lock, aligned with the text channels. */}
        <span className="flex w-9 shrink-0 items-center gap-1">
          <SpeakerIcon size={16} className={connected ? "text-accent" : "text-fg-2"} />
          <LockMark testId="voice-channel-lock" />
        </span>
        <span className={`min-w-0 flex-1 truncate ${canConnect ? "" : "text-fg-2 group-aria-[current=page]/ch:text-fg-0"}`}>{channelName(channel)}</span>
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
        <ParticipantList
          room={room}
          channelId={channel.id}
          participants={participants}
          look={look}
          // The own participation (this device's) can always be dragged to where one may join; others with `move_members`.
          drag={(p) => (preview ? null : p.user_id === me?.id ? (voiceChannelId === channel.id ? "self" : null) : canMove ? "move" : null)}
          onStage={() => {
            onNavigate();
            navigate(roomPath(room.id, channel.id));
          }}
        />
      )}
    </div>
  );
}

/** The participants of a voice channel; the one presenting the channel's whiteboard gets its badge. */
function ParticipantList({ room, channelId, participants, look, drag, onStage }: { room: RoomDetail; channelId: string; participants: VoiceParticipant[]; look: (address: string) => ParticipantLook; drag: (p: VoiceParticipant) => Drag; onStage: () => void }) {
  // Only channels with participants watch their board (the session and the thumbnail; nothing else is decrypted).
  const { session, join } = useWhiteboardSession(channelId);
  const presenter = presenterIdentity(session, participants.map((p) => p.identity));
  return (
    <ul className="mb-1 ml-7 space-y-0.5" data-testid="voice-participants">
      {participants.map((p) => (
        <ParticipantRow key={p.identity} room={room} channelId={channelId} p={p} look={look(p.user)} drag={drag(p)} board={p.identity === presenter} joinBoard={join} onStage={onStage} />
      ))}
    </ul>
  );
}

function ParticipantRow({ room, channelId, p, look, drag, board, joinBoard, onStage }: { room: RoomDetail; channelId: string; p: VoiceParticipant; look: ParticipantLook; drag: Drag; board: boolean; joinBoard: () => void; onStage: () => void }) {
  const t = useT();
  const { domain } = useNode();
  const { status, level, localMuted } = useParticipantStatus(p);
  const priority = usePriority(p.identity);
  const { menu, overlay } = useParticipantMenu(room, channelId, p);
  const speaking = status === "speaking";
  const name = look.name;
  // A streaming member: double-click or Enter joins the stream (opt-in screen shares, `streams.ts`); the member who
  // presents the whiteboard: the same joins the board (one presents either, `whiteboard/stage.ts`).
  const streaming = !!p.streaming;
  const joinable = streaming || board;
  const watchStream = () => {
    const v = useVoice.getState();
    if (streaming) {
      const action = rowStreamAction({ identity: p.identity, streaming }, v, { domain, channelId });
      if (action === "hint") useToasts.getState().push({ kind: "info", title: t("voice.stream.join_first"), testId: "stream-join-hint" });
      if (action !== "join" && action !== "preview") return;
      if (action === "join") joinStream(p.identity);
      else useVoice.setState({ selfPreview: true });
      onStage();
      return;
    }
    const action = rowBoardAction({ identity: p.identity, presenting: board }, v, { domain, channelId });
    if (action === "hint") useToasts.getState().push({ kind: "info", title: t("whiteboard.join_first"), testId: "whiteboard-join-hint" });
    if (action !== "join" && action !== "preview") return;
    if (action === "join") joinBoard();
    else setBoardPreview(true);
    onStage();
  };
  const hint = drag ? `${p.user} – ${t(drag === "self" ? "voice.mod.drag_self_hint" : "voice.mod.drag_hint")}` : p.user;
  const rowHint = streaming ? t("voice.stream.row_hint") : board ? t("whiteboard.row_hint") : null;
  return (
    <li
      className={`group flex min-h-8 items-center gap-2 rounded-md px-1 text-[13px] hover:bg-bg-3/60 ${priority ? "voice-priority-row" : ""}`}
      data-testid="voice-participant"
      data-user={p.user}
      data-speaking={speaking || undefined}
      data-priority={priority || undefined}
      data-local-muted={localMuted || undefined}
      data-connection={status === "reconnecting" ? "reconnecting" : undefined}
      draggable={!!drag || undefined}
      onDragStart={(e) => {
        if (!drag) return;
        dragging = { roomId: room.id, channelId, address: p.user, self: drag === "self" };
        // The payload names the type (the targets look for it); Firefox starts no drag without data.
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragging));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        dragging = null;
      }}
      {...menu.triggerProps}
      title={rowHint ? `${hint} – ${rowHint}` : hint}
      data-streaming={streaming || undefined}
      data-whiteboard={board || undefined}
      tabIndex={joinable ? 0 : undefined}
      aria-keyshortcuts={joinable ? "Enter" : undefined}
      onDoubleClick={
        joinable
          ? (e) => {
              // Not from the (portaled) member menu, which bubbles through the React tree.
              if (!e.currentTarget.contains(e.target as Node)) return;
              e.preventDefault();
              watchStream();
            }
          : undefined
      }
      onKeyDown={(e) => {
        if (!joinable || e.defaultPrevented || e.key !== "Enter" || e.target !== e.currentTarget) return;
        e.preventDefault();
        watchStream();
      }}
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
      {board && <WhiteboardRowBadge />}
      <ParticipantFlags p={p} size={13} />
      {localMuted && <LocalMuteMark address={p.user} name={name} size={13} />}
      <MenuButton menu={menu} label={t("voice.participant_menu", { name })} className="min-h-7 min-w-7 opacity-0 focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100" testId="voice-participant-menu-button" />
      {overlay}
    </li>
  );
}
