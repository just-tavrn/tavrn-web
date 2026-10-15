// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useT } from "../i18n";
import { emojiImageUrl, useReducedMotion } from "../lib/emojis";
import { parseEmojiToken } from "../lib/markdown";

/** A custom emoji whose bytes are gone everywhere (design note 4.13): its name in a muted chip. */
export function MissingEmoji({ name }: { name: string }) {
  const t = useT();
  return (
    <span className="emoji-missing" title={t("emoji.unavailable")} data-testid="emoji-missing">
      :{name}:
    </span>
  );
}

/**
 * A Unicode emoji or a custom emoji token (`<:name:ID@host>`, design note 4.13) as a glyph. Images load from `via`
 * (a node the client talks to); tokens without a host belong to `owner` (default `via`), others are served from
 * `via`'s cached copy. Animated custom emojis play unless reduced motion is set (or `still`).
 */
export function InlineEmoji({ value, node, owner, size = 20, still = false }: { value: string | null | undefined; node: string; owner?: string; size?: number; still?: boolean }) {
  const reduced = useReducedMotion();
  const [missing, setMissing] = useState(false);
  if (!value) return null;
  const token = parseEmojiToken(value);
  if (token) {
    if (missing) return <MissingEmoji name={token.name} />;
    return (
      <img
        src={emojiImageUrl(node, token.id, still || reduced, token.host ?? owner ?? node)}
        alt={`:${token.name}:`}
        title={`:${token.name}:`}
        width={size}
        height={size}
        draggable={false}
        className="inline-block object-contain align-middle"
        onError={() => setMissing(true)}
        data-testid="inline-emoji"
      />
    );
  }
  return (
    <span style={{ fontSize: size * 0.9 }} className="emoji-font leading-none" data-testid="inline-emoji">
      {value}
    </span>
  );
}
