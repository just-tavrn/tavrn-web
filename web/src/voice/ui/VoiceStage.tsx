// SPDX-License-Identifier: Apache-2.0
import { useRoomPreview } from "../../stores/rolePreview";
import { PreviewRights } from "../../components/PreviewRights";
import { ghostNoBots } from "../../lib/botAccess";
import { cleanupConversation, useLabelledGhosts } from "../../lib/leafCleanup";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { Permission, hasPermission, type Channel, type RoomDetail, type User, type VoiceParticipant } from "@tavrn/sdk";
import { useLocale, useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { Button } from "../../components/ui";
import { GhostWarning } from "../../components/E2eeNotices";
import { acknowledgeGhosts, ghostAckId } from "../../components/GhostGate";
import { channelName } from "../../lib/names";
import { channelPermissions, useRoomMembers } from "../../pages/ChannelPage";
import { getMls, useMlsUi } from "../../stores/mls";
import { qualify, splitIdentity, type GhostViolation } from "@tavrn/e2ee";
import { devCount } from "../devCounters";
import { participantsOf, screensOf, sessionStartOf, useVoicePresence } from "../presence";
import { publisherStreams, screenOwner } from "../streams";
import { phoneCameras, useVoiceSettings } from "../settings";
import { ownVoiceChannel, useVoice } from "../store";
import { whisperToAddress } from "../index";
import { useVoiceEngine } from "../engine";
import { joinVoice } from "../index";
import { AvatarTile } from "./AvatarTile";
import { ConnectionGlyph, LevelMeterBars, LocalMuteMark, ParticipantFlags, SoundOverlay, levelStyle, useMemberLooks, useParticipantStatus, usePriority } from "./common";
import { localMutedCount, useLocalMute } from "../localMute";
import { MegaphoneIcon, SpeakerIcon } from "./icons";
import { FullscreenButton, FullscreenControls, exitFullscreen, useFullscreen, useFullscreenShortcut, useHeldInFullscreen } from "./fullscreen";
import { StageGrid } from "./StageGrid";
import { SessionTimer, VoiceStatusLine } from "./VoiceHeaderMeta";
import { ScreenTile, StreamingIndicator } from "./ScreenTile";
import { VideoView } from "./VideoView";
import { useParticipantMenu } from "./useParticipantMenu";
import { MenuButton, type ContextMenuTrigger } from "../../components/ContextMenu";
import { sortByRank, stableOrder } from "../order";
import { VoiceControls } from "./VoiceControls";
import { WhiteboardButton } from "../../whiteboard/WhiteboardBadge";
import { WhiteboardIndicator, WhiteboardLargeTile, WhiteboardPlaceholder, useStageBoard } from "../../whiteboard/WhiteboardStage";
import { LockMark } from "../../components/Badges";

export interface Tile {
  identity: string;
  address: string;
  name: string;
  self: boolean;
  camera: boolean;
  flags: Pick<VoiceParticipant, "muted" | "deafened" | "server_muted" | "streaming" | "camera">;
  /** The node's connection flag (`reconnecting` during the grace period). */
  connection: string;
  participant: VoiceParticipant | null;
  /** The user object for the avatar where there is no room member list (calls). */
  user?: User | null;
  /** Role colour of the name (rooms, design note 4.13 item 3). */
  color?: string | null;
}

/**
 * The stream tiles of other devices' screen publishers (VOICE.md §4b, the Android app): under the owner's user and
 * name, never a participant tile of their own. `nodeScreens` are the node's (`screen_of`), `connected` LiveKit's
 * identities, `self` this device's identity (its own publisher is no tile: the sharer sees the indicator).
 */
export function publisherTiles(nodeScreens: VoiceParticipant[], connected: string[], self: string | null, look: (address: string) => { name: string; color?: string | null; user?: User | null }): Tile[] {
  return publisherStreams(nodeScreens, connected, self).map(({ identity, owner }) => {
    const address = splitIdentity(owner).address;
    const l = look(address);
    return {
      identity,
      address,
      name: l.name,
      color: l.color,
      user: l.user,
      self: false,
      camera: false,
      flags: { muted: true, deafened: false, server_muted: false, streaming: true, camera: false },
      connection: "connected",
      participant: null,
    };
  });
}

/** Tiles per swipe page on phones (VOICE.md §9). */
const PAGE = 4;

export function useIsPhone(): boolean {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/**
 * `menu`: the participant's context menu (right-click, long press, ⋯; voice channels, design note 4.13 item 3).
 * An active priority speaker gets an accent border and a megaphone; a playing soundboard clip its emoji.
 */
export function ParticipantTile({ roomId, tile, menu }: { roomId?: string; tile: Tile; menu?: ContextMenuTrigger }) {
  const t = useT();
  // The own preview is mirrored like a mirror; a phone's back camera films the world, not its user: never mirrored.
  const mirrorSetting = useVoiceSettings((s) => s.settings.mirror);
  const backCamera = useVoiceSettings((s) => s.settings.cameraFacing === "environment" && !s.settings.cameraDeviceId) && phoneCameras();
  const mirror = mirrorSetting && !backCamera;
  const priority = usePriority(tile.identity);
  const whisperTargets = useVoice((s) => s.whispering);
  const whispering = tile.self && whisperTargets.length > 0;
  const receivingWhisper = useVoice((s) => !!s.whisperedBy[tile.identity]);
  const mainMuted = useVoice((s) => !tile.self && !!s.media[tile.identity]?.micMuted);
  const flags = { ...tile.flags, muted: tile.flags.muted || (mainMuted && !receivingWhisper) };
  const canWhisper = useVoice((s) => s.status === "connected" && !s.target?.call && s.canSpeak && !s.muted && !s.deafened && !!s.media[tile.identity]);
  const browserVoice = useVoiceEngine((s) => s.kind === "browser");
  const whisperLabel = receivingWhisper ? t("voice.whisper.receiving", { name: tile.name }) : whispering ? t("voice.whisper.sending", { names: whisperTargets.map((id) => id.split("/")[0]).join(", ") }) : null;
  // The own tile's microphone flag pulses while the user talks muted (issue #125).
  const mutedTalk = useVoice((s) => tile.self && s.mutedTalk);
  const { status, level, localMuted } = useParticipantStatus({ identity: tile.identity, user: tile.self ? undefined : tile.address, connection: tile.connection, muted: flags.muted, server_muted: flags.server_muted });
  const speaking = status === "speaking";
  const reconnecting = status === "reconnecting";
  // A dropped camera keeps its last frame (the node still says `camera` while the participant reconnects).
  const showCamera = tile.camera || (reconnecting && tile.flags.camera);
  const fs = useFullscreen<HTMLDivElement>();
  return (
    <div
      ref={fs.ref}
      className={`voice-tile group/tile relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-xl bg-bg-1 transition-opacity [&:fullscreen]:rounded-none [&:fullscreen]:bg-black ${reconnecting ? "opacity-60" : ""}`}
      data-testid="voice-tile"
      data-user={tile.address}
      data-identity={tile.identity}
      data-speaking={speaking || undefined}
      data-priority={priority || undefined}
      data-whisper={whispering || receivingWhisper || undefined}
      data-local-muted={localMuted || undefined}
      data-muted-talk={mutedTalk || undefined}
      data-connection={reconnecting ? "reconnecting" : undefined}
      {...menu?.triggerProps}
      style={levelStyle(level)}
    >
      {showCamera ? (
        <VideoView identity={tile.identity} source="camera" mirror={tile.self && mirror} snapshot={!tile.self} fit={fs.active ? "contain" : "auto"} />
      ) : (
        <AvatarTile roomId={roomId} user={tile.user} name={tile.name} address={tile.address} size={72} speaking={speaking} stage />
      )}
      <SoundOverlay identity={tile.identity} roomId={roomId} />
      {whisperLabel && <span role="status" className="absolute right-2 top-2 rounded-md bg-bg-0 px-2 text-xs text-accent" data-testid="whisper-indicator"><span aria-hidden="true">↝ </span>{whisperLabel}</span>}
      {!tile.self && canWhisper && <button type="button" disabled={!browserVoice} aria-label={t("voice.whisper.hold", { name: tile.name })} title={!browserVoice ? t("voice.whisper.browser_only") : t("voice.whisper.hold", { name: tile.name })} className="absolute left-2 top-2 z-10 min-h-11 min-w-11 touch-none rounded-md bg-black/60 text-fg-0" data-testid="whisper-hold"
        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); whisperToAddress(tile.address, true); }}
        onPointerUp={(e) => { e.stopPropagation(); whisperToAddress(tile.address, false); }} onPointerCancel={() => whisperToAddress(tile.address, false)} onLostPointerCapture={() => whisperToAddress(tile.address, false)}
        onKeyDown={(e) => { if (!e.repeat && (e.key === " " || e.key === "Enter")) { e.preventDefault(); whisperToAddress(tile.address, true); } }}
        onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); whisperToAddress(tile.address, false); } }} onBlur={() => whisperToAddress(tile.address, false)}>↝</button>}
      {priority && (
        <span role="img"
          className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-text"
          title={t("voice.priority.active", { name: tile.name })}
          aria-label={t("voice.priority.active", { name: tile.name })}
          data-testid="priority-glyph"
        >
          <MegaphoneIcon size={12} />
        </span>
      )}
      {reconnecting && <ConnectionGlyph status={status} size={22} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />}
      {status === "poor" && <ConnectionGlyph status={status} className="absolute right-2 top-2" />}
      {showCamera && <FullscreenButton active={fs.active} onToggle={fs.toggle} className="absolute left-2 top-2 z-10 opacity-0 focus:opacity-100 group-hover/tile:opacity-100 pointer-coarse:opacity-100" testId="tile-fullscreen" />}
      {fs.active && <FullscreenControls onExit={fs.toggle} />}
      <div className="absolute inset-x-1.5 bottom-1.5 flex items-center gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-fg-0">
          {speaking && <LevelMeterBars />}
          <span className="truncate" data-testid="tile-name" style={tile.color ? { color: tile.color } : undefined}>
            {tile.name}
          </span>
          <ParticipantFlags p={{ ...flags, streaming: false, camera: false }} size={12} />
        </span>
        {localMuted && <LocalMuteMark address={tile.address} name={tile.name} className="rounded-md bg-black/60 text-warn hover:bg-black/80" />}
        {menu && (
          <MenuButton
            menu={menu}
            label={t("voice.participant_menu", { name: tile.name })}
            className="ml-auto min-h-7 min-w-7 rounded-md bg-black/60 text-xs text-fg-0 hover:bg-black/80"
            testId="tile-menu-button"
          />
        )}
      </div>
    </div>
  );
}

