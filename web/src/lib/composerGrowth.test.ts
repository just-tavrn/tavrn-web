// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { composerGrowth, GROW_FRACTION, PHONE_MAX_WIDTH, type GrowthInput } from "./composerGrowth";

const base: GrowthInput = { focused: true, dismissed: false, contentHeight: 120, collapsedHeight: 24, chromeHeight: 80, viewport: { width: 1280, height: 800 } };

describe("composerGrowth", () => {
  it("grows with the text while it stays below 40 % of the window height", () => {
    expect(composerGrowth(base)).toEqual({ expanded: true, height: 120 });
    expect(composerGrowth({ ...base, contentHeight: 200.4 })).toEqual({ expanded: true, height: 201 });
  });

  it("caps the overlay (text plus toolbar) at 40 % of the window height", () => {
    const g = composerGrowth({ ...base, contentHeight: 2000 });
    expect(g).toEqual({ expanded: true, height: 800 * GROW_FRACTION - 80 });
    expect(g.height! + base.chromeHeight).toBeLessThanOrEqual(800 * GROW_FRACTION);
  });

  it("stays collapsed without focus, after Escape and with a single line", () => {
    expect(composerGrowth({ ...base, focused: false })).toEqual({ expanded: false, height: null });
    expect(composerGrowth({ ...base, dismissed: true })).toEqual({ expanded: false, height: null });
    expect(composerGrowth({ ...base, contentHeight: 24 })).toEqual({ expanded: false, height: null });
    expect(composerGrowth({ ...base, contentHeight: 0 })).toEqual({ expanded: false, height: null });
  });

  it("does not grow on phones (the on-screen keyboard needs the space)", () => {
    expect(composerGrowth({ ...base, viewport: { width: PHONE_MAX_WIDTH - 1, height: 900 } }).expanded).toBe(false);
    expect(composerGrowth({ ...base, viewport: { width: PHONE_MAX_WIDTH, height: 900 } }).expanded).toBe(true);
  });

  it("stays collapsed when the window leaves no room to grow", () => {
    // 40 % of 250 px = 100 px, minus 80 px chrome = 20 px: less than one line.
    expect(composerGrowth({ ...base, viewport: { width: 1280, height: 250 } }).expanded).toBe(false);
    // A tall picker inside the composer eats the room as well.
    expect(composerGrowth({ ...base, chromeHeight: 400 }).expanded).toBe(false);
  });
});
