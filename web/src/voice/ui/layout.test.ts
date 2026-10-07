// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TILE_ASPECT, stageLayout } from "./layout";

const ratio = (l: { width: number; height: number }) => l.width / l.height;
/** The whole grid fits into the container. */
const fits = (l: ReturnType<typeof stageLayout>, w: number, h: number, gap = 8) => l.cols * l.width + (l.cols - 1) * gap <= w + 0.5 && l.rows * l.height + (l.rows - 1) * gap <= h + 0.5;

describe("voice stage layout (16:9 tiles)", () => {
  it("one participant: one large 16:9 tile, limited by the shorter side", () => {
    const wide = stageLayout(1, 1200, 500);
    expect(wide).toMatchObject({ cols: 1, rows: 1, scroll: false });
    expect(wide.height).toBeGreaterThanOrEqual(499);
    expect(wide.height).toBeLessThanOrEqual(500);
    expect(ratio(wide)).toBeCloseTo(TILE_ASPECT, 1);
    // A narrow container (the old bug: a tall strip) still gets a 16:9 tile, as wide as possible.
    const narrow = stageLayout(1, 360, 600);
    expect(narrow.width).toBe(360);
    expect(ratio(narrow)).toBeCloseTo(TILE_ASPECT, 1);
  });

  it("two participants: side by side on desktop, stacked on phones", () => {
    const desktop = stageLayout(2, 900, 700);
    expect(desktop).toMatchObject({ cols: 2, rows: 1 });
    expect(ratio(desktop)).toBeCloseTo(TILE_ASPECT, 1);
    expect(fits(desktop, 900, 700)).toBe(true);
    const phone = stageLayout(2, 360, 560);
    expect(phone).toMatchObject({ cols: 1, rows: 2 });
    expect(phone.width).toBe(360);
    expect(fits(phone, 360, 560)).toBe(true);
  });

  it("grows to 2×2, 3×2 and 3×3 on desktop", () => {
    expect(stageLayout(3, 1000, 600)).toMatchObject({ cols: 2, rows: 2 });
    expect(stageLayout(4, 1000, 600)).toMatchObject({ cols: 2, rows: 2 });
    expect(stageLayout(5, 1000, 600)).toMatchObject({ cols: 3, rows: 2 });
    expect(stageLayout(6, 1000, 600)).toMatchObject({ cols: 3, rows: 2 });
    expect(stageLayout(9, 1000, 600)).toMatchObject({ cols: 3, rows: 3 });
    // A very wide container takes more columns.
    expect(stageLayout(4, 2000, 400)).toMatchObject({ cols: 4, rows: 1 });
    for (let n = 1; n <= 12; n++) {
      const l = stageLayout(n, 1000, 600);
      expect(ratio(l), `${n}`).toBeCloseTo(TILE_ASPECT, 1);
      expect(fits(l, 1000, 600), `${n}`).toBe(true);
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(n);
    }
  });

  it("a strip of small tiles next to a focused screen share uses one row while they fit", () => {
    const strip = stageLayout(5, 1000, 140, { minWidth: 120 });
    expect(strip).toMatchObject({ rows: 1, cols: 5, scroll: false });
    expect(ratio(strip)).toBeCloseTo(TILE_ASPECT, 1);
  });

  it("scrolls instead of shrinking tiles below the minimum width", () => {
    const many = stageLayout(30, 800, 300, { minWidth: 160 });
    expect(many.width).toBeGreaterThanOrEqual(160);
    expect(many.scroll).toBe(true);
    expect(many.cols).toBe(4);
    expect(ratio(many)).toBeCloseTo(TILE_ASPECT, 1);
  });

  it("handles an unmeasured container and no tiles", () => {
    expect(stageLayout(0, 800, 600)).toMatchObject({ rows: 0, width: 0 });
    expect(stageLayout(3, 0, 0)).toMatchObject({ width: 0, height: 0 });
  });
});