/** Ghost member check of the channel's group (ENCRYPTION.md §4.6), as in text channels. */
function useGhosts(q: string, members: string[] | null, active: boolean, online: string[], noBots: boolean): GhostViolation[] {
  const [ghosts, setGhosts] = useState<GhostViolation[]>([]);
  const tick = useMlsUi((s) => s.epochs[q] ?? 0);
  const key = members ? members.join(",") : null;
  const onlineKey = online.join(",");
  useEffect(() => {
    if (!active || !members) return;
    let stale = false;
    void getMls().then(async (m) => {
      let found = (await m?.ghostCheck(q, members, { noBots }).catch(() => [])) ?? [];
      // Ghost leaves (deleted devices, own old devices) go right away; the warning follows the roster (§4.7).
      if (found.length) {
        const cleaned = await cleanupConversation(q, { members, mayManage: false, online, noBots }).catch(() => null);
        if (cleaned) found = cleaned.ghosts;
      }
      if (!stale) setGhosts(found);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, key, active, tick, onlineKey, noBots]);
  return useLabelledGhosts(q, active ? ghosts : []);
}

/**
 * The voice view of a voice channel (VOICE.md §9): before joining a join panel with who is there; while
 * connected the stage with one tile per participant (camera or avatar, speaking glow and level meter),
 * screen shares and the whiteboard as tiles of their own that are joined on demand (focus, picture-in-picture), and
 * the controls. Every tile is 16:9 in a grid sized from the stage and the number of tiles (`layout.ts`); shares,
 * cameras, the whiteboard and the whole stage can go fullscreen (`F`). Phones get a swipeable grid with pages of four
 * and a bottom control bar.
 */
export function VoiceStage({ room, channel }: { room: RoomDetail; channel: Channel }) {
  devCount("voice.stage");
  const t = useT();
  const { domain, me } = useNode();
  const status = useVoice((s) => (s.target?.domain === domain && s.target.channelId === channel.id ? s.status : "idle"));
  const error = useVoice((s) => s.error);
  const blocked = useVoice((s) => s.e2eeBlocked);
  const identity = useVoice((s) => s.identity);
  const media = useVoice((s) => s.media);
  const focus = useVoice((s) => s.focus);
  const self = useVoice(useShallow((s) => ({ muted: s.muted, deafened: s.deafened, serverMuted: s.serverMuted, camera: s.camera, screen: s.screen })));
  const participants = useVoicePresence((s) => participantsOf(s, domain, channel.id));
  const screenPublishers = useVoicePresence((s) => screensOf(s, domain, channel.id));
  const { look, version: looksVersion } = useMemberLooks(room);
  const locale = useLocale((s) => s.locale);
  const members = useRoomMembers(room.id);
  const memberAddresses = useMemo(() => members.data?.map((m) => m.user.address) ?? null, [members.data]);
  const voiceChannelId = useVoice((s) => ownVoiceChannel(s, domain, room.id));
  const perms = channelPermissions(room, channel.id, me?.id ?? "", voiceChannelId);
  const preview = useRoomPreview(room.id);
  // Held in fullscreen: a phone turned to landscape keeps the stage's layout, so the stream in fullscreen stays.
  const phone = useHeldInFullscreen(useIsPhone());
  const [page, setPage] = useState(0);
  const q = qualify(domain, channel.id);
  const connected = status === "connected" || status === "reconnecting";
  const online = useMemo(() => participants.map((p) => p.identity), [participants]);
  const ghosts = useGhosts(q, memberAddresses, connected, online, ghostNoBots(channel, room));
  const acked = useMlsUi((s) => s.ghostAck[q]);
  const ghostAck = ghosts.every((g) => acked?.includes(ghostAckId(g)));
  // People of this call muted for this user only (issue #124): a quiet reminder in the header.
  const localMuted = useLocalMute((s) => localMutedCount(s, participants.filter((p) => p.identity !== identity).map((p) => p.user)));

  const tiles = useMemo(() => {
    const out: Tile[] = [];
    const seen = new Set<string>();
    for (const p of participants) {
      seen.add(p.identity);
      const isSelf = p.identity === identity;
      const l = look(p.user);
      out.push({
        identity: p.identity,
        address: p.user,
        name: l.name,
        color: l.color,
        self: isSelf,
        camera: media[p.identity]?.camera ?? false,
        flags: isSelf ? { ...p, muted: self.muted, deafened: self.deafened, server_muted: self.serverMuted } : p,
        connection: isSelf ? "connected" : (p.connection ?? "connected"),
        participant: p,
      });
    }
    // Connected in LiveKit but not (yet) reported by the node, the own device included (screen publishers are streams).
    for (const id of Object.keys(media)) {
      if (seen.has(id) || screenOwner(id)) continue;
      const address = splitIdentity(id).address;
      const isSelf = id === identity;
      const l = look(address);
      out.push({
        identity: id,
        address,
        name: l.name,
        color: l.color,
        self: isSelf,
        camera: media[id]!.camera,
        flags: isSelf ? { muted: self.muted, deafened: self.deafened, server_muted: self.serverMuted, streaming: self.screen, camera: self.camera } : { muted: media[id]!.micMuted, deafened: false, server_muted: false, streaming: media[id]!.screen, camera: media[id]!.camera },
        connection: "connected",
        participant: null,
      });
    }
    return out;
    // `look` changes identity on every render; the member list and the roles are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, media, identity, self.muted, self.deafened, self.serverMuted, self.camera, self.screen, looksVersion]);
  // Sorted by highest role, then name (design note 4.13 item 3); the order changes only when somebody joins or
  // leaves, so tiles never jump while someone speaks or a flag changes.
  const order = useRef<string[] | null>(null);
  order.current = stableOrder(
    order.current,
    tiles.map((x) => x.identity),
    () =>
      sortByRank(
        tiles,
        (x) => look(x.address),
        (x) => x.identity,
        locale,
      ).map((x) => x.identity),
  );
  const sortedTiles = useMemo(() => {
    const byId = new Map(tiles.map((x) => [x.identity, x]));
    return order.current!.map((id) => byId.get(id)!).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, order.current]);
  // Screen publishers of other devices (the Android app, VOICE.md §4b): streams under their owner's name.
  const publishers = useMemo(
    () => publisherTiles(screenPublishers, Object.keys(media), identity, look),
    // `look` changes identity on every render; the member list and the roles are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screenPublishers, media, identity, looksVersion],
  );
  // Every running share is a stream tile (a placeholder until joined); the own one only while its preview is shown.
  const selfPreview = useVoice((s) => s.selfPreview);
  const screens = [...tiles, ...publishers].filter((x) => media[x.identity]?.screen && (!x.self || selfPreview));
  // The channel's whiteboard: a tile of its own like a screen share (a placeholder until joined, then a large tile);
  // the camera tiles stay as they are (design note 4.10, docs/CLIENT.md "Streams are joined").
  const board = useStageBoard(channel.id, tiles.map((x) => x.identity));
  const boardLarge = board.tile === "joined" || board.tile === "preview";
  const boardOwner = board.session ? look(board.session.owner) : null;
  const [boardFocusWanted, setBoardFocus] = useState(false);
  const boardFocus = boardFocusWanted && boardLarge;
  useEffect(() => {
    if (!boardLarge) setBoardFocus(false);
  }, [boardLarge]);
  // Fullscreen (polish round 2): the whole stage, the whiteboard, and every share or camera tile on its own.
  const stageFs = useFullscreen<HTMLDivElement>();
  // `F`: the focused share first, then the joined whiteboard, then any joined share, else the whole stage.
  useFullscreenShortcut(() => {
    const body = stageFs.ref.current;
    if (!body) return null;
    const pick = (selector: string) => body.querySelector<HTMLElement>(selector);
    return pick('[data-testid="screen-tile"][data-focused]') ?? pick('[data-testid="whiteboard-tile"]:not([data-state="available"])') ?? pick('[data-testid="screen-tile"]:not([data-state="available"])') ?? body;
  });

  // The session timer (VOICE.md §5) and the status line (§2a) of the channel, for everybody who sees the stage.
  const sessionStart = useVoicePresence((s) => sessionStartOf(s, domain, channel.id));
  const canSetStatus = hasPermission(perms, Permission.VOICE_STATUS);
  const header = (
    <header className="flex min-h-12 shrink-0 select-none items-center gap-2 border-b border-line px-4 py-1">
      <SpeakerIcon size={16} className="shrink-0 text-fg-2" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold" data-testid="channel-name">
            {channelName(channel)}
          </h1>
          <LockMark size={18} title={t("voice.encrypted")} testId="voice-lock" />
        </div>
        <VoiceStatusLine roomId={room.id} channel={channel} canEdit={canSetStatus} />
      </div>
      {connected && localMuted > 0 && (
        <span className="truncate text-[11px] text-warn" title={t("voice.local_mute.reminder_hint")} data-testid="local-mute-reminder">
          {t("voice.local_mute.reminder", { count: localMuted })}
        </span>
      )}
      <SessionTimer startedAt={sessionStart} className="shrink-0" />
      <WhiteboardButton conversationId={channel.id} encrypted />
      {connected && (
        <span className="text-[11px] text-ok" data-testid="voice-e2ee">
          {t("voice.e2ee_active")}
        </span>
      )}
      {connected && <FullscreenButton active={stageFs.active} onToggle={stageFs.toggle} className="bg-transparent text-fg-2 hover:bg-bg-3 hover:text-fg-0" testId="stage-fullscreen" />}
    </header>
  );

  if (!connected) {
    const canConnect = hasPermission(perms, Permission.CONNECT);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="m-auto w-full max-w-md space-y-4 p-6 text-center" data-testid="voice-join-panel">
          {blocked && (
            <div role="alert" className="rounded-lg border border-danger/50 bg-danger/10 p-3 text-left text-sm text-fg-0" data-testid="voice-e2ee-blocked">
              <p className="font-semibold text-danger">⚠ {t("voice.e2ee_blocked_title")}</p>
              <p className="mt-1 text-xs text-fg-1">{t("voice.error.e2ee_unsupported")}</p>
            </div>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            {participants.map((p) => (
              <div key={p.identity} className="flex w-16 flex-col items-center gap-1">
                <AvatarTile roomId={room.id} name={look(p.user).name} address={p.user} size={44} />
                <span className="w-full truncate text-[11px] text-fg-1" style={look(p.user).color ? { color: look(p.user).color! } : undefined}>
                  {look(p.user).name}
                </span>
              </div>
            ))}
          </div>
          <p className="text-sm text-fg-2">{participants.length ? t("voice.join_hint_people", { count: participants.length }) : t("voice.join_hint_empty")}</p>
          {error && status === "idle" && (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" data-testid="voice-error">
              {error}
            </p>
          )}
          {preview && (
            <PreviewRights
              perms={perms}
              testId="preview-voice-rights"
              rights={[
                { label: t("roleview.voice.connect"), bit: Permission.CONNECT },
                { label: t("roleview.voice.speak"), bit: Permission.SPEAK },
                { label: t("roleview.voice.stream"), bit: Permission.STREAM },
                { label: t("roleview.voice.camera"), bit: Permission.USE_CAMERA },
                { label: t("roleview.voice.soundboard"), bit: Permission.USE_SOUNDBOARD },
                { label: t("roleview.voice.whiteboard"), bit: Permission.USE_WHITEBOARD },
              ]}
            />
          )}
          <Button
            className="min-w-40"
            disabled={status === "joining" || !canConnect || blocked || !!preview}
            data-testid="voice-join"
            onClick={() => void joinVoice({ domain, roomId: room.id, channelId: channel.id }, { canCreate: hasPermission(perms, Permission.SEND_MESSAGES) })}
          >
            {status === "joining" ? t("voice.status.joining") : t("voice.join")}
          </Button>
          {!canConnect && <p className="text-xs text-fg-2">{t("errors.voice.connect_forbidden")}</p>}
          {preview && canConnect && <p className="text-xs text-fg-2">{t("roleview.voice.join_off")}</p>}
          <p className="text-xs text-fg-2">
            <Link to="/settings/voice" className="text-accent hover:underline">
              {t("voice.settings_link")}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const ordered = focus ? sortedTiles.filter((x) => x.identity !== focus) : sortedTiles;
  const focused = focus ? screens.find((x) => x.identity === focus) : undefined;
  const toggleFocus = (id: string) => useVoice.setState((s) => ({ focus: s.focus === id ? null : id }));
  // The whiteboard before joining: a placeholder tile first in the grid, like a stream.
  const boardPlaceholder = board.tile === "available" && boardOwner ? <WhiteboardPlaceholder key="whiteboard" channelId={channel.id} name={boardOwner.name} color={boardOwner.color} /> : null;
  // Phones: the board, screens and participants in pages of four, swiped sideways (CSS scroll snapping, no JS animation).
  const cells = [
    ...(boardPlaceholder ? [{ kind: "board" as const }] : []),
    ...screens.filter((x) => x !== focused).map((x) => ({ kind: "screen" as const, tile: x })),
    ...ordered.map((x) => ({ kind: "person" as const, tile: x })),
  ];
  const pages = Math.max(1, Math.ceil(cells.length / PAGE));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="voice-stage">
      {header}
      {status === "reconnecting" && <div className="border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-fg-1">{t("voice.status.reconnecting")}</div>}
      <GhostWarning ghosts={ghosts} acknowledged={ghostAck} onAcknowledge={() => void getMls().then((m) => acknowledgeGhosts(q, m, ghosts))} />
      <div ref={stageFs.ref} className="relative flex min-h-0 flex-1 flex-col gap-2 bg-bg-0 p-2 md:p-3" data-testid="stage-body">
        <StreamingIndicator />
        <WhiteboardIndicator channelId={channel.id} />
        {(boardLarge || focused) && (
          // The joined whiteboard and the focused share as large tiles, side by side (stacked on phones); the other
          // tiles become a strip of small tiles below. A focused whiteboard takes the whole stage.
          <div className={`flex min-h-0 gap-2 ${boardFocus ? "flex-1" : "flex-[3]"} ${phone ? "flex-col" : "flex-row"}`} data-testid="voice-large">
            {boardLarge && <WhiteboardLargeTile roomId={room.id} channelId={channel.id} name={boardOwner?.name ?? ""} focused={boardFocus} onFocus={() => setBoardFocus((f) => !f)} className="min-w-0 flex-1" />}
            {focused && !boardFocus && (
              <StageGrid className="min-w-0 flex-1" testId="voice-focus">
                <ScreenTile key={focused.identity} tile={focused} focused onFocus={() => toggleFocus(focused.identity)} />
              </StageGrid>
            )}
          </div>
        )}
        {boardFocus ? null : phone ? (
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div
              className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
              data-testid="voice-pages"
              onScroll={(e) => {
                const el = e.currentTarget;
                setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
              }}
            >
              {Array.from({ length: pages }, (_, i) => (
                <StageGrid key={i} className="h-full w-full shrink-0 snap-start px-0.5" testId="voice-page">
                  {cells.slice(i * PAGE, i * PAGE + PAGE).map((c) =>
                    c.kind === "board" ? boardPlaceholder : c.kind === "screen" ? <ScreenTile key={`s-${c.tile.identity}`} tile={c.tile} focused={false} onFocus={() => toggleFocus(c.tile.identity)} /> : <RoomParticipantTile key={c.tile.identity} room={room} channelId={channel.id} tile={c.tile} />,
                  )}
                </StageGrid>
              ))}
            </div>
            {pages > 1 && (
              <div className="flex justify-center gap-1.5 py-1" aria-hidden="true">
                {Array.from({ length: pages }, (_, i) => (
                  <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === page ? "bg-accent" : "bg-fg-2/40"}`} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <StageGrid className={focused || boardLarge ? "h-[clamp(96px,24%,200px)] shrink-0" : "flex-1"} minWidth={focused || boardLarge ? 120 : 160} testId="voice-grid">
            {boardPlaceholder}
            {screens
              .filter((x) => x !== focused)
              .map((x) => (
                <ScreenTile key={`s-${x.identity}`} tile={x} focused={false} onFocus={() => toggleFocus(x.identity)} />
              ))}
            {ordered.map((x) => (
              <RoomParticipantTile key={x.identity} room={room} channelId={channel.id} tile={x} />
            ))}
          </StageGrid>
        )}
        {stageFs.active && <FullscreenControls onExit={() => void exitFullscreen()} />}
      </div>
      <VoiceControls room={room} channel={channel} perms={perms} />
    </div>
  );
}

/** A stage tile of a voice channel with the participant's context menu (design note 4.13 item 3). */
function RoomParticipantTile({ room, channelId, tile }: { room: RoomDetail; channelId: string; tile: Tile }) {
  const { menu, overlay: menuOverlay } = useParticipantMenu(room, channelId, tile.participant);
  return (
    <>
      <ParticipantTile roomId={room.id} tile={tile} menu={tile.participant ? menu : undefined} />
      {menuOverlay}
    </>
  );
}
