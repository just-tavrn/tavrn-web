// SPDX-License-Identifier: Apache-2.0
/**
 * Strips identifying metadata from images before upload (design note 4.13, item 6), losslessly at container
 * level: JPEG segments, PNG chunks and WebP chunks are dropped, the pixel data is copied byte for byte.
 * Detection is by magic bytes, never by name or MIME type. HEIF/AVIF and videos are not rewritten; they only
 * yield warnings (`heif_not_stripped`, `video_location`). Everything else is never touched.
 */

export type MetadataKind = "jpeg" | "png" | "webp" | "heif" | "video" | "other";

export interface StripResult {
  /** The cleaned file (same name, type and lastModified), or the original when nothing changed. */
  file: File;
  /** Short tokens of what was (or would be) removed: `exif`, `xmp`, `iptc`, `comment`, `text`, `time`. */
  removed: string[];
  /** `heif_not_stripped`, `video_location` or `malformed`. */
  warnings: string[];
  kind: MetadataKind;
}

export interface Stripped {
  data: Uint8Array;
  removed: string[];
}

/** Files above this size are never parsed (memory). */
export const MAX_PARSE_BYTES = 200 * 1024 * 1024;
const HEAD_BYTES = 4096;
const MAX_BOXES = 10_000;
const MAX_BOX_DEPTH = 8;
const MAX_IFD_ENTRIES = 1000;

const HEIF_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "mif1", "msf1", "heim", "heis"]);
const QUICKTIME_TOP_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);
const BOX_CONTAINERS = new Set(["moov", "trak", "udta", "meta", "ilst"]);

const EXIF_ID = ascii("Exif\0\0");
const XMP_IDS = [ascii("http://ns.adobe.com/xap/1.0/\0"), ascii("http://ns.adobe.com/xmp/extension/\0")];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP: Record<string, string> = { tEXt: "text", iTXt: "text", zTXt: "text", eXIf: "exif", tIME: "time" };
const WEBP_DROP: Record<string, string> = { EXIF: "exif", "XMP ": "xmp" };

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Latin-1 string of `len` bytes at `off` (box and chunk types; `©` is 0xA9). */
function str(d: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = off; i < off + len && i < d.length; i++) s += String.fromCharCode(d[i]!);
  return s;
}

function startsWith(d: Uint8Array, off: number, prefix: Uint8Array | number[]): boolean {
  if (off + prefix.length > d.length) return false;
  for (let i = 0; i < prefix.length; i++) if (d[off + i] !== prefix[i]) return false;
  return true;
}

const u16be = (d: Uint8Array, o: number) => (d[o]! << 8) | d[o + 1]!;
const u32be = (d: Uint8Array, o: number) => ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0;
const u32le = (d: Uint8Array, o: number) => ((d[o + 3]! << 24) | (d[o + 2]! << 16) | (d[o + 1]! << 8) | d[o]!) >>> 0;

/** Concatenates once (no quadratic copying). */
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Reads a blob; jsdom's File has no `arrayBuffer()`, so FileReader is the fallback. */
export async function readBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

/** Kind by magic bytes of the file head. */
export function detectKind(head: Uint8Array): MetadataKind {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (startsWith(head, 0, PNG_SIGNATURE)) return "png";
  if (str(head, 0, 4) === "RIFF" && str(head, 8, 4) === "WEBP") return "webp";
  if (head.length >= 12 && str(head, 4, 4) === "ftyp") {
    const end = Math.min(Math.max(u32be(head, 0), 12), head.length);
    if (HEIF_BRANDS.has(str(head, 8, 4))) return "heif";
    for (let o = 16; o + 4 <= end; o += 4) if (HEIF_BRANDS.has(str(head, o, 4))) return "heif";
    return "video";
  }
  if (head.length >= 8 && QUICKTIME_TOP_BOXES.has(str(head, 4, 4))) return "video";
  return "other";
}

// ---------------------------------------------------------------------------------------------- JPEG

