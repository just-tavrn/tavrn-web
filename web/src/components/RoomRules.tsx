// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import { renderDocument } from "../lib/markdown";
import { useT } from "../i18n";

/**
 * A room's rules (PROTOCOL.md, `rules`: a Markdown subset like `bio`), rendered with the legal documents' renderer
 * (lib/markdown.ts `renderDocument`: raw HTML escaped, images dropped, safe links only, DOMPurify) and their styles,
 * compact: headings no larger than the text's h3, a scroll box for long rules (focusable, so keys scroll it). `tall`:
 * the room menu's dialog, a bordered box up to most of the screen's height.
 */
export function RoomRules({ markdown, compact = false, tall = false }: { markdown: string; compact?: boolean; tall?: boolean }) {
  const t = useT();
  const html = useMemo(() => renderDocument(markdown), [markdown]);
  return (
    <div
      role="region"
      aria-label={t("invite.rules")}
      tabIndex={0}
      className={`legal-doc room-rules markdown overflow-y-auto break-words text-sm leading-relaxed text-fg-1 ${tall ? "max-h-[60dvh] rounded-md border border-line bg-bg-0 p-3 text-left" : compact ? "max-h-48" : "max-h-64"}`}
      data-testid="room-rules"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
