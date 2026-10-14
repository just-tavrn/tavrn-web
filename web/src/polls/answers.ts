// SPDX-License-Identifier: Apache-2.0
/** How a date poll's yes / maybe / no look: an icon and a colour, always next to the word or its screen reader text. */
import type { Answer } from "./model";

export const ANSWERS = ["yes", "maybe", "no"] as const;
export const ANSWER_ICON: Record<Answer, string> = { yes: "✓", maybe: "?", no: "✗" };
export const ANSWER_CLASS: Record<Answer, string> = {
  yes: "border-ok bg-ok/15 text-fg-0",
  maybe: "border-warn bg-warn/15 text-fg-0",
  no: "border-danger bg-danger/10 text-fg-0",
};
/** The icon's own colour where it stands alone in text (counts). */
export const ANSWER_TEXT: Record<Answer, string> = { yes: "text-ok", maybe: "text-warn", no: "text-danger" };
/** The segments of a slot's totals bar. */
export const ANSWER_BAR: Record<Answer, string> = { yes: "bg-ok", maybe: "bg-warn", no: "bg-danger" };