/** Orientation (1–8) and byte order from an APP1 EXIF payload (`Exif\0\0` + TIFF); null when unreadable. */
function readExifOrientation(payload: Uint8Array): { orientation: number; littleEndian: boolean } | null {
  if (!startsWith(payload, 0, EXIF_ID)) return null;
  const tiff = payload.subarray(EXIF_ID.length);
  if (tiff.length < 8) return null;
  const order = str(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (v.getUint16(2, le) !== 42) return null;
  const ifd = v.getUint32(4, le);
  if (ifd < 8 || ifd + 2 > tiff.length) return null;
  const count = v.getUint16(ifd, le);
  if (count > MAX_IFD_ENTRIES) return null;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return null;
    if (v.getUint16(e, le) !== 0x0112) continue;
    const value = v.getUint16(e + 2, le) === 3 ? v.getUint16(e + 8, le) : 1;
    return { orientation: value >= 1 && value <= 8 ? value : 1, littleEndian: le };
  }
  return { orientation: 1, littleEndian: le };
}

/** Orientation tag of an APP1 EXIF payload (`Exif\0\0` + TIFF), null when there is no readable EXIF. */
export function exifOrientation(payload: Uint8Array): number | null {
  return readExifOrientation(payload)?.orientation ?? null;
}

/** A minimal APP1 segment: TIFF header and IFD0 with only the Orientation entry. */
function orientationSegment(orientation: number, le: boolean): Uint8Array {
  const out = new Uint8Array(36);
  const v = new DataView(out.buffer);
  out[0] = 0xff;
  out[1] = 0xe1;
  v.setUint16(2, 34);
  out.set(EXIF_ID, 4);
  const t = 10;
  out[t] = out[t + 1] = le ? 0x49 : 0x4d;
  v.setUint16(t + 2, 42, le);
  v.setUint32(t + 4, 8, le); // IFD0
  v.setUint16(t + 8, 1, le); // one entry
  v.setUint16(t + 10, 0x0112, le);
  v.setUint16(t + 12, 3, le); // SHORT
  v.setUint32(t + 14, 1, le);
  v.setUint16(t + 18, orientation, le);
  v.setUint32(t + 22, 0, le); // no next IFD
  return out;
}

const MPF_ID = ascii("MPF\0");

function jpegToken(marker: number, payload: Uint8Array): string | null {
  // APP2 "MPF": index of further images appended after the main one (they carry their own EXIF).
  if (marker === 0xe2 && startsWith(payload, 0, MPF_ID)) return "trailer";
  if (marker === 0xe1) {
    if (startsWith(payload, 0, EXIF_ID)) return "exif";
    if (XMP_IDS.some((id) => startsWith(payload, 0, id))) return "xmp";
    return null;
  }
  if (marker === 0xed) return "iptc";
  if (marker === 0xfe) return "comment";
  return null;
}

/**
 * Drops EXIF/XMP APP1, APP13 (IPTC) and COM segments before the first SOS; the rest (from SOS on) is copied
 * verbatim. A non-default EXIF orientation is kept in a minimal EXIF segment. Null when malformed.
 */
export function stripJpeg(data: Uint8Array): Stripped | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [data.subarray(0, 2)];
  const removed = new Set<string>();
  let insertAt = 1;
  let exif: { orientation: number; littleEndian: boolean } | null = null;
  let pos = 2;
  for (;;) {
    if (pos >= data.length || data[pos] !== 0xff) return null;
    const start = pos;
    while (pos < data.length && data[pos] === 0xff) pos++; // fill bytes
    if (pos >= data.length) return null;
    const marker = data[pos++]!;
    if (marker === 0x00) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(data.subarray(start, pos)); // standalone (TEM, RSTn)
      continue;
    }
    if (marker === 0xd9) {
      parts.push(data.subarray(start));
      break;
    }
    if (pos + 2 > data.length) return null;
    const len = u16be(data, pos);
    if (len < 2 || pos + len > data.length) return null;
    const end = pos + len;
    if (marker === 0xda) {
      // Copy up to the end of the main image: in entropy-coded data 0xFF is followed by 0x00 or RSTn only, so
      // the first FF D9 is its EOI. Data after it (MPF secondary images, depth maps, gain maps, any appended
      // file) can carry its own EXIF with a location and is dropped.
      let eoi = -1;
      for (let i = end; i + 1 < data.length; i++) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) {
          eoi = i + 2;
          break;
        }
      }
      if (eoi > 0 && eoi < data.length) {
        parts.push(data.subarray(start, eoi));
        removed.add("trailer");
      } else parts.push(data.subarray(start));
      break;
    }
    const payload = data.subarray(pos + 2, end);
    const token = jpegToken(marker, payload);
    if (token) {
      removed.add(token);
      if (token === "exif" && !exif) exif = readExifOrientation(payload) ?? { orientation: 1, littleEndian: false };
    } else {
      const directlyAfterSoi = parts.length === insertAt;
      parts.push(data.subarray(start, end));
      if (marker === 0xe0 && directlyAfterSoi) insertAt = parts.length;
    }
    pos = end;
  }
  if (removed.size === 0) return { data, removed: [] };
  if (exif && exif.orientation !== 1) parts.splice(insertAt, 0, orientationSegment(exif.orientation, exif.littleEndian));
  return { data: concat(parts), removed: [...removed] };
}

