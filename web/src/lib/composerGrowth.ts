// SPDX-License-Identifier: Apache-2.0
/**
 * Composer growth on focus (design note 4.13 item 14). While the composer has focus and its text needs more
 * than the collapsed single line, it grows as an overlay anchored at the bottom of the conversation area
 * (it floats above the message list, which keeps its size) up to `GROW_FRACTION` of the viewport height,
 * auto-sized to the text. It does not grow on an empty or one-line input (focus alone changes nothing), on
 * phones (the on-screen keyboard already takes the space) and after Escape until the text changes again.
 */

/** Below this viewport width the composer keeps its single line (Tailwind's `sm` breakpoint). */
export const PHONE_MAX_WIDTH = 640;
/** The expanded composer (text plus its toolbar, chips and reply bar) takes at most this share of the viewport. */
export const GROW_FRACTION = 0.4;

export interface GrowthInput {
  /** Focus is inside the composer (textarea, toolbar or one of its popups). */
  focused: boolean;
  /** Collapsed with Escape; cleared by the next text change. */
  dismissed: boolean;
  /** Height the text needs (the textarea's scroll height at its natural width). */
  contentHeight: number;
  /** Height of the collapsed textarea (one line). */
  collapsedHeight: number;
  /** Everything of the composer that is not the textarea (padding, toolbar, chips, reply bar, pickers). */
  chromeHeight: number;
  viewport: { width: number; height: number };
}

export interface Growth {
  expanded: boolean;
  /** Textarea height in pixels while expanded; `null` keeps the natural single line. */
  height: number | null;
}

const COLLAPSED: Growth = { expanded: false, height: null };

export function composerGrowth(i: GrowthInput): Growth {
  if (!i.focused || i.dismissed || i.viewport.width < PHONE_MAX_WIDTH) return COLLAPSED;
  if (i.contentHeight <= i.collapsedHeight) return COLLAPSED;
  const max = Math.floor(i.viewport.height * GROW_FRACTION) - i.chromeHeight;
  // No room to grow (very low window, or a tall picker open): stay collapsed rather than jump.
  if (max <= i.collapsedHeight) return COLLAPSED;
  return { expanded: true, height: Math.min(Math.ceil(i.contentHeight), max) };
}
