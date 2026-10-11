// SPDX-License-Identifier: Apache-2.0
import { ghostNoBots } from "../../lib/botAccess";
import { cleanupConversation, useLabelledGhosts } from "../../lib/leafCleanup";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { Permission, hasPermission, type Channel, type RoomDetail, type User, type VoiceParticipant } from "@tavrn/sdk";
import { useLocale, useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { Button } from "../../components/ui";
import { GhostWarning } from "../../components/E2eeNotices";
import { acknowledgeGhosts } from "../../components/GhostGate";
import { channelName } from "../../lib/names";
import { channelPermissions, useRoomMembers } from "../../pages/ChannelPage";
import { getMls, useMlsUi } from "../../stores/mls";
import { qualify, splitIdentity, type GhostViolation } from "@tavrn/e2ee";
import { participantsOf, useVoicePresence } from "../presence";
import { useVoiceSettings } from "../settings";
import { ownVoiceChannel, useVoice, watchStream } from "../store";
import { joinVoice, loadedSession } from "../index";
import { AvatarTile } from "./AvatarTile";
import { ConnectionGlyph, LevelMeterBars, ParticipantFlags, ScreenBadge, SoundOverlay, levelStyle, useMemberLooks, useParticipantStatus, usePriority } from "./common";
import { ExpandIcon, MegaphoneIcon, PipIcon, SpeakerIcon } from "./icons";
import { FullscreenButton, FullscreenControls, exitFullscreen, useFullscreen, useFullscreenShortcut } from "./fullscreen";
import { StageGrid } from "./StageGrid";
import { StreamAudioControls } from "./StreamAudio";
import { useParticipantMenu } from "./useParticipantMenu";
import { MenuButton, type ContextMenuTrigger } from "../../components/ContextMenu";
import { sortByRank, stableOrder } from "../order";
import { VoiceControls } from "./VoiceControls";
import { WhiteboardButton } from "../../whiteboard/WhiteboardBadge";
import { WhiteboardStageTile, WhiteboardTileOverlay, useStageBoard } from "../../whiteboard/WhiteboardStage";
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

/** Snapshot interval of remote camera tiles, so a dropped camera freezes on its last frame. */
const SNAPSHOT_MS = 2_000;

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
 * A participant's camera or screen video, attached through the LiveKit session. With `snapshot`, a small
 * still is kept every few seconds (cheap, no per-frame work), so that a camera whose connection dropped
 * freezes on its last frame instead of turning black (design note 4.5 item 7).
 */
function VideoView({ identity, source, mirror = false, fit = "auto", onVideo, snapshot = false }: { identity: string; source: "camera" | "screen"; mirror?: boolean; fit?: "cover" | "contain" | "auto"; onVideo?: (el: HTMLVideoElement | null) => void; snapshot?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const still = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState(false);
  // A portrait source (a phone camera held upright) is letterboxed instead of cropped to a thin band.
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setPortrait(el.videoHeight > el.videoWidth * 1.05);
    el.addEventListener("loadedmetadata", on);
    el.addEventListener("resize", on);
    return () => {
      el.removeEventListener("loadedmetadata", on);
      el.removeEventListener("resize", on);
    };
  }, []);
  const contain = fit === "contain" || (fit === "auto" && portrait);
  const present = useVoice((s) => (source === "camera" ? s.media[identity]?.camera : s.media[identity]?.screen) ?? false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !present) return;
    setFrozen(false);
    onVideo?.(el);
    return loadedSession()?.attachVideo(identity, source, el);
  }, [identity, source, present, onVideo]);
  useEffect(() => {
    const el = ref.current;
    const canvas = still.current;
    if (!snapshot || !present || !el || !canvas) return;
    const take = () => {
      if (!el.videoWidth) return;
      canvas.width = 320;
      canvas.height = Math.round((320 * el.videoHeight) / el.videoWidth);
      canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
    };
    const timer = setInterval(take, SNAPSHOT_MS);
    return () => {
      clearInterval(timer);
      take();
      setFrozen(true);
    };
  }, [snapshot, present]);
  const style = mirror ? { transform: "scaleX(-1)" } : undefined;
  return (
    <>
      <video ref={ref} autoPlay playsInline muted className={`h-full w-full bg-black ${contain ? "object-contain" : "object-cover"} ${frozen && !present ? "hidden" : ""}`} style={style} data-testid={`video-${source}`} data-fit={contain ? "contain" : "cover"} />
      {snapshot && <canvas ref={still} className={`h-full w-full ${contain ? "object-contain" : "object-cover"} ${frozen && !present ? "" : "hidden"}`} style={style} data-testid="video-frozen" />}
    </>
  );
}

/**
 * `overlay`: what other features add to the tile (the whiteboard badge and thumbnail, design note 4.10).
 * `menu`: the participant's context menu (right-click, long press, ⋯; voice channels, design note 4.13 item 3).
 * An active priority speaker gets an accent border and a megaphone; a playing soundboard clip its emoji.
 */
