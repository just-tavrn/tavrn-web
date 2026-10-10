// SPDX-License-Identifier: Apache-2.0
// The tray icons: the Tauri shell's tray.rs drawing tests on the same logo, and the PNG codec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALPHA_MIN, AMBER, BADGE, GREEN, OUTLINE, RED, TRAY_SIZE, WHITE, badged, decodePng, encodePng, logo, trayIconPng, type Badge } from "./tray_icon.ts";

const BASE = decodePng(readFileSync(fileURLToPath(new URL("../../../desktop/src-tauri/icons/128x128@2x.png", import.meta.url))));
const BADGES: Array<Badge | null> = [null, "connected", "speaking", "muted", "deafened"];

function pixel(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [...rgba.subarray(i, i + 4)];
}

/** A square test image of one colour (the badge is drawn the same at every size). */
function plain(size: number, rgba: readonly number[]): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) out.set(rgba, i * 4);
  return out;
}

/** The bounding box (width, height) of the pixels with an alpha of at least ALPHA_MIN. */
function filled(rgba: Uint8Array, width: number, height: number): [number, number] {
  let [x0, y0, x1, y1] = [width, height, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((pixel(rgba, width, x, y)[3] ?? 0) >= ALPHA_MIN) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
    }
  }
  return [Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

function assertFills(what: string, rgba: Uint8Array, width: number, height: number) {
  const [w, h] = filled(rgba, width, height);
  assert.ok(w * 100 >= width * 85 && h * 100 >= height * 85, `${what}: the logo covers only ${w}×${h} of ${width}×${height}`);
  assert.ok(w * h * 100 >= width * height * 85, `${what}: the logo's box is under 85 % of the canvas`);
}

test("the logo is the Tauri app's 256 px PNG", () => {
  assert.deepEqual([BASE.width, BASE.height, BASE.rgba.length], [256, 256, 256 * 256 * 4]);
});

test("five distinct icons from the logo", () => {
  const base = logo(BASE, TRAY_SIZE);
  const icons = BADGES.map((b) => badged(base, TRAY_SIZE, TRAY_SIZE, b));
  assert.deepEqual(icons[0], base, "not in a voice channel: the plain logo");
  icons.forEach((a, i) => {
    assert.equal(a.length, TRAY_SIZE * TRAY_SIZE * 4);
    for (const b of icons.slice(i + 1)) assert.notDeepEqual(a, b);
    assert.deepEqual(pixel(a, TRAY_SIZE, 8, 8), pixel(base, TRAY_SIZE, 8, 8), "the upper left stays the logo");
  });
});

test("badges stand out at tray sizes on light and dark panels", () => {
  for (const size of [16, 22, 32]) {
    for (const panel of [
      [0xff, 0xff, 0xff, 0xff],
      [0x20, 0x20, 0x20, 0xff],
      [0x1d, 0xe9, 0xb6, 0xff],
    ]) {
      const r = size * BADGE;
      const c = Math.trunc(size - r);
      const offCentre = c - Math.trunc(r * 0.75);
      const draw = (b: Badge) => badged(plain(size, panel), size, size, b);
      assert.deepEqual(pixel(draw("connected"), size, c, c), [...GREEN], `${size}px`);
      assert.deepEqual(pixel(draw("speaking"), size, c, c), [...WHITE], `${size}px: speaking lights the badge up`);
      assert.deepEqual(pixel(draw("muted"), size, c, c), [...WHITE], `${size}px: the bar of muted`);
      assert.deepEqual(pixel(draw("muted"), size, c, offCentre), [...AMBER], `${size}px`);
      assert.deepEqual(pixel(draw("deafened"), size, c, c), [...WHITE], `${size}px: the cross of deafened`);
      assert.deepEqual(pixel(draw("deafened"), size, c, offCentre), [...RED], `${size}px`);
      const edge = Math.trunc(size - 2 * r + 0.6);
      assert.deepEqual(pixel(draw("connected"), size, edge, c), [...OUTLINE], `${size}px outline`);
    }
  }
});

test("the tray logo fills its canvas at tray sizes", () => {
  for (const size of [16, 22, 32]) {
    const rgba = logo(BASE, size);
    assert.equal(rgba.length, size * size * 4);
    assertFills(`${size}px`, rgba, size, size);
    const [w, h] = filled(rgba, size, size);
    assert.ok(Math.max(w, h) + 2 >= size, `${size}px: at most 1 px of margin on the long side (${w}×${h})`);
  }
  const rgba = logo(BASE, 32);
  assert.ok((pixel(rgba, 32, 16, 16)[3] ?? 0) >= ALPHA_MIN, "the centre of the mark");
  assert.ok((pixel(rgba, 32, 0, 0)[3] ?? 0) < ALPHA_MIN, "the corner outside the mark");
});

test("badged tray icons keep the filled logo, and their PNGs decode to the same pixels", () => {
  for (const b of BADGES) {
    const png = trayIconPng(BASE, b);
    const image = decodePng(png);
    assert.deepEqual([image.width, image.height], [TRAY_SIZE, TRAY_SIZE]);
    assertFills(String(b), image.rgba, image.width, image.height);
    assert.deepEqual(image.rgba, badged(logo(BASE, TRAY_SIZE), TRAY_SIZE, TRAY_SIZE, b));
  }
});

test("the PNG codec round-trips and refuses what it cannot read", () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
  assert.deepEqual(decodePng(encodePng({ width: 3, height: 2, rgba })).rgba, rgba);
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
  const rgb = encodePng({ width: 1, height: 1, rgba: new Uint8Array(4) });
  rgb[8 + 8 + 9] = 2; // the colour type in IHDR
  assert.throws(() => decodePng(rgb), /only 8-bit RGBA/);
});
