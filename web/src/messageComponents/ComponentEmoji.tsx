// SPDX-License-Identifier: Apache-2.0
/**
 * The emoji of a button or select option (tavrn-protocol/APPLICATIONS.md §5.10): one Unicode emoji, shown in the
 * emoji font (with the bundled flag font where the platform lacks flags), or a `:shortcode:` looked up in the
 * emojibase shortcodes the client already ships. Never an image a bot could point anywhere.
 */
import { useEffect, useState } from "react";

let table: Promise<Map<string, string>> | null = null;

/** `1F44D` / `1F468-200D-1F4BB` → the emoji. */
const fromHex = (hex: string) => String.fromCodePoint(...hex.split("-").map((h) => parseInt(h, 16)));

/** The shortcode table (`thumbsup` → 👍), loaded once on first use. */
export function loadShortcodes(): Promise<Map<string, string>> {
  table ??= (import("emojibase-data/en/shortcodes/github.json") as unknown as Promise<{ default: Record<string, string | string[]> }>)
    .then((m) => {
      const out = new Map<string, string>();
      for (const [hex, names] of Object.entries(m.default)) {
        for (const name of Array.isArray(names) ? names : [names]) out.set(name, fromHex(hex));
      }
      return out;
    })
    .catch(() => new Map<string, string>());
  return table;
}

const shortcodeName = (v: string) => (/^:[a-z0-9_+-]{1,30}:$/.test(v) ? v.slice(1, -1) : null);

/** The emoji as a glyph (decorative: the control's label names it, or `label` when the control has no text). */
export function ComponentEmoji({ value }: { value: string }) {
  const name = shortcodeName(value);
  const [glyph, setGlyph] = useState<string | null>(name ? null : value);
  useEffect(() => {
    if (!name) {
      setGlyph(value);
      return;
    }
    let alive = true;
    void loadShortcodes().then((t) => alive && setGlyph(t.get(name) ?? null));
    return () => {
      alive = false;
    };
  }, [name, value]);
  if (!glyph) return name ? <span className="emoji-missing shrink-0" aria-hidden="true">{value}</span> : null;
  return (
    <span className="emoji-font shrink-0 text-base leading-none" aria-hidden="true" data-testid="component-emoji">
      {glyph}
    </span>
  );
}

/** The accessible name of an emoji-only control: the shortcode's words or the emoji itself. */
export function emojiName(value: string): string {
  const name = shortcodeName(value);
  return name ? name.replace(/[_-]+/g, " ") : value;
}