// ----------------------------------------------------------------------------------------------- PNG

/** Drops tEXt/iTXt/zTXt, eXIf and tIME chunks; output ends with IEND. Null when malformed. */
export function stripPng(data: Uint8Array): Stripped | null {
  if (!startsWith(data, 0, PNG_SIGNATURE)) return null;
  const parts: Uint8Array[] = [data.subarray(0, 8)];
  const removed = new Set<string>();
  let pos = 8;
  for (;;) {
    if (pos + 12 > data.length) return null;
    const len = u32be(data, pos);
    if (len > 0x7fffffff || pos + 12 + len > data.length) return null;
    const type = str(data, pos + 4, 4);
    const end = pos + 12 + len;
    const token = PNG_DROP[type];
    if (token) removed.add(token);
    else parts.push(data.subarray(pos, end));
    pos = end;
    if (type === "IEND") break;
  }
  if (removed.size === 0) return { data, removed: [] };
  return { data: concat(parts), removed: [...removed] };
}

// ---------------------------------------------------------------------------------------------- WebP

/** Drops EXIF and XMP chunks, clears their VP8X flags and rewrites the RIFF size. Null when malformed. */
export function stripWebp(data: Uint8Array): Stripped | null {
  if (data.length < 12 || str(data, 0, 4) !== "RIFF" || str(data, 8, 4) !== "WEBP") return null;
  const riffEnd = 8 + u32le(data, 4);
  if (riffEnd < 12 || riffEnd > data.length) return null;
  const kept: { fourcc: string; bytes: Uint8Array }[] = [];
  const removed = new Set<string>();
  let pos = 12;
  let chunks = 0;
  while (pos < riffEnd) {
    if (riffEnd - pos < 8 || ++chunks > MAX_BOXES) return null;
    const fourcc = str(data, pos, 4);
    const size = u32le(data, pos + 4);
    if (size > riffEnd - pos - 8) return null;
    const end = Math.min(pos + 8 + size + (size & 1), riffEnd); // pad byte may be missing at the very end
    const token = WEBP_DROP[fourcc];
    if (token) removed.add(token);
    else kept.push({ fourcc, bytes: data.subarray(pos, end) });
    pos = end;
  }
  if (removed.size === 0) return { data, removed: [] };
  const parts: Uint8Array[] = [new Uint8Array(12)];
  for (const chunk of kept) {
    if (chunk.fourcc === "VP8X" && chunk.bytes.length > 8) {
      const copy = chunk.bytes.slice();
      copy[8] = copy[8]! & ~0x0c; // EXIF (0x08) and XMP (0x04) flags
      parts.push(copy);
    } else parts.push(chunk.bytes);
  }
  const out = concat(parts);
  out.set(data.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { data: out, removed: [...removed] };
}

// --------------------------------------------------------------------------------------------- Video

/** QuickTime `meta` has no version/flags, ISO `meta` is a FullBox: find where its children start. */
function metaChildren(d: Uint8Array, body: number, end: number): number {
  if (end - body >= 8 && str(d, body + 4, 4) === "hdlr") return body;
  if (end - body >= 12 && str(d, body + 8, 4) === "hdlr") return body + 4;
  return end - body >= 4 && u32be(d, body) === 0 ? body + 4 : body;
}

/** `keys` (FullBox, entry count, entries of size + namespace + name): any key naming a location? */
function keysHaveLocation(d: Uint8Array, body: number, end: number): boolean {
  if (end - body < 8) return false;
  const count = u32be(d, body + 4);
  let p = body + 8;
  for (let i = 0; i < count && i < MAX_BOXES && end - p >= 8; i++) {
    const size = u32be(d, p);
    if (size < 8 || size > end - p) return false;
    if (str(d, p + 8, size - 8).toLowerCase().includes("location")) return true;
    p += size;
  }
  return false;
}

function walkBoxes(d: Uint8Array, start: number, end: number, depth: number, state: { boxes: number; location: boolean }): boolean {
  let pos = start;
  while (end - pos >= 8) {
    if (++state.boxes > MAX_BOXES) return false;
    let size = u32be(d, pos);
    const type = str(d, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (end - pos < 16) return false;
      const high = u32be(d, pos + 8);
      if (high >= 0x200000) return false; // beyond 2^53
      size = high * 2 ** 32 + u32be(d, pos + 12);
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || size > end - pos) return false;
    const body = pos + header;
    const boxEnd = pos + size;
    if (type === "©xyz" || type === "loci") state.location = true;
    else if (type === "keys") {
      if (keysHaveLocation(d, body, boxEnd)) state.location = true;
    } else if (BOX_CONTAINERS.has(type) && depth < MAX_BOX_DEPTH) {
      const children = type === "meta" ? metaChildren(d, body, boxEnd) : body;
      if (!walkBoxes(d, children, boxEnd, depth + 1, state)) return false;
    }
    pos = boxEnd;
  }
  return true; // fewer than 8 trailing bytes (QuickTime terminators) are ignored
}

/** Walks an MP4/MOV box tree for location boxes (`©xyz`, `loci`, location keys). Null when malformed. */
export function scanMp4(data: Uint8Array): { location: boolean } | null {
  const state = { boxes: 0, location: false };
  return walkBoxes(data, 0, data.length, 0, state) ? { location: state.location } : null;
}

/** Reads only the top-level box headers and the `moov`/`udta`/`meta` boxes, never the media data. */
async function scanVideoFile(file: File): Promise<{ location: boolean } | null> {
  let pos = 0;
  let boxes = 0;
  let location = false;
  while (file.size - pos >= 8) {
    if (++boxes > MAX_BOXES) return null;
    const h = await readBytes(file.slice(pos, pos + 16));
    let size = u32be(h, 0);
    const type = str(h, 4, 4);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) return null;
      const high = u32be(h, 8);
      if (high >= 0x200000) return null;
      size = high * 2 ** 32 + u32be(h, 12);
      header = 16;
    } else if (size === 0) size = file.size - pos;
    if (size < header || size > file.size - pos) return null;
    if ((type === "moov" || type === "udta" || type === "meta") && size <= MAX_PARSE_BYTES) {
      const result = scanMp4(await readBytes(file.slice(pos, pos + size)));
      if (!result) return null;
      location ||= result.location;
    }
    pos += size;
  }
  return { location };
}