export function ParticipantTile({ roomId, tile, menu, overlay }: { roomId?: string; tile: Tile; menu?: ContextMenuTrigger; overlay?: ReactNode }) {
  const t = useT();
  const mirror = useVoiceSettings((s) => s.settings.mirror);
  const priority = usePriority(tile.identity);
  const { status, level } = useParticipantStatus({ identity: tile.identity, connection: tile.connection, muted: tile.flags.muted, server_muted: tile.flags.server_muted });
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
      data-connection={reconnecting ? "reconnecting" : undefined}
      {...menu?.triggerProps}
      style={levelStyle(level)}
    >
      {showCamera ? (
        <VideoView identity={tile.identity} source="camera" mirror={tile.self && mirror} snapshot={!tile.self} fit={fs.active ? "contain" : "auto"} />
      ) : (
        <AvatarTile roomId={roomId} user={tile.user} name={tile.name} address={tile.address} size={72} speaking={speaking} stage />
      )}
      {overlay}
      <SoundOverlay identity={tile.identity} roomId={roomId} />
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
          <ParticipantFlags p={{ ...tile.flags, streaming: false, camera: false }} size={12} />
        </span>
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

/**
 * A screen share: watched while the tile is shown (its audio then stays audible while deafened, issue #20),
 * with the stream's own volume when it carries audio.
 */
export function ScreenTile({ tile, focused, onFocus }: { tile: Tile; focused: boolean; onFocus: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement | null>(null);
  const fs = useFullscreen<HTMLDivElement>();
  const screenAudio = useVoice((s) => !!s.media[tile.identity]?.screenAudio);
  useEffect(() => (tile.self ? undefined : watchStream(tile.identity)), [tile.identity, tile.self]);
  const pip = async () => {
    const el = video.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement === el) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* not supported or not allowed */
    }
  };
  return (
    <div ref={fs.ref} className="relative h-full w-full overflow-hidden rounded-xl border-2 border-line bg-black [&:fullscreen]:rounded-none [&:fullscreen]:border-0" data-testid="screen-tile" data-user={tile.address} data-focused={focused || undefined} data-audio={(screenAudio && !tile.self) || undefined}>
      <VideoView identity={tile.identity} source="screen" fit="contain" onVideo={(el) => (video.current = el)} />
      <div className="absolute inset-x-1.5 top-1.5 flex items-center gap-1.5">
        <ScreenBadge />
        <span className="truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-fg-0">{tile.name}</span>
        <span className="flex-1" />
        {screenAudio && !tile.self && <StreamAudioControls address={tile.address} name={tile.name} />}
        {"pictureInPictureEnabled" in document && document.pictureInPictureEnabled && (
          <button type="button" onClick={() => void pip()} className="min-h-8 min-w-8 rounded-md bg-black/60 text-fg-0" aria-label={t("voice.pip")} title={t("voice.pip")}>
            <PipIcon size={16} className="mx-auto" />
          </button>
        )}
        <FullscreenButton active={fs.active} onToggle={fs.toggle} testId="screen-fullscreen" />
        {!fs.active && (
          <button type="button" onClick={onFocus} className="min-h-8 min-w-8 rounded-md bg-black/60 text-fg-0" aria-label={focused ? t("voice.unfocus") : t("voice.focus")} title={focused ? t("voice.unfocus") : t("voice.focus")} data-testid="screen-focus">
            <ExpandIcon size={16} className="mx-auto" />
          </button>
        )}
      </div>
      {fs.active && <FullscreenControls onExit={fs.toggle} />}
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
 * screen shares as large tiles with focus and picture-in-picture, and the controls. Every tile is 16:9 in a
 * grid sized from the stage and the number of tiles (`layout.ts`); shares, cameras, the whiteboard and the
 * whole stage can go fullscreen (`F`). Phones get a swipeable grid with pages of four and a bottom control bar.
 */
export function VoiceStage({ room, channel }: { room: RoomDetail; channel: Channel }) {
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
  const { look, version: looksVersion } = useMemberLooks(room);
  const locale = useLocale((s) => s.locale);
  const members = useRoomMembers(room.id);
  const memberAddresses = useMemo(() => members.data?.map((m) => m.user.address) ?? null, [members.data]);
  const voiceChannelId = useVoice((s) => ownVoiceChannel(s, domain, room.id));
  const perms = channelPermissions(room, channel.id, me?.id ?? "", voiceChannelId);
  const phone = useIsPhone();
  const [page, setPage] = useState(0);
  const q = qualify(domain, channel.id);
  const connected = status === "connected" || status === "reconnecting";
  const online = useMemo(() => participants.map((p) => p.identity), [participants]);
  const ghosts = useGhosts(q, memberAddresses, connected, online, ghostNoBots(channel, room));
  const acked = useMlsUi((s) => s.ghostAck[q]);
  const ghostAck = ghosts.every((g) => acked?.includes(g.identity));

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
    // Connected in LiveKit but not (yet) reported by the node, the own device included.
    for (const id of Object.keys(media)) {
      if (seen.has(id)) continue;
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
  const screens = tiles.filter((x) => media[x.identity]?.screen);
  // The channel's whiteboard: shown on the presenter's tile, as a large tile once joined (design note 4.10).
  const board = useStageBoard(channel.id, tiles.map((x) => x.identity));
  const [boardFocus, setBoardFocus] = useState(false);
  const overlayOf = (x: Tile) => <WhiteboardTileOverlay channelId={channel.id} identity={x.identity} self={x.self} presenter={board.presenter} />;
  // Fullscreen (polish round 2): the whole stage, the whiteboard, and every share or camera tile on its own.
  const stageFs = useFullscreen<HTMLDivElement>();
  const boardFs = useFullscreen<HTMLDivElement>();
  // `F`: the focused share first, then the whiteboard, then any share, else the whole stage.
  useFullscreenShortcut(() => {
    const body = stageFs.ref.current;
    if (!body) return null;
    const pick = (selector: string) => body.querySelector<HTMLElement>(selector);
    return pick('[data-testid="screen-tile"][data-focused]') ?? pick('[data-testid="whiteboard-frame"]') ?? pick('[data-testid="screen-tile"]') ?? body;
  });

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      <SpeakerIcon size={16} className="text-fg-2" />
      <h1 className="truncate text-sm font-semibold" data-testid="channel-name">
        {channelName(channel)}
      </h1>
      <LockMark size={18} title={t("voice.encrypted")} testId="voice-lock" />
      <span className="ml-auto" />
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
          <Button
            className="min-w-40"
            disabled={status === "joining" || !canConnect || blocked}
            data-testid="voice-join"
            onClick={() => void joinVoice({ domain, roomId: room.id, channelId: channel.id }, { canCreate: hasPermission(perms, Permission.SEND_MESSAGES) })}
          >
            {status === "joining" ? t("voice.status.joining") : t("voice.join")}
          </Button>
          {!canConnect && <p className="text-xs text-fg-2">{t("errors.voice.connect_forbidden")}</p>}
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
  // Phones: screens and participants in pages of four, swiped sideways (CSS scroll snapping, no JS animation).
  const cells = [...screens.filter((x) => x !== focused).map((x) => ({ kind: "screen" as const, tile: x })), ...ordered.map((x) => ({ kind: "person" as const, tile: x }))];
  const pages = Math.max(1, Math.ceil(cells.length / PAGE));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="voice-stage">
      {header}
      {status === "reconnecting" && <div className="border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-fg-1">{t("voice.status.reconnecting")}</div>}
      <GhostWarning ghosts={ghosts} acknowledged={ghostAck} onAcknowledge={() => void getMls().then((m) => acknowledgeGhosts(q, m, ghosts))} />
      <div ref={stageFs.ref} className="relative flex min-h-0 flex-1 flex-col gap-2 bg-bg-0 p-2 md:p-3" data-testid="stage-body">
        {board.visible && (
          <div ref={boardFs.ref} className={`relative min-h-0 bg-bg-0 ${boardFocus || boardFs.active ? "flex-1" : "flex-[3]"}`} data-testid="whiteboard-frame">
            <Suspense fallback={null}>
              <WhiteboardStageTile roomId={room.id} channelId={channel.id} focused={boardFocus} onFocus={() => setBoardFocus((f) => !f)} headerExtra={<FullscreenButton active={boardFs.active} onToggle={boardFs.toggle} className="bg-transparent text-fg-1 hover:bg-bg-3" testId="whiteboard-fullscreen" />} />
            </Suspense>
            {boardFs.active && <FullscreenControls onExit={boardFs.toggle} />}
          </div>
        )}
        {focused && (
          // The focused share: one large 16:9 tile; the others become a strip of small tiles below.
          <StageGrid className="flex-[3]" testId="voice-focus">
            <ScreenTile key={focused.identity} tile={focused} focused onFocus={() => toggleFocus(focused.identity)} />
          </StageGrid>
        )}
        {board.visible && boardFocus ? null : phone ? (
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
                    c.kind === "screen" ? <ScreenTile key={`s-${c.tile.identity}`} tile={c.tile} focused={false} onFocus={() => toggleFocus(c.tile.identity)} /> : <RoomParticipantTile key={c.tile.identity} room={room} channelId={channel.id} tile={c.tile} overlay={overlayOf(c.tile)} />,
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
          <StageGrid className={focused || board.visible ? "h-[clamp(96px,24%,200px)] shrink-0" : "flex-1"} minWidth={focused || board.visible ? 120 : 160} testId="voice-grid">
            {screens
              .filter((x) => x !== focused)
              .map((x) => (
                <ScreenTile key={`s-${x.identity}`} tile={x} focused={false} onFocus={() => toggleFocus(x.identity)} />
              ))}
            {ordered.map((x) => (
              <RoomParticipantTile key={x.identity} room={room} channelId={channel.id} tile={x} overlay={overlayOf(x)} />
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
function RoomParticipantTile({ room, channelId, tile, overlay }: { room: RoomDetail; channelId: string; tile: Tile; overlay?: ReactNode }) {
  const { menu, overlay: menuOverlay } = useParticipantMenu(room, channelId, tile.participant);
  return (
    <>
      <ParticipantTile roomId={room.id} tile={tile} menu={tile.participant ? menu : undefined} overlay={overlay} />
      {menuOverlay}
    </>
  );
}
