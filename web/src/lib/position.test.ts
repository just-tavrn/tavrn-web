// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { insideViewport, placeFloating, pointAnchor } from "./position";

const desktop = { width: 1280, height: 800 };
const card = { width: 320, height: 440 };
const fits = (p: { left: number; top: number; maxHeight: number; maxWidth: number }, size = card, vp = desktop) =>
  insideViewport(p, { width: Math.min(size.width, p.maxWidth), height: Math.min(size.height, p.maxHeight) }, vp);

describe("placeFloating", () => {
  it("puts a card to the right of its anchor when there is room", () => {
    const p = placeFloating({ left: 100, top: 100, right: 200, bottom: 130 }, card, desktop);
    expect(p).toMatchObject({ left: 208, top: 100, side: "right" });
  });

  it("flips to the left for anchors at the right edge (member list)", () => {
    const p = placeFloating({ left: 1050, top: 300, right: 1270, bottom: 340 }, card, desktop);
    expect(p.side).toBe("left");
    expect(p.left).toBe(1050 - 8 - 320);
    expect(fits(p)).toBe(true);
  });

  it("shifts the card up when the anchor is near the bottom (the clipping bug)", () => {
    const p = placeFloating({ left: 1050, top: 760, right: 1270, bottom: 790 }, card, desktop);
    expect(p.top).toBe(800 - 8 - 440);
    expect(fits(p)).toBe(true);
  });

  it("limits the height of tall cards and keeps them inside", () => {
    const tall = { width: 320, height: 2000 };
    const p = placeFloating({ left: 10, top: 10, right: 50, bottom: 50 }, tall, desktop);
    expect(p.maxHeight).toBe(784);
    expect(p.top).toBe(8);
    expect(fits(p, tall)).toBe(true);
  });

  it("shifts over the anchor when neither side has room (narrow viewports)", () => {
    const vp = { width: 400, height: 700 };
    const p = placeFloating({ left: 40, top: 200, right: 360, bottom: 240 }, card, vp);
    expect(p.left).toBe(400 - 8 - 320);
    expect(fits(p, card, vp)).toBe(true);
  });

  it("clamps the width on phones", () => {
    const vp = { width: 300, height: 600 };
    const p = placeFloating({ left: 0, top: 0, right: 10, bottom: 10 }, card, vp);
    expect(p.maxWidth).toBe(284);
    expect(p.left).toBe(8);
    expect(fits(p, card, vp)).toBe(true);
  });

  it("opens menus below the pointer and flips them above near the bottom", () => {
    const menu = { width: 220, height: 300 };
    expect(placeFloating(pointAnchor(500, 100), menu, desktop, { prefer: "bottom", gap: 0 })).toMatchObject({ left: 500, top: 100, side: "bottom" });
    expect(placeFloating(pointAnchor(500, 700), menu, desktop, { prefer: "bottom", gap: 0 })).toMatchObject({ top: 400, side: "top" });
  });

  it("keeps menus at the right edge inside", () => {
    const p = placeFloating(pointAnchor(1270, 100), { width: 220, height: 300 }, desktop, { prefer: "bottom", gap: 0 });
    expect(p.left).toBe(1280 - 8 - 220);
  });

  it("clamps a menu taller than both sides into the viewport", () => {
    const vp = { width: 400, height: 500 };
    const menu = { width: 200, height: 450 };
    const p = placeFloating(pointAnchor(100, 250), menu, vp, { prefer: "bottom", gap: 0 });
    expect(fits(p, menu, vp)).toBe(true);
  });
});
