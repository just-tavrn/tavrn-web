// SPDX-License-Identifier: Apache-2.0
import type { Reaction } from "@tavrn/sdk";
import { useEmojiContext, useEmojiImage } from "../lib/emojis";
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

export function ReactionBar({ reactions, onToggle, canReact, roomId, customEmojis = [] }: { reactions: Reaction[]; onToggle: (emoji: string, active: boolean) => void; canReact: boolean; roomId?: string; customEmojis?: CustomEmoji[] }) {
  if (reactions.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1" data-testid="reactions">
      {reactions.map((r) => (
        <li key={r.emoji}>
          <button
            type="button"
            aria-pressed={r.me}
            aria-label={`${reactionLabel(r.emoji)} ${r.count}`}
            disabled={!canReact && !r.me}
            onClick={() => onToggle(r.emoji, r.me)}
            className={`flex min-h-7 items-center gap-1 rounded-full border px-2 text-xs ${r.me ? "border-accent/70 bg-accent-soft text-fg-0 hover:border-accent" : "border-line bg-bg-0 text-fg-1 hover:bg-bg-3"}`}
          >
            <EmojiGlyph emoji={r.emoji} roomId={roomId} customEmojis={customEmojis} />
            <span>{r.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

