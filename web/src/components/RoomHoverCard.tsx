// SPDX-License-Identifier: Apache-2.0
/**
 * The room card of the rail (docs/CLIENT.md "Voice activity in the room rail and the friends list"): icon, name,
 * member and online counts, description, unread state and who is in which voice channel (avatars, at most
 * {@link AVATAR_LIMIT}, then "+n" per channel). Opened by hovering a rail room with a mouse (after
 * {@link HOVER_DELAY_MS}) and at once by keyboard focus; it stays open while the pointer is over it and closes with
 * Escape, blur or leaving both (WCAG 1.4.13: dismissible, hoverable, persistent). Touch devices get the same content
 * as the head of the room's long-press menu ({@link RoomCardContent}). The voice data is the presence store, which
 * only holds channels the user may view.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Member, RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { channelName } from "../lib/names";
import { rectOf, useFloating, type AnchorRect } from "../lib/position";
import { apiFor } from "../stores/nodes";
import { useAuth } from "../stores/auth";
import { statusOf, usePresence } from "../stores/presence";
import { formatCount, useUnread } from "../stores/unread";
import type { Counts } from "../stores/railFolders";
import { useVoicePresence } from "../voice/presence";
import { avatarSlice, roomVoice } from "../voice/roomActivity";
import { localPart } from "../voice/order";
import { ScreenIcon, SpeakerIcon } from "../voice/ui/icons";
import { MediaAvatar, RoomIcon } from "./Avatar";

/** How long the pointer rests on a rail room before its card opens. */
export const HOVER_DELAY_MS = 300;
/** How long the card waits for the pointer to come back (moving from the room onto the card) before it closes. */
export const LEAVE_GRACE_MS = 200;
/** Avatars shown in the card over all voice channels. */
export const AVATAR_LIMIT = 8;

export interface CardRoom {
  id: string;
  name: string;
  icon?: string | null;
  icon_still?: string | null;
  description?: string | null;
}

/** The room detail (shared cache entry with the sidebar and the room menu), fetched while `enabled`. */
function useRoomDetail(room: CardRoom, node: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["room", room.id],
    queryFn: async (): Promise<RoomDetail> => {
      const r = await apiFor(node).rooms.get(room.id);
      useUnread.getState().seed(r.read_states ?? [], node);
      return r;
    },
    enabled,
    staleTime: 30_000,
  });
}