// ----------------------------------------------------------------------------------------------- API

async function analyse(file: File, apply: boolean): Promise<StripResult> {
  let kind: MetadataKind = "other";
  const untouched = (warnings: string[] = []): StripResult => ({ file, removed: [], warnings, kind });
  try {
    kind = detectKind(await readBytes(file.slice(0, HEAD_BYTES)));
    if (kind === "other") return untouched();
    if (kind === "heif") return untouched(["heif_not_stripped"]);
    if (kind === "video") {
      const scan = await scanVideoFile(file);
      return untouched(!scan ? ["malformed"] : scan.location ? ["video_location"] : []);
    }
    if (file.size > MAX_PARSE_BYTES) return untouched();
    const data = await readBytes(file);
    const result = kind === "jpeg" ? stripJpeg(data) : kind === "png" ? stripPng(data) : stripWebp(data);
    if (!result) return untouched(["malformed"]);
    if (result.removed.length === 0) return untouched();
    const cleaned = apply
      ? new File([result.data as Uint8Array<ArrayBuffer>], file.name, { type: file.type, lastModified: file.lastModified })
      : file;
    return { file: cleaned, removed: result.removed, warnings: [], kind };
  } catch {
    return untouched(["malformed"]);
  }
}

/** Only inspects (no changes): what would be removed, plus warnings. Used for the "ask when found" mode. */
export async function inspectMetadata(file: File): Promise<StripResult> {
  return analyse(file, false);
}

/** Strips image metadata; returns the original file (identity) when nothing was removed or on any problem. */
export async function stripImageMetadata(file: File): Promise<StripResult> {
  return analyse(file, true);
}
