// SPDX-License-Identifier: Apache-2.0
/**
 * Avatars and room icons (design note 4.9). The node stores a still (the first frame) and, for animated
 * uploads, an animated WebP: lists show the still and swap in the animation only while the pointer
 * hovers the avatar (or the link/button around it) or that element has keyboard focus — never on touch,
 * never with `prefers-reduced-motion`. `speaking` forces the animation (voice, design note 4.5 point 6).
 */
import { useEffect, useRef, useState } from "react";
import type { Room, User } from "@tavrn/sdk";
import { avatarBackground, initials } from "../lib/format";
import { apiFor } from "../stores/nodes";
import { DOT_CLASS, useStatus, type PresenceStatus } from "../stores/presence";
import { useAuth } from "../stores/auth";
import { useT } from "../i18n";
import { useNode } from "./NodeScope";
import { reducedMotion } from "../lib/emojis";

/**
 * `active` while the pointer (mouse or pen, not touch) is over the element or its closest interactive
 * ancestor, or that ancestor has keyboard focus.
 */
export function useHoverActive<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const host = (el.closest('a,button,[tabindex]:not([tabindex="-1"])') as HTMLElement | null) ?? el;
    const enter = (e: Event) => {
      if ((e as PointerEvent).pointerType !== "touch") setActive(true);
    };
    const leave = () => setActive(false);
    const focus = () => {
      let visible = true;
      try {
        visible = host.matches(":focus-visible");
      } catch {
        /* older engines: treat any focus as keyboard focus */
      }
      if (visible) setActive(true);
    };
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("focus", focus);
    host.addEventListener("blur", leave);
    return () => {
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("focus", focus);
      host.removeEventListener("blur", leave);
      setActive(false);
    };
  }, [enabled]);
  return { ref, active };
}

export interface MediaAvatarProps {
  /** For the initials and the color when there is no image. */
  name: string;
  /** Absolute URL of the still image. */
  still?: string | null;
  /** Absolute URL of the animated variant. */
  animated?: string | null;
  size?: number;
  /** `circle` for users, `squircle` for rooms. */
  shape?: "circle" | "squircle";
  /** Forces the animation (the user speaks in voice). */
  speaking?: boolean;
  presence?: PresenceStatus | null;
  testId?: string;
}

/** An image avatar with initials fallback, hover animation and an optional presence dot. */
export function MediaAvatar({ name, still, animated, size = 32, shape = "circle", speaking = false, presence, testId }: MediaAvatarProps) {
  const t = useT();
  const { ref, active } = useHoverActive<HTMLSpanElement>(!!animated);
  // The URLs that failed to load: a changed avatar shows again, a failed animation falls back to the still.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const animate = !!animated && !failed.includes(animated) && (active || speaking) && !reducedMotion();
  const radius = shape === "circle" ? "rounded-full" : "rounded-[30%]";
  const dot = Math.max(8, Math.round(size * 0.3));
  const src = animate ? animated : still;
  return (
    <span
      ref={ref}
      aria-hidden={presence ? undefined : "true"}
      className={`relative inline-flex shrink-0 ${speaking ? "rounded-full ring-2 ring-accent" : ""}`}
      style={{ width: size, height: size }}
      data-testid={testId}
      data-animated={animate ? "true" : "false"}
      data-has-animation={animated ? "true" : "false"}
      data-speaking={speaking ? "true" : undefined}
    >
      {src && !failed.includes(src) ? (
        <img src={src} alt="" draggable={false} decoding="async" className={`h-full w-full ${radius} bg-bg-3 object-cover`} onError={() => setFailed((f) => (f.includes(src) ? f : [...f.slice(-3), src]))} data-testid="avatar-image" />
      ) : (
        <span className={`inline-flex h-full w-full items-center justify-center ${radius} font-semibold text-white`} style={{ background: avatarBackground(name), fontSize: size * 0.38 }}>
          {initials(name)}
        </span>
      )}
      {presence && (
        <span
          role="img"
          aria-label={t(`presence.${presence}`)}
          title={t(`presence.${presence}`)}
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-bg-1 ${DOT_CLASS[presence]}`}
          style={{ width: dot, height: dot }}
          data-testid="presence-dot"
          data-status={presence}
        />
      )}
    </span>
  );
}

/** The client of the node an object came from: `node` (a domain) or the current scope. */
function useClient(node?: string | null) {
  const scoped = useNode().api;
  return node === undefined ? scoped : apiFor(node);
}

/** Absolute still/animated URLs of a user's avatar on the node that served the user object. */
export function useAvatarUrls(user: Pick<User, "avatar" | "avatar_still"> | null | undefined, node?: string | null) {
  const client = useClient(node);
  const still = client.mediaUrl(user?.avatar_still);
  const full = client.mediaUrl(user?.avatar);
  return { still, animated: full && full !== still ? full : null };
}

export function UserAvatar({
  user,
  size = 32,
  node,
  presence = false,
  speaking,
  testId,
}: {
  user: Pick<User, "address" | "display_name" | "avatar" | "avatar_still">;
  size?: number;
  /** Domain of the node that served `user` (default: the current scope). */
  node?: string | null;
  /** Show the presence dot. */
  presence?: boolean;
  speaking?: boolean;
  testId?: string;
}) {
  const { still, animated } = useAvatarUrls(user, node);
  const me = useAuth((s) => s.user?.address);
  const status = useStatus(user.address, me);
  return <MediaAvatar name={user.display_name} still={still} animated={animated} size={size} speaking={speaking} presence={presence ? status : null} testId={testId} />;
}

export function RoomIcon({ room, size = 40, node, testId }: { room: Pick<Room, "name"> & { icon?: string | null; icon_still?: string | null }; size?: number; node?: string | null; testId?: string }) {
  const client = useClient(node);
  const still = client.mediaUrl(room.icon_still);
  const full = client.mediaUrl(room.icon);
  return <MediaAvatar name={room.name} still={still} animated={full && full !== still ? full : null} size={size} shape="squircle" testId={testId ?? "room-icon"} />;
}
