// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useId, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Reaction, User } from "@tavrn/sdk";
import { useEmojiContext, useEmojiImage } from "../lib/emojis";
import { useT } from "../i18n";
import { useNode } from "./NodeScope";
import { InlineEmoji } from "./InlineEmoji";
import { parseEmojiToken } from "../lib/markdown";
import type { CustomEmoji } from "./EmojiPicker";

export { EmojiPicker, QUICK_EMOJIS, pickerPosition, type CustomEmoji } from "./EmojiPicker";

/** Accessible name of a reaction: `:name:` for custom emoji tokens. */
export function reactionLabel(emoji: string): string {
  const token = parseEmojiToken(emoji);
  return token ? `:${token.name}:` : emoji;
}

function EmojiGlyph({ emoji, roomId, customEmojis }: { emoji: string; roomId?: string; customEmojis: CustomEmoji[] }) {
  const custom = emoji.startsWith(":") && emoji.endsWith(":") ? customEmojis.find((c) => `:${c.name}:` === emoji) : undefined;
  const url = useEmojiImage(custom && roomId ? roomId : "", custom?.id ?? "");
  const ctx = useEmojiContext();
  const { domain } = useNode();
  const token = parseEmojiToken(emoji);
  if (custom && url) return <img src={url} alt={emoji} className="inline-block h-5 w-5 object-contain" />;
  if (token) return <InlineEmoji value={emoji} node={ctx?.domain ?? domain} />;
  // A larger glyph than the count (18 px, tavrn-web#117); the chip keeps its 28 px height.
  return <span className="emoji-font text-lg leading-none">{emoji}</span>;
}

/** How many reactors a chip's description names; the rest are "and n more". */
export const REACTORS_SHOWN = 10;
const LONG_PRESS_MS = 500;

/**
 * The text describing who reacted: up to {@link REACTORS_SHOWN} names and "and n more" for the rest of `count` (the
 * count may be ahead of or behind the loaded list while reactions change).
 */
export function reactorsText(names: string[], count: number, t: ReturnType<typeof useT>): string {
  const shown = names.slice(0, REACTORS_SHOWN);
  const more = Math.max(0, count - shown.length);
  const list = shown.join(", ");
  if (!list) return more ? t("reactions.more_only", { n: more }) : "";
  return more ? `${list} ${t("reactions.more", { n: more })}` : list;
}

interface ChipProps {
  reaction: Reaction;
  canReact: boolean;
  onToggle: (emoji: string, active: boolean) => void;
  roomId?: string;
  customEmojis: CustomEmoji[];
  conversationId?: string;
  messageId?: string;
  usersById?: ReadonlyMap<string, User>;
}

/**
 * Who reacted, as tooltip and accessible description of a chip: loaded when shown (only open tooltips hold a query),
 * cached per message, emoji and count.
 */
function ReactorsTip({ id, emoji, count, conversationId, messageId, usersById }: { id: string; emoji: string; count: number; conversationId: string; messageId: string; usersById?: ReadonlyMap<string, User> }) {
  const t = useT();
  const { api, domain } = useNode();
  const reactors = useQuery({
    queryKey: ["reactors", domain, conversationId, messageId, emoji, count],
    queryFn: () => api.reactions.list(conversationId, messageId, emoji, { limit: REACTORS_SHOWN }),
    staleTime: 30_000,
    retry: false,
  });
  const name = (address: string, userId: string) => usersById?.get(userId)?.display_name || address.split("@")[0] || address;
  const text = reactors.data
    ? reactorsText(reactors.data.items.map((x) => name(x.user, x.user_id)), count, t)
    : reactors.isError
      ? t("reactions.failed")
      : t("reactions.loading");
  return (
    <div
      id={id}
      role="tooltip"
      data-testid="reactors-tooltip"
      className="absolute bottom-full left-0 z-30 mb-1 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-line bg-bg-1 px-2 py-1 text-xs text-fg-0 shadow-lg"
    >
      {text}
    </div>
  );
}

/**
 * One reaction chip. Hovering, focusing or long-pressing it shows who reacted (PROTOCOL.md §7 "Reactions",
 * {@link ReactorsTip}); Escape, leaving or a touch elsewhere hides it. A long press never toggles the reaction.
 */
function ReactionChip({ reaction: r, canReact, onToggle, roomId, customEmojis, conversationId, messageId, usersById }: ChipProps) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swallowClick = useRef(false);
  const item = useRef<HTMLLIElement>(null);
  const lookup = !!conversationId && !!messageId;
  const shown = open && lookup;
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  // Escape hides it (WCAG 1.4.13); after a long press on touch, the next touch elsewhere does.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (!item.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [shown]);
  const touchStart = (e: ReactTouchEvent) => {
    // The chip's own long press: not the message's context menu.
    e.stopPropagation();
    cancelPress();
    if (!lookup || e.touches.length > 1) return;
    press.current = setTimeout(() => {
      press.current = null;
      swallowClick.current = true;
      setOpen(true);
    }, LONG_PRESS_MS);
  };
  return (
    <li ref={item} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-pressed={r.me}
        aria-label={`${reactionLabel(r.emoji)} ${r.count}`}
        aria-describedby={shown ? tipId : undefined}
        disabled={!canReact && !r.me}
        onClick={(e) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            e.preventDefault();
            return;
          }
          onToggle(r.emoji, r.me);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onTouchStart={touchStart}
        onTouchMove={cancelPress}
        onTouchEnd={cancelPress}
        onTouchCancel={cancelPress}
        onContextMenu={(e) => {
          // A long press on touch must not open the message's menu or the system menu.
          if (swallowClick.current || press.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        style={{ WebkitTouchCallout: "none" }}
        className={`flex min-h-7 items-center gap-1 rounded-full border px-2 text-xs ${r.me ? "border-accent/70 bg-accent-soft text-fg-0 hover:border-accent" : "border-line bg-bg-0 text-fg-1 hover:bg-bg-3"}`}
      >
        <EmojiGlyph emoji={r.emoji} roomId={roomId} customEmojis={customEmojis} />
        <span>{r.count}</span>
      </button>
      {shown && conversationId && messageId && <ReactorsTip id={tipId} emoji={r.emoji} count={r.count} conversationId={conversationId} messageId={messageId} usersById={usersById} />}
    </li>
  );
}

export function ReactionBar({ reactions, onToggle, canReact, roomId, customEmojis = [], conversationId, messageId, usersById }: { reactions: Reaction[]; onToggle: (emoji: string, active: boolean) => void; canReact: boolean; roomId?: string; customEmojis?: CustomEmoji[]; conversationId?: string; messageId?: string; usersById?: ReadonlyMap<string, User> }) {
  if (reactions.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1" data-testid="reactions">
      {reactions.map((r) => (
        <ReactionChip key={r.emoji} reaction={r} canReact={canReact} onToggle={onToggle} roomId={roomId} customEmojis={customEmojis} conversationId={conversationId} messageId={messageId} usersById={usersById} />
      ))}
    </ul>
  );
}
