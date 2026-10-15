// SPDX-License-Identifier: Apache-2.0
/**
 * The emoji of a button or select option (tavrn-protocol/APPLICATIONS.md §5.10.1): one Unicode emoji, shown in the
 * emoji font (with the bundled flag font where the platform lacks flags), or `:name:` of one of the room's custom
 * emojis, served by the conversation's node like every custom emoji. Never an image a bot could point anywhere: an
 * unknown name stays text.
 */
import { emojiImageUrl, useEmojiContext, useReducedMotion } from "../lib/emojis";

const customName = (v: string) => (/^:[a-z0-9_]{2,30}:$/.test(v) ? v.slice(1, -1) : null);

/** The emoji as a glyph (decorative: the control's label names it, or {@link emojiName} when it has no text). */
export function ComponentEmoji({ value }: { value: string }) {
  const ctx = useEmojiContext();
  const reduced = useReducedMotion();
  const name = customName(value);
  if (!name) {
    return (
      <span className="emoji-font shrink-0 text-base leading-none" aria-hidden="true" data-testid="component-emoji">
        {value}
      </span>
    );
  }
  const emoji = ctx?.roomEmojis.find((e) => e.name === name);
  if (!emoji || !ctx) {
    return (
      <span className="emoji-missing shrink-0" aria-hidden="true" data-testid="component-emoji">
        {value}
      </span>
    );
  }
  return <img src={emojiImageUrl(ctx.domain, emoji.id, reduced)} alt="" aria-hidden="true" width={18} height={18} className="shrink-0 object-contain" data-testid="component-emoji" />;
}

/** The accessible name of an emoji-only control: the custom emoji's name or the emoji itself. */
export function emojiName(value: string): string {
  const name = customName(value);
  return name ? name.replace(/_+/g, " ") : value;
}
