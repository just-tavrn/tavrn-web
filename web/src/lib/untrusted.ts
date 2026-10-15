// SPDX-License-Identifier: Apache-2.0
/**
 * Client-side checks of values a node supplies. Nodes other than the home node are not trusted (in the desktop apps
 * not even the home node serves the client), so values that end up in links, styles or as displayed names are
 * checked here again, whatever the node validated.
 */

/** Bidi embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069): they can reorder a displayed name. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** A name or file name for display: without bidi controls, so it shows its real order. */
export function stripBidi(s: string): string {
  return s.replace(BIDI_CONTROLS, "");
}

/** An absolute `http(s):` or `mailto:` URL, or null (anything else is shown as text, never as a link). */
export function safeLinkUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The host of a link as shown before it opens (embeds, link buttons): in full, an IDN stays in its `xn--` form so a
 * look-alike name cannot pass for another one; a value that is no URL is shown as it is.
 */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A colour as `#rrggbb`, or null (never a CSS value that could load something, such as `url(…)`). */
export function safeColor(c: unknown): string | null {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}
