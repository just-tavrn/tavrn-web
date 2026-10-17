// SPDX-License-Identifier: Apache-2.0
/**
 * The highlight layer of the composer's styled input (docs/CLIENT.md "The composer"): the same text as the textarea,
 * drawn behind it (the textarea's own text is transparent, its caret, selection, IME, undo and paste stay native)
 * with the Markdown formats applied. Only styles that keep every glyph's width are used, so the caret never drifts:
 * bold is a faux bold (a text shadow), italics an underline cue, code and spoilers a background without padding,
 * quotes a colour and an inset line; the markers stay visible but dimmed. aria-hidden: screen readers read the
 * textarea.
 */
import { forwardRef, useMemo, type CSSProperties } from "react";
import { F, highlight } from "./highlight";

function style(flags: number): { className: string; style?: CSSProperties } {
  const cls: string[] = [];
  if (flags & F.BLOCK) cls.push("cs-block");
  if (flags & F.CODE) cls.push("cs-code");
  if (flags & F.SPOILER) cls.push("cs-spoiler");
  if (flags & F.QUOTE) cls.push("cs-quote");
  if (flags & F.MENTION) cls.push("cs-mention");
  if (flags & F.LINK) cls.push("cs-link");
  if (flags & F.BOLD) cls.push("cs-bold");
  if (flags & F.MARK) cls.push("cs-mark");
  const lines = [flags & (F.ITALIC | F.LINK) ? "underline" : "", flags & F.STRIKE ? "line-through" : ""].filter(Boolean);
  if (!lines.length) return { className: cls.join(" ") };
  return {
    className: cls.join(" "),
    style: { textDecorationLine: lines.join(" "), textDecorationStyle: flags & F.ITALIC && !(flags & F.LINK) ? "dotted" : "solid" },
  };
}

export const StyledLayer = forwardRef<HTMLDivElement, { text: string; mentions?: readonly string[]; className: string }>(function StyledLayer({ text, mentions, className }, ref) {
  const runs = useMemo(() => highlight(text, mentions), [text, mentions]);
  return (
    <div ref={ref} aria-hidden="true" className={`composer-styled-layer ${className}`} data-testid="styled-layer">
      {runs.map((r, i) => {
        if (!r.flags) return r.text;
        const s = style(r.flags);
        return (
          <span key={i} className={s.className} style={s.style}>
            {r.text}
          </span>
        );
      })}
    </div>
  );
});
