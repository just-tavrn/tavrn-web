// SPDX-License-Identifier: Apache-2.0
/**
 * The tray icons, drawn at start from the bundled logo exactly as the Tauri shell draws them (`src-tauri/src/tray.rs`,
 * docs/DESKTOP.md "Tray and close to tray"): the logo (`icons/128x128@2x.png` of the Tauri app) cropped to its visible
 * mark, scaled to fill a 32 px canvas with at most 1 px of margin, and a status badge in the lower right corner (green:
 * in a voice channel; white with a green ring: speaking; amber with a bar: muted; red with a cross: deafened), each with
 * a dark outline. No extra image files. The PNG is decoded and the icons encoded here (RGBA, `node:zlib`), so the
 * pixels do not depend on Chromium's premultiplied bitmaps.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** Size of the tray icons in pixels (the tray scales them: 22–24 px on Linux). */
export const TRAY_SIZE = 32;
/** Pixels with less opacity than this count as transparent margin when the logo is cropped. */
export const ALPHA_MIN = 32;

export type Badge = "connected" | "speaking" | "muted" | "deafened";
type Rgba = readonly [number, number, number, number];

export const OUTLINE: Rgba = [0x0f, 0x17, 0x2a, 0xff];
export const WHITE: Rgba = [0xff, 0xff, 0xff, 0xff];
export const GREEN: Rgba = [0x16, 0xa3, 0x4a, 0xff];
export const BRIGHT_GREEN: Rgba = [0x22, 0xc5, 0x5e, 0xff];
export const AMBER: Rgba = [0xf5, 0x9e, 0x0b, 0xff];
export const RED: Rgba = [0xdc, 0x26, 0x26, 0xff];

/** Radius of the badge relative to the icon size. */
export const BADGE = 0.31;

export interface Image {
  width: number;
  height: number;
  /** RGBA, not premultiplied, row by row. */
  rgba: Uint8Array;
}

/** The logo (RGBA, `width` × `height`) with `badge` in the lower right corner (none: the plain logo). */
export function badged(rgba: Uint8Array, width: number, height: number, badge: Badge | null): Uint8Array {
  const out = new Uint8Array(rgba);
  if (!badge) return out;
  const size = Math.min(width, height);
  const r = size * BADGE;
  const cx = width - r;
  const cy = height - r;
  const outline = Math.max(size / 24, 1);
  const ring = Math.max(size / 12, 1);
  const stroke = Math.max(size / 22, 0.75);
  const mark = r * 0.55;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      let fill: Rgba;
      if (badge === "connected") fill = GREEN;
      else if (badge === "speaking") fill = d > r - outline - ring ? BRIGHT_GREEN : WHITE;
      else if (badge === "muted") fill = AMBER;
      else fill = RED;
      const bar = badge === "muted" && Math.abs(dy) <= stroke && Math.abs(dx) <= mark;
      const cross = badge === "deafened" && Math.abs(dx) <= mark && (Math.abs(dx - dy) <= stroke * 1.2 || Math.abs(dx + dy) <= stroke * 1.2);
      const px = d > r - outline ? OUTLINE : bar || cross ? WHITE : fill;
      out.set(px, (y * width + x) * 4);
    }
  }
  return out;
}

/** The bounding box `[x0, y0, x1, y1]` of the pixels with an alpha of at least {@link ALPHA_MIN} (null: all transparent). */
export function contentBox(rgba: Uint8Array, width: number, height: number): [number, number, number, number] | null {
  let found: [number, number, number, number] | null = null;
  for (let i = 0; i * 4 < rgba.length; i++) {
    if ((rgba[i * 4 + 3] ?? 0) < ALPHA_MIN) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    if (y >= height) break;
    found = found ? [Math.min(found[0], x), Math.min(found[1], y), Math.max(found[2], x + 1), Math.max(found[3], y + 1)] : [x, y, x + 1, y + 1];
  }
  return found;
}

type Rect = readonly [number, number, number, number];

