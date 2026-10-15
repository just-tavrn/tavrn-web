// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import type { Role, VoiceParticipant } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { useRoomMembers } from "../../pages/ChannelPage";
import { useSoundOverlays, useSpeaking, useVoice } from "../store";
import { lookOf, memberLooks, type ParticipantLook } from "../order";
import { parseClipEmoji } from "../soundSignal";
import { emojiImageUrl, useEmojiImage, useReducedMotion, useRoomEmojis } from "../../lib/emojis";
import { useNode } from "../../components/NodeScope";
import { participantStatus, type ParticipantStatus } from "../reconnect";
import { setLocalMute, useLocalMute } from "../localMute";
import { HeadphonesOffIcon, MicOffIcon, PlugOffIcon, ScreenIcon, SignalBars, SpeakerOffIcon, VideoIcon } from "./icons";

/**
 * Name, role colour and rank of the room's members by address, like the member list (design note 4.13 item 3):
 * nickname, then display name; unknown addresses show the local part without colour. `version` changes
 * with the member list and the roles (memo dependency).
 */
export function useMemberLooks(room: { id: string; roles: Pick<Role, "id" | "name" | "color" | "position" | "is_everyone">[] }): { look: (address: string) => ParticipantLook; version: unknown } {
  const members = useRoomMembers(room.id);
  const looks = useMemo(() => memberLooks(members.data, room.roles), [members.data, room.roles]);
  return { look: (address: string) => lookOf(looks, address), version: looks };
}

export { localPart } from "../order";

/** Whether `identity` is an active priority speaker of the own call (verified, design note 4.13 item 3). */
export function usePriority(identity: string): boolean {
  return useVoice((s) => !!s.priority[identity]);
}

/** The emoji of the soundboard clip `identity` is playing (design note 4.13 item 3), as an overlay. */
export function SoundOverlay({ identity, roomId, size = 40 }: { identity: string; roomId?: string; size?: number }) {
  const overlay = useSoundOverlays((s) => s.overlays[identity]);
  if (!overlay) return null;
  const parsed = parseClipEmoji(overlay.emoji);
  if (!parsed) return null;
  return (
    <span
      key={overlay.key}
      className="voice-sound pointer-events-none absolute right-2 top-2 z-10 flex items-center justify-center"
      style={{ fontSize: size * 0.8, width: size, height: size }}
      data-testid="sound-overlay"
      aria-hidden="true"
    >
      {parsed.kind === "unicode" ? parsed.text : <CustomEmojiImage roomId={roomId} name={parsed.name} id={parsed.id} node={parsed.node} size={size} />}
    </span>
  );
}

/**
 * A custom emoji by id (the room's, a personal one or another node's, loaded through the voice channel's node and
 * its cached copy, design note 4.13) or by the room's name; nothing when it cannot be resolved here.
 */
