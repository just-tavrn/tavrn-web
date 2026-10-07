// SPDX-License-Identifier: Apache-2.0
import { useT } from "../i18n";
import { EmojiPicker } from "./EmojiPicker";
import { InlineEmoji } from "./InlineEmoji";

/**
 * The emoji of a soundboard clip (design note 4.13, shown on the player's tile while it plays): a Unicode emoji
 * or a custom emoji token, typed or chosen in the picker; empty = none.
 */
export function SoundEmojiField({ value, onChange, node, label }: { value: string; onChange: (v: string) => void; node: string; label: string }) {
  const t = useT();
  return (
    <span className="flex items-center gap-1">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line bg-bg-0" aria-hidden="true">
        <InlineEmoji value={value} node={node} size={20} />
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        maxLength={300}
        placeholder="🎺"
        aria-label={label}
        className="min-h-8 w-24 min-w-0 rounded-md border border-line bg-bg-0 px-2 text-sm text-fg-0 outline-none focus:border-accent"
        data-testid="sound-emoji-input"
      />
      <EmojiPicker label={t("soundboard.pick_emoji")} onPick={(e) => onChange(e.startsWith(":") ? "" : e)} />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label={t("soundboard.clear_emoji")} className="min-h-8 min-w-6 text-fg-2 hover:text-fg-0">
          ×
        </button>
      )}
    </span>
  );
}
