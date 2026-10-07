// SPDX-License-Identifier: Apache-2.0
/**
 * Attachment safety in the client (design note 4.12): when an image preview may load by itself, which files may
 * be shown inline at all, and the content type an object URL gets.
 *
 * - SVG can carry scripts: it is never rendered inline nor opened as a document, only downloaded.
 * - Image previews load automatically only if the user's `auto_preview` setting allows it for the author
 *   (always / friends and members of shared rooms / never) and the file is at most the node's
 *   `preview_auto_max_bytes`; otherwise a placeholder with a "load" button is shown.
 */

export type AutoPreview = "always" | "friends_and_shared" | "never";

export const AUTO_PREVIEW_VALUES: readonly AutoPreview[] = ["always", "friends_and_shared", "never"];
export const DEFAULT_AUTO_PREVIEW: AutoPreview = "friends_and_shared";
/** The node default of `TAVRN_PREVIEW_AUTO_MAX_BYTES` (used until the node says otherwise). */
export const DEFAULT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export function isAutoPreview(v: unknown): v is AutoPreview {
  return typeof v === "string" && (AUTO_PREVIEW_VALUES as readonly string[]).includes(v);
}

const baseMime = (mime: string) => (mime.split(";")[0] ?? "").trim().toLowerCase();

/** SVG by type or file name (the sender of an encrypted attachment declares both). */
export function isSvg(mime: string, name = ""): boolean {
  return baseMime(mime) === "image/svg+xml" || /\.svgz?\s*$/i.test(name);
}

/**
 * The type an object URL of a downloaded attachment gets: raster images, audio and video keep theirs;
 * everything else (SVG, HTML, XML, unknown types) becomes `application/octet-stream`, so that opening the
 * URL can never render active content in the client's origin.
 */
export function safeBlobType(mime: string, name = ""): string {
  const m = baseMime(mime);
  if (isSvg(m, name)) return "application/octet-stream";
  if (/^(image|audio|video)\/[a-z0-9.+-]+$/.test(m)) return m;
  return "application/octet-stream";
}

export interface PreviewInput {
  /** The user's setting. */
  setting: AutoPreview;
  /** Plaintext size of the attachment in bytes. */
  size: number;
  /** The node's `preview_auto_max_bytes` (0 = never automatically). */
  maxBytes: number;
  /** The viewer wrote the message. */
  own: boolean;
  /** The message is in a room channel: every author is a member of a room shared with the viewer. */
  inRoom: boolean;
  /** The author is one of the viewer's friends. */
  friend: boolean;
}

/** May an image preview load without a click? Larger than the cap: never; then the user's setting. */
export function shouldAutoPreview(p: PreviewInput): boolean {
  if (p.setting === "never") return false;
  if (!(p.maxBytes > 0 && p.size <= p.maxBytes)) return false;
  if (p.setting === "always") return true;
  return p.own || p.inRoom || p.friend;
}