function CustomEmojiImage({ roomId, name, id, node, size }: { roomId?: string; name: string; id: string | null; node: string | null; size: number }) {
  const { domain } = useNode();
  const reduced = useReducedMotion();
  if (id && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return <img src={emojiImageUrl(domain, id, reduced, node)} alt="" width={size} height={size} className="object-contain" />;
  return <RoomEmojiByName roomId={roomId} name={name} id={id} size={size} />;
}

function RoomEmojiByName({ roomId, name, id, size }: { roomId?: string; name: string; id: string | null; size: number }) {
  const emojis = useRoomEmojis(roomId ?? "");
  const emojiId = id ?? emojis.data?.find((e) => e.name === name)?.id ?? "";
  const known = !!emojis.data?.some((e) => e.id === emojiId);
  const url = useEmojiImage(known ? (roomId ?? "") : "", known ? emojiId : "");
  return url ? <img src={url} alt="" width={size} height={size} draggable={false} className="object-contain" /> : null;
}

/** Speaking level (0…1) of a participant of the own call; 0 if silent or not in the call. */
export function useLevel(identity: string): number {
  return useSpeaking((s) => s.levels[identity] ?? 0);
}

/** Whether any device of `address` speaks in the own call. */
export function useAddressSpeaking(address: string): boolean {
  return useSpeaking((s) => Object.keys(s.levels).some((id) => id.startsWith(`${address}/`)));
}

/** Whether `address` is muted for this user (`localMute.ts`, issue #124). */
export function useLocalMuted(address: string): boolean {
  return useLocalMute((s) => !!s.muted[address]);
}

/**
 * Display state of a participant (design note 4.5 items 6 and 7) with its speaking level: reconnecting
 * (plug glyph, never speaking), poor connection, speaking (ring) or idle. A participant muted for this user
 * (`user` = their address, issue #124) is never shown speaking: their marker says "muted for you" instead of a
 * ring for a voice that is not heard; `localMuted` tells the caller to show it.
 */
export function useParticipantStatus(p: { identity: string; user?: string; connection?: string | null; muted?: boolean; server_muted?: boolean }): { status: ParticipantStatus; level: number; localMuted: boolean } {
  const level = useLevel(p.identity);
  const quality = useVoice((s) => s.qualities[p.identity]);
  const localMuted = useLocalMuted(p.user ?? "");
  const status = participantStatus(p, quality, localMuted ? 0 : level);
  return { status, level: status === "speaking" ? level : 0, localMuted };
}

/**
 * The "muted for you" marker (issue #124): a speaker with a cross that is also the one-click undo. The accessible
 * name says what the click does, the tooltip what the marker means.
 */
export function LocalMuteMark({ address, name, size = 14, className = "" }: { address: string; name: string; size?: number; className?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded text-warn hover:bg-bg-3 hover:text-fg-0 ${className}`}
      title={`${t("voice.local_mute.muted")} – ${t("voice.local_mute.unmute", { name })}`}
      aria-label={t("voice.local_mute.unmute", { name })}
      data-testid="local-mute-mark"
      onClick={(e) => {
        e.stopPropagation();
        setLocalMute(address, false);
      }}
    >
      <SpeakerOffIcon size={size} />
    </button>
  );
}

/** Connection problems: a softly pulsing amber plug while reconnecting, static amber bars when poor. */
export function ConnectionGlyph({ status, size = 14, className = "" }: { status: ParticipantStatus; size?: number; className?: string }) {
  const t = useT();
  if (status === "reconnecting")
    return (
      <span role="img" className={`voice-plug inline-flex rounded-full bg-bg-0/90 p-0.5 text-warn ${className}`} title={t("voice.connection_problems")} aria-label={t("voice.connection_problems")} data-testid="connection-problems">
        <PlugOffIcon size={size} />
      </span>
    );
  if (status === "poor")
    return (
      <span role="img" className={`inline-flex text-warn ${className}`} title={t("voice.connection_poor")} aria-label={t("voice.connection_poor")} data-testid="connection-poor">
        <SignalBars level={1} />
      </span>
    );
  return null;
}

/** CSS custom property for the speaking indicator (design note 4.5 item 6). */
export const levelStyle = (level: number) => ({ "--level": level }) as React.CSSProperties;

/** Mute, deafen, server mute, stream and camera flags of a participant. */
export function ParticipantFlags({ p, size = 14 }: { p: Pick<VoiceParticipant, "muted" | "deafened" | "server_muted" | "streaming" | "camera">; size?: number }) {
  const t = useT();
  return (
    <span className="flex shrink-0 items-center gap-1 text-fg-2">
      {p.streaming && (
        <span role="img" title={t("voice.flag.streaming")} aria-label={t("voice.flag.streaming")} data-testid="flag-streaming" className="rounded bg-danger-solid px-1 text-[9px] font-bold uppercase leading-4 text-white">
          {t("voice.live")}
        </span>
      )}
      {p.camera && (
        <span role="img" title={t("voice.flag.camera")} aria-label={t("voice.flag.camera")} data-testid="flag-camera">
          <VideoIcon size={size} />
        </span>
      )}
      {p.server_muted ? (
        <span role="img" title={t("voice.flag.server_muted")} aria-label={t("voice.flag.server_muted")} data-testid="flag-server-muted" className="text-danger">
          <MicOffIcon size={size} />
        </span>
      ) : (
        p.muted && (
          <span role="img" title={t("voice.flag.muted")} aria-label={t("voice.flag.muted")} data-testid="flag-muted">
            <MicOffIcon size={size} />
          </span>
        )
      )}
      {p.deafened && (
        <span role="img" title={t("voice.flag.deafened")} aria-label={t("voice.flag.deafened")} data-testid="flag-deafened">
          <HeadphonesOffIcon size={size} />
        </span>
      )}
    </span>
  );
}

/** Screen share marker for tiles. */
export function ScreenBadge() {
  const t = useT();
  return (
    <span className="flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-fg-0">
      <ScreenIcon size={12} /> {t("voice.screen")}
    </span>
  );
}

/** The three-bar level meter next to a speaker's name on the stage (announced as "speaking"). */
export function LevelMeterBars() {
  const t = useT();
  return (
    <span className="voice-meter" role="img" aria-label={t("a11y.speaking")}>
      <span />
      <span />
      <span />
    </span>
  );
}