/**
 * Scales the part `src` (x, y, width, height in source pixels) of an RGBA image into the rectangle `dst` of a
 * `size`×`size` canvas by area averaging with premultiplied alpha (no dark fringes at the antialiased edges).
 */
function resample(rgba: Uint8Array, width: number, src: Rect, size: number, dst: Rect): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const sx = src[2] / dst[2];
  const sy = src[3] / dst[3];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ox0 = Math.max(x, dst[0]);
      const oy0 = Math.max(y, dst[1]);
      const ox1 = Math.min(x + 1, dst[0] + dst[2]);
      const oy1 = Math.min(y + 1, dst[1] + dst[3]);
      if (ox1 <= ox0 || oy1 <= oy0) continue;
      const fx0 = src[0] + (ox0 - dst[0]) * sx;
      const fy0 = src[1] + (oy0 - dst[1]) * sy;
      const fx1 = src[0] + (ox1 - dst[0]) * sx;
      const fy1 = src[1] + (oy1 - dst[1]) * sy;
      const acc = [0, 0, 0, 0];
      for (let cy = fy0; cy < fy1; ) {
        const ny = Math.min(Math.floor(cy) + 1, fy1);
        for (let cx = fx0; cx < fx1; ) {
          const nx = Math.min(Math.floor(cx) + 1, fx1);
          const weight = (nx - cx) * (ny - cy);
          const i = (Math.floor(cy) * width + Math.floor(cx)) * 4;
          if (i + 3 < rgba.length) {
            const a = (rgba[i + 3] ?? 0) / 255;
            acc[0]! += (rgba[i] ?? 0) * a * weight;
            acc[1]! += (rgba[i + 1] ?? 0) * a * weight;
            acc[2]! += (rgba[i + 2] ?? 0) * a * weight;
            acc[3]! += a * weight;
          }
          cx = nx;
        }
        cy = ny;
      }
      const area = (fx1 - fx0) * (fy1 - fy0);
      const coverage = (ox1 - ox0) * (oy1 - oy0);
      if (area <= 0 || acc[3]! <= 0) continue;
      const alpha = (acc[3]! / area) * coverage;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.max(0, Math.round(acc[c]! / acc[3]!)));
      out[o + 3] = Math.min(255, Math.max(0, Math.round(alpha * 255)));
    }
  }
  return out;
}

/**
 * The logo as a `size`×`size` RGBA icon: cropped to its visible mark, scaled to fill the canvas with at most 1 px of
 * margin per 32 px (none at 16 and 22 px), centred, aspect ratio kept.
 */
export function logo(base: Image, size: number): Uint8Array {
  const [x0, y0, x1, y1] = contentBox(base.rgba, base.width, base.height) ?? [0, 0, base.width, base.height];
  const bw = x1 - x0;
  const bh = y1 - y0;
  const inner = size - 2 * Math.floor(size / 32);
  const scale = inner / Math.max(bw, bh);
  const dw = bw * scale;
  const dh = bh * scale;
  return resample(base.rgba, base.width, [x0, y0, bw, bh], size, [(size - dw) / 2, (size - dh) / 2, dw, dh]);
}

// ---- PNG (8-bit RGBA, non-interlaced: the Tauri app's icons) ----

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit RGBA PNG without interlacing; anything else throws. */
export function decodePng(png: Uint8Array): Image {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colour !== 6 || interlace !== 0) throw new Error("only 8-bit RGBA PNGs without interlacing");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!width || !height) throw new Error("PNG without a header");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length < height * (stride + 1)) throw new Error("PNG data too short");
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      rgba[y * stride + x] = (line[x]! + pred) & 0xff;
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes RGBA pixels as a PNG (no filtering; the icons are tiny). */
export function encodePng(image: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) raw.set(image.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The PNG of the tray icon with `badge`, from the logo's PNG. */
export function trayIconPng(base: Image, badge: Badge | null, size = TRAY_SIZE): Buffer {
  return encodePng({ width: size, height: size, rgba: badged(logo(base, size), size, size, badge) });
}
