// SPDX-License-Identifier: Apache-2.0
/**
 * Country flag emojis (tavrn-web#118). Windows' emoji font has no flag glyphs, so a regional-indicator pair shows as
 * two letters ("DE"). When the platform renders ordinary emojis but no flags, a bundled flag-only font (the Twemoji
 * country flags of `country-flag-emoji-polyfill`, MIT; the artwork CC-BY 4.0, see NOTICE) is registered for the
 * flag code points only and `<html data-flag-font>` lets the stylesheet put it first for emoji-bearing text. Every
 * other emoji keeps the platform's font: the face is limited to the regional indicators and the tag characters.
 */

export const FLAG_FONT_FAMILY = "Twemoji Country Flags";
/** Regional indicators, the black flag of tag sequences and the tag characters (England, Scotland, Wales). */
export const FLAG_UNICODE_RANGE = "U+1F1E6-1F1FF, U+1F3F4, U+E0062-E0063, U+E0065, U+E0067, U+E006C, U+E006E, U+E0073-E0074, U+E0077, U+E007F";

const EMOJI_FONTS = '"Twemoji Mozilla", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", "EmojiOne Color", "Android Emoji", sans-serif';

/** What the detection needs from a 2D canvas context (a subset, for tests). */
export interface GlyphCanvas {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  font: string;
  textBaseline: CanvasTextBaseline;
}

function glyphCanvas(doc: Document): GlyphCanvas | null {
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.textBaseline = "top";
  ctx.font = `100px ${EMOJI_FONTS}`;
  ctx.scale(0.01, 0.01);
  return ctx;
}

function pixel(ctx: GlyphCanvas, text: string, fill: string): string {
  ctx.clearRect(0, 0, 100, 100);
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
  return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",");
}

/**
 * Does `text` draw as a colour glyph? A colour emoji ignores the fill colour (the same pixel in white and in black)
 * and is not transparent; a font with no glyph draws letters or a box in the fill colour.
 */
export function drawsAsColorEmoji(ctx: GlyphCanvas, text: string): boolean {
  const white = pixel(ctx, text, "#fff");
  const black = pixel(ctx, text, "#000");
  return white === black && !black.startsWith("0,0,0,");
}

/** The platform renders emojis but no flag (the Windows case); false where flags work or nothing can be drawn. */
export function needsFlagFont(doc: Document = document, make: (doc: Document) => GlyphCanvas | null = glyphCanvas): boolean {
  let ctx: GlyphCanvas | null;
  try {
    ctx = make(doc);
  } catch {
    return false;
  }
  if (!ctx) return false;
  return drawsAsColorEmoji(ctx, "\u{1F60A}") && !drawsAsColorEmoji(ctx, "\u{1F1E8}\u{1F1ED}");
}

interface FontFaceLike {
  load(): Promise<unknown>;
}
type FontFaceCtor = new (family: string, source: string, descriptors?: { unicodeRange?: string; display?: string }) => FontFaceLike;

/**
 * Registers the flag font from `url` for the flag code points and marks the document (`data-flag-font="polyfill"`).
 * Loading happens on first use (`font-display: swap`); the marker is set at once so the stylesheet applies.
 */
export function installFlagFont(url: string, doc: Document = document): boolean {
  const FontFaceImpl = (doc.defaultView as (Window & { FontFace?: FontFaceCtor }) | null)?.FontFace;
  const fonts = (doc as Document & { fonts?: { add(face: FontFaceLike): unknown } }).fonts;
  if (!FontFaceImpl || !fonts) return false;
  const face = new FontFaceImpl(FLAG_FONT_FAMILY, `url(${url})`, { unicodeRange: FLAG_UNICODE_RANGE, display: "swap" });
  fonts.add(face);
  doc.documentElement.setAttribute("data-flag-font", "polyfill");
  return true;
}

/** At start: the flag font only where the platform needs it. Returns whether it was installed. */
export function polyfillFlagEmojis(url: string, doc: Document = document): boolean {
  return needsFlagFont(doc) && installFlagFont(url, doc);
}