/** The card's content: also the non-interactive head of the room menu on touch devices. */
export function RoomCardContent({ room, node, counts, load = true, inMenu = false }: { room: CardRoom; node: string | null; counts: Counts; load?: boolean; inMenu?: boolean }) {
  const t = useT();
  const homeDomain = useAuth((s) => s.user?.domain ?? "");
  const domain = node ?? homeDomain;
  const detail = useRoomDetail(room, node, load).data;
  const queryClient = useQueryClient();
  // Member entries only when another view loaded them (names, avatars, online count); never fetched for the card.
  const members = queryClient.getQueryData<Member[]>(["members", room.id]);
  const channels = useVoicePresence((s) => s.channels);
  const rooms = useVoicePresence((s) => s.rooms);
  const voice = useMemo(() => roomVoice({ channels, rooms }, domain, room.id), [channels, rooms, domain, room.id]);
  const users = usePresence((s) => s.users);
  const online = members ? members.filter((m) => statusOf(users, m.user.address) !== "offline").length : null;
  const memberCount = detail?.member_count ?? null;
  const description = (detail?.description ?? room.description ?? "").trim();
  const client = apiFor(node);
  const byAddress = useMemo(() => new Map((members ?? []).map((m) => [m.user.address.toLowerCase(), m])), [members]);
  const look = (address: string) => {
    const m = byAddress.get(address.toLowerCase());
    return { name: m ? m.nickname || m.user.display_name : localPart(address), still: m ? client.mediaUrl(m.user.avatar_still) : null };
  };
  const slices = avatarSlice(voice.channels, AVATAR_LIMIT);
  const countLine = counts.mentions > 0 ? t("unread.mentions", { count: formatCount(counts.mentions) }) : (counts.listed ?? 0) > 0 ? t("rail.unread_count", { count: formatCount(counts.listed!) }) : counts.unread > 0 ? t("dm.unread") : null;
  return (
    <div className="w-64 max-w-full text-left" data-testid="room-card-content">
      <div className="flex items-center gap-3">
        <RoomIcon room={room} size={40} node={node} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-fg-0" data-testid="room-card-name">
            {room.name}
          </p>
          {node && <p className="truncate text-xs text-fg-2">{node}</p>}
          {(memberCount !== null || online !== null) && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-1" data-testid="room-card-counts">
              {memberCount !== null && <span>{memberCount === 1 ? t("rail.card.members_one") : t("rail.card.members", { count: memberCount })}</span>}
              {online !== null && (
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
                  {t("rail.card.online", { count: online })}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      {description && (
        <p className="mt-2 line-clamp-3 break-words text-sm text-fg-1" data-testid="room-card-description">
          {description}
        </p>
      )}
      {countLine && (
        <p className={`mt-2 text-xs font-semibold ${counts.mentions > 0 ? "text-danger" : "text-fg-0"}`} data-testid="room-card-unread">
          {countLine}
        </p>
      )}
      {voice.channels.length > 0 && (
        <div className="mt-3 border-t border-line pt-2" data-testid="room-card-voice">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{t("rail.card.voice")}</p>
          {voice.channels.map((c, i) => {
            const channel = detail?.channels.find((x) => x.id === c.channelId);
            const name = channel ? channelName(channel) : t("rail.card.voice_channel");
            const { shown, more } = slices[i]!;
            return (
              <div key={c.channelId} className="mt-1.5" data-testid="room-card-channel" data-channel={c.channelId}>
                <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-0">
                  <SpeakerIcon size={14} className="text-fg-2" />
                  <span className="truncate">{name}</span>
                </p>
                <ul {...(inMenu ? { role: "none" } : { "aria-label": t("voice.channel_label", { name }) })} className="mt-1 flex flex-wrap items-center gap-1">
                  {shown.map((p) => {
                    const l = look(p.user);
                    return (
                      <li key={p.identity} role={inMenu ? "none" : undefined} className="relative" title={l.name} data-testid="room-card-participant" data-user={p.user}>
                        <MediaAvatar name={l.name} still={l.still} size={24} />
                        {p.streaming && (
                          <span aria-hidden="true" className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warn text-bg-0">
                            <ScreenIcon size={9} />
                          </span>
                        )}
                        <span className="sr-only">{p.streaming ? `${l.name}, ${t("rail.card.streams")}` : l.name}</span>
                      </li>
                    );
                  })}
                  {more > 0 && (
                    <li role={inMenu ? "none" : undefined} className="flex h-6 min-w-6 items-center justify-center rounded-full bg-bg-3 px-1 text-[11px] font-semibold text-fg-0" data-testid="room-card-more">
                      <span aria-hidden="true">{t("rail.card.more", { count: more })}</span>
                      <span className="sr-only">{t("rail.card.more_label", { count: more })}</span>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The last pointer press anywhere: a focus right after it came from the pointer, not from the keyboard. */
let lastPress = 0;
if (typeof document !== "undefined") document.addEventListener("pointerdown", () => (lastPress = performance.now()), { capture: true, passive: true });
const pointerFocus = () => lastPress > 0 && performance.now() - lastPress < 600;

/** Trigger handlers and the card element of a rail room (see the module comment). */
export function useRoomHoverCard({ disabled = false }: { disabled?: boolean } = {}) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const trigger = useRef<Element | null>(null);
  const overCard = useRef(false);
  const clear = () => clearTimeout(timer.current);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    overCard.current = false;
    setAnchor(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  // Escape closes the card wherever the focus is (the pointer may rest on the room without focusing it).
  const open = anchor !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);
  const show = (el: Element) => {
    trigger.current = el;
    setAnchor(rectOf(el));
  };
  const leaveSoon = () => {
    clear();
    timer.current = setTimeout(() => {
      if (!overCard.current) setAnchor(null);
    }, LEAVE_GRACE_MS);
  };
  const triggerProps = {
    onPointerEnter: (e: PointerEvent) => {
      if (disabled || e.pointerType === "touch") return;
      clear();
      const el = e.currentTarget;
      timer.current = setTimeout(() => show(el), open ? 0 : HOVER_DELAY_MS);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      leaveSoon();
    },
    onFocus: (e: FocusEvent) => {
      // Keyboard focus (and focus moved by the client) opens it; the focus of a click or tap does not.
      if (disabled || pointerFocus()) return;
      clear();
      show(e.currentTarget);
    },
    onBlur: () => {
      if (!overCard.current) close();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) close();
    },
    onPointerDown: () => close(),
  };
  const cardProps = {
    onPointerEnter: () => {
      overCard.current = true;
      clear();
    },
    onPointerLeave: () => {
      overCard.current = false;
      leaveSoon();
    },
  };
  return { open, anchor, close, triggerProps, cardProps };
}

/** The floating card (portal), right of the rail and inside the viewport. */
export function RoomHoverCard({ id, anchor, cardProps, children }: { id: string; anchor: AnchorRect; cardProps: ReturnType<typeof useRoomHoverCard>["cardProps"]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useFloating(ref, anchor, { prefer: "right", gap: 8 });
  return createPortal(
    <div ref={ref} id={id} role="tooltip" className="z-[65] overflow-y-auto rounded-lg border border-line bg-bg-1 p-3 shadow-xl" style={style} data-testid="room-hover-card" {...cardProps}>
      {children}
    </div>,
    document.body,
  );
}
