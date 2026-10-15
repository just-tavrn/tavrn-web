// SPDX-License-Identifier: Apache-2.0
/**
 * The metrics of a sidebar row (channel list, direct messages, the home links; docs/CLIENT.md "UI conventions"): 16 px
 * medium text on a 20 px line, 8 px gap and side padding, 34 px high on desktop and 44 px with a coarse pointer (touch
 * targets). The kind icon of a row uses the shared `sidebar-icon` size (20 px, styles.css).
 */
const ROW = "flex items-center gap-2 rounded-md px-2 text-base font-medium leading-5";
export const SIDEBAR_ROW = `${ROW} min-h-[34px] pointer-coarse:min-h-11`;

/** A row led by a 32 px avatar (direct messages): 42 px high on desktop, otherwise the same. */
export const SIDEBAR_AVATAR_ROW = `${ROW} min-h-[42px] pointer-coarse:min-h-11`;

/** The colours of a row: the open one, one with news (`strong`), the others. */
export function sidebarRowTone(active: boolean, strong = false): string {
  return active ? "bg-accent-soft text-fg-0" : strong ? "text-fg-0 hover:bg-bg-3/60" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0";
}

/** A category label above a group of rows: 12 px semibold uppercase. */
export const SIDEBAR_CATEGORY = "text-xs font-semibold uppercase tracking-wide text-fg-2";

/** The icon column of a channel row: the 20 px kind icon and the 16 px lock slot (names stay aligned). */
export const SIDEBAR_ICON_SLOT = "flex w-10 shrink-0 items-center gap-1";
