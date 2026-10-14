// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLAG_FONT_FAMILY, FLAG_UNICODE_RANGE, drawsAsColorEmoji, installFlagFont, needsFlagFont, polyfillFlagEmojis, type GlyphCanvas } from "./flagEmoji";

/** A canvas whose glyphs are given per text: `color` ignores the fill, `text` draws in the fill, `none` draws nothing. */
function fakeCanvas(glyphs: Record<string, "color" | "text" | "none">): GlyphCanvas {
  let drawn = "";
  const ctx: GlyphCanvas = {
    fillStyle: "#000",
    font: "",
    textBaseline: "alphabetic",
    clearRect: () => {
      drawn = "";
    },
    fillText: (text) => {
      drawn = text;
    },
    getImageData: () => {
      const kind = glyphs[drawn] ?? "none";
      if (kind === "none") return { data: [0, 0, 0, 0] };
      if (kind === "color") return { data: [200, 30, 30, 255] };
      return { data: ctx.fillStyle === "#fff" ? [255, 255, 255, 255] : [0, 0, 0, 255] };
    },
  };
  return ctx;
}

describe("country flag emoji fallback (tavrn-web#118)", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-flag-font");
    vi.unstubAllGlobals();
  });

  it("tells colour glyphs from letters and from nothing", () => {
    const ctx = fakeCanvas({ "😊": "color", "🇨🇭": "text" });
    expect(drawsAsColorEmoji(ctx, "😊")).toBe(true);
    expect(drawsAsColorEmoji(ctx, "🇨🇭")).toBe(false);
    expect(drawsAsColorEmoji(ctx, "x")).toBe(false);
  });

  it("needs the font only where emojis draw but flags do not", () => {
    expect(needsFlagFont(document, () => fakeCanvas({ "😊": "color", "🇨🇭": "text" }))).toBe(true);
    expect(needsFlagFont(document, () => fakeCanvas({ "😊": "color", "🇨🇭": "color" }))).toBe(false);
    // No emoji font at all (a text-only platform): nothing to fix with a flag font.
    expect(needsFlagFont(document, () => fakeCanvas({ "😊": "text", "🇨🇭": "text" }))).toBe(false);
    expect(needsFlagFont(document, () => null)).toBe(false);
    expect(
      needsFlagFont(document, () => {
        throw new Error("no canvas");
      }),
    ).toBe(false);
  });

  it("registers the font for the flag code points only and marks the document", () => {
    const added: unknown[] = [];
    const faces: { family: string; source: string; descriptors?: Record<string, string> }[] = [];
    class FontFace {
      constructor(family: string, source: string, descriptors?: Record<string, string>) {
        faces.push({ family, source, descriptors });
      }
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FontFace);
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: (f: unknown) => added.push(f) } });
    expect(installFlagFont("/assets/flags.woff2")).toBe(true);
    expect(faces).toEqual([{ family: FLAG_FONT_FAMILY, source: "url(/assets/flags.woff2)", descriptors: { unicodeRange: FLAG_UNICODE_RANGE, display: "swap" } }]);
    expect(added).toHaveLength(1);
    expect(document.documentElement.getAttribute("data-flag-font")).toBe("polyfill");
    expect(FLAG_UNICODE_RANGE).toContain("U+1F1E6-1F1FF");
    expect(FLAG_UNICODE_RANGE).not.toMatch(/U\+1F60/);
    Object.defineProperty(document, "fonts", { configurable: true, value: undefined });
  });

  it("does nothing without the FontFace API", () => {
    expect(installFlagFont("/assets/flags.woff2")).toBe(false);
    expect(document.documentElement.hasAttribute("data-flag-font")).toBe(false);
  });

  it("polyfills only on a platform without flags", () => {
    // jsdom draws nothing on a canvas: the detection says no, the document stays unmarked.
    expect(polyfillFlagEmojis("/assets/flags.woff2")).toBe(false);
    expect(document.documentElement.hasAttribute("data-flag-font")).toBe(false);
  });
});
