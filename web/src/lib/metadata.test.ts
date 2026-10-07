// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { exifOrientation, inspectMetadata, MAX_PARSE_BYTES, readBytes, scanMp4, stripImageMetadata, stripJpeg, stripPng, stripWebp } from "./metadata";

// Hand-built fixtures: small byte builders, no binary files.

type Bytes = Uint8Array | number[] | string;

function bytes(...parts: Bytes[]): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((p) => (typeof p === "string" ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function indexOf(hay: Uint8Array, needle: Bytes): number {
  const n = bytes(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

const contains = (hay: Uint8Array, needle: Bytes) => indexOf(hay, needle) >= 0;

function file(data: Uint8Array<ArrayBuffer>, name = "x.bin", type = "application/octet-stream"): File {
  return new File([data], name, { type, lastModified: 1_700_000_000_000 });
}

// --- JPEG

const seg = (marker: number, ...payload: Bytes[]) => {
  const p = bytes(...payload);
  return bytes([0xff, marker], be16(p.length + 2), p);
};

/** TIFF with IFD0 = Make "Cam", Orientation, GPS pointer; GPS IFD = LatitudeRef "N". */
function tiff(le: boolean, orientation: number): Uint8Array {
  const out = new Uint8Array(68);
  const v = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  v.setUint16(8, 3, le);
  const entry = (at: number, tag: number, type: number, count: number, value: (o: number) => void) => {
    v.setUint16(at, tag, le);
    v.setUint16(at + 2, type, le);
    v.setUint32(at + 4, count, le);
    value(at + 8);
  };
  entry(10, 0x010f, 2, 4, (o) => out.set([0x43, 0x61, 0x6d, 0], o)); // "Cam\0" inline
  entry(22, 0x0112, 3, 1, (o) => v.setUint16(o, orientation, le));
  entry(34, 0x8825, 4, 1, (o) => v.setUint32(o, 50, le));
  v.setUint32(46, 0, le);
  v.setUint16(50, 1, le);
  entry(52, 0x0001, 2, 2, (o) => out.set([0x4e, 0], o)); // GPSLatitudeRef "N"
  v.setUint32(64, 0, le);
  return out;
}

const app0 = seg(0xe0, "JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0]);
const dqt = seg(0xdb, [0], new Array(64).fill(1));
const sof0 = seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
const scan = bytes(seg(0xda, [1, 1, 0, 0, 63, 0]), [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]);

function jpeg(orientation = 6, le = false): Uint8Array<ArrayBuffer> {
  return bytes(
    [0xff, 0xd8],
    app0,
    seg(0xe1, "Exif\0\0", tiff(le, orientation)),
    seg(0xe1, "http://ns.adobe.com/xap/1.0/\0", "<x:xmpmeta>secret</x:xmpmeta>"),
    seg(0xed, "Photoshop 3.0\0", "8BIM", [4, 4, 0, 0, 0, 0, 0, 4], "IPTC"),
    seg(0xfe, "hello comment"),
    [0xff], // fill byte before DQT
    dqt,
    sof0,
    scan,
  );
}

/** Segments before SOS as [marker, full segment bytes]. */
function segments(d: Uint8Array): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = [];
  let pos = 2;
  while (pos < d.length) {
    while (d[pos] === 0xff && d[pos + 1] === 0xff) pos++;
    const marker = d[pos + 1]!;
    if (marker === 0xda) break;
    const end = pos + 2 + ((d[pos + 2]! << 8) | d[pos + 3]!);
    out.push([marker, d.subarray(pos, end)]);
    pos = end;
  }
  return out;
}

describe("JPEG", () => {
  for (const le of [false, true]) {
    it(`drops EXIF, XMP, IPTC and comments and keeps the orientation (${le ? "II" : "MM"})`, async () => {
      const original = file(jpeg(6, le), "photo.jpg", "image/jpeg");
      const result = await stripImageMetadata(original);
      expect(result.kind).toBe("jpeg");
      expect(result.warnings).toEqual([]);
      expect(result.removed).toEqual(expect.arrayContaining(["exif", "xmp", "iptc", "comment"]));
      expect(result.file).not.toBe(original);
      expect(result.file.name).toBe("photo.jpg");
      expect(result.file.type).toBe("image/jpeg");
      expect(result.file.lastModified).toBe(original.lastModified);

      const out = await readBytes(result.file);
      for (const secret of ["Cam", "xmpmeta", "Photoshop", "8BIM", "hello comment", "http://ns.adobe.com"]) expect(contains(out, secret), secret).toBe(false);
      const segs = segments(out);
      expect(segs.map(([m]) => m)).toEqual([0xe0, 0xe1, 0xdb, 0xc0]);
      expect(segs[0]![1]).toEqual(app0);
      const app1 = segs[1]![1];
      expect(String.fromCharCode(app1[10]!, app1[11]!)).toBe(le ? "II" : "MM");
      expect(exifOrientation(app1.subarray(4))).toBe(6);
      expect(segs[2]![1]).toEqual(dqt);
      expect(out.subarray(out.length - scan.length)).toEqual(scan);
      expect(contains(out, [0xff, 0xff, ...dqt.subarray(1)])).toBe(true); // fill byte kept
    });
  }

  it("orientation 1 leaves no APP1 at all", () => {
    const result = stripJpeg(jpeg(1))!;
    expect(result.removed).toEqual(["exif", "xmp", "iptc", "comment"]);
    expect(segments(result.data).map(([m]) => m)).toEqual([0xe0, 0xdb, 0xc0]);
  });

  it("returns the original file when there is nothing to remove", async () => {
    const original = file(bytes([0xff, 0xd8], app0, seg(0xe2, "ICC_PROFILE\0", [1, 1]), [0xff, 0x01], dqt, sof0, scan));
    const result = await stripImageMetadata(original);
    expect(result).toEqual({ file: original, removed: [], warnings: [], kind: "jpeg" });
    expect(result.file).toBe(original);
  });

  it("inspect reports what would be removed but returns the same file", async () => {
    const original = file(jpeg());
    const result = await inspectMetadata(original);
    expect(result.file).toBe(original);
    expect(result.removed).toEqual(["exif", "xmp", "iptc", "comment"]);
    expect(result.kind).toBe("jpeg");
  });

  it("malformed: a segment length beyond the end returns the original", async () => {
    const original = file(bytes([0xff, 0xd8], app0, [0xff, 0xe1, 0x40, 0x00], "Exif\0\0MM"));
    const result = await stripImageMetadata(original);
    expect(result).toEqual({ file: original, removed: [], warnings: ["malformed"], kind: "jpeg" });
    expect(stripJpeg(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(stripJpeg(bytes([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });

  it("drops images appended after the main one (MPF index, second JPEG with its own EXIF)", () => {
    const second = bytes([0xff, 0xd8], seg(0xe1, "Exif\0\0", tiff(false, 1)), "GPSDATA", [0xff, 0xd9]);
    const mpf = seg(0xe2, "MPF\0", [0, 0, 0, 0]);
    const result = stripJpeg(bytes([0xff, 0xd8], app0, mpf, dqt, sof0, scan, second))!;
    expect(result.removed).toEqual(["trailer"]);
    expect(contains(result.data, "GPSDATA")).toBe(false);
    expect(contains(result.data, "MPF\0")).toBe(false);
    expect(result.data.subarray(result.data.length - scan.length)).toEqual(scan);
  });

  it("ignores an EXIF with an IFD offset beyond its end (orientation unknown)", () => {
    const broken = bytes("Exif\0\0MM", [0, 42], be32(4000));
    expect(exifOrientation(broken)).toBeNull();
    const result = stripJpeg(bytes([0xff, 0xd8], seg(0xe1, broken), dqt, scan))!;
    expect(segments(result.data).map(([m]) => m)).toEqual([0xdb]);
  });
});

// --- PNG

function crc32(d: Uint8Array): number {
  let c = ~0;
  for (const b of d) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const chunk = (type: string, ...data: Bytes[]) => {
  const body = bytes(type, ...data);
  return bytes(be32(body.length - 4), body, be32(crc32(body)));
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ihdr = chunk("IHDR", be32(1), be32(1), [8, 6, 0, 0, 0]);
const idat = chunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0, 0, 0, 2, 0, 1]);
const iend = chunk("IEND");

describe("PNG", () => {
  it("keeps only IHDR, IDAT and IEND byte for byte", async () => {
    const data = bytes(
      PNG_SIG,
      ihdr,
      chunk("tEXt", "Author\0Jane Doe"),
      chunk("iTXt", "Comment\0\0\0\0\0secret"),
      chunk("tIME", [7, 0xea, 10, 5, 12, 0, 0]),
      chunk("eXIf", "MM", [0, 42]),
      idat,
      iend,
    );
    const result = await stripImageMetadata(file(data, "a.png", "image/png"));
    expect(result.kind).toBe("png");
    expect(result.removed).toEqual(["text", "time", "exif"]);
    expect(await readBytes(result.file)).toEqual(bytes(PNG_SIG, ihdr, idat, iend));
  });

  it("returns the input when clean, null when a chunk is truncated", () => {
    const clean = bytes(PNG_SIG, ihdr, idat, iend);
    expect(stripPng(clean)).toEqual({ data: clean, removed: [] });
    expect(stripPng(bytes(PNG_SIG, ihdr, be32(100), "IDAT", new Array(10).fill(0)))).toBeNull();
    expect(stripPng(bytes(PNG_SIG, ihdr))).toBeNull(); // no IEND
  });

  it("malformed PNG returns the original file", async () => {
    const original = file(bytes(PNG_SIG, ihdr, chunk("tEXt", "a\0b"), be32(100), "IDAT", [1, 2, 3]));
    expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: ["malformed"], kind: "png" });
  });
});

// --- WebP

const riffChunk = (fourcc: string, ...data: Bytes[]) => {
  const body = bytes(...data);
  return bytes(fourcc, le32(body.length), body, body.length & 1 ? [0] : []);
};
const riff = (...chunks: Uint8Array[]) => {
  const body = bytes("WEBP", ...chunks);
  return bytes("RIFF", le32(body.length), body);
};

describe("WebP", () => {
  it("drops EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size", async () => {
    const vp8x = (flags: number) => riffChunk("VP8X", [flags, 0, 0, 0], [0, 0, 0, 0, 0, 0]);
    const iccp = riffChunk("ICCP", [1, 2, 3, 4]);
    const vp8l = riffChunk("VP8L", [0x2f, 0, 0, 0, 0x10, 7, 0x10, 0x11]);
    const data = riff(vp8x(0x20 | 0x10 | 0x08 | 0x04), iccp, vp8l, riffChunk("EXIF", "MM", [0, 42, 9]), riffChunk("XMP ", "<x:xmpmeta/>"));
    const result = await stripImageMetadata(file(data, "a.webp", "image/webp"));
    expect(result.kind).toBe("webp");
    expect(result.removed).toEqual(["exif", "xmp"]);
    const out = await readBytes(result.file);
    expect(out).toEqual(riff(vp8x(0x30), iccp, vp8l));
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it("a simple VP8L file stays the same file", async () => {
    const original = file(riff(riffChunk("VP8L", [0x2f, 0, 0, 0, 0x10])));
    const result = await stripImageMetadata(original);
    expect(result.file).toBe(original);
    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects chunks beyond the RIFF end", () => {
    expect(stripWebp(bytes("RIFF", le32(20), "WEBP", "VP8L", le32(50), [0, 0, 0, 0]))).toBeNull();
  });
});

// --- ISO-BMFF

const box = (type: string, ...data: Bytes[]) => {
  const body = bytes(...data);
  return bytes(be32(body.length + 8), type, body);
};
const ftyp = (major: string, ...compatible: string[]) => box("ftyp", major, be32(0), ...compatible);
const mvhd = box("mvhd", new Array(100).fill(0));
const xyz = box("©xyz", be16(12), [0x15, 0xc7], "+52.5+013.4/");

describe("video and HEIF", () => {
  it("warns about a ©xyz location and leaves the file alone", async () => {
    const original = file(bytes(ftyp("isom", "isom", "mp42"), box("moov", mvhd, box("udta", xyz)), box("mdat", [1, 2, 3])), "v.mp4", "video/mp4");
    expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: ["video_location"], kind: "video" });
  });

  it("no location, 64-bit mdat: no warnings", async () => {
    const mdat = bytes(be32(1), "mdat", be32(0), be32(24), [9, 9, 9, 9, 9, 9, 9, 9]);
    const original = file(bytes(ftyp("mp42", "isom"), mdat, box("moov", mvhd, box("udta", box("©nam", "title")))));
    expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: [], kind: "video" });
  });

  it("finds QuickTime location keys under moov/meta (no ftyp, meta without version)", async () => {
    const key = (name: string) => bytes(be32(name.length + 8), "mdta", name);
    const keys = box("keys", be32(0), be32(2), key("com.apple.quicktime.make"), key("com.apple.quicktime.location.ISO6709"));
    const hdlr = box("hdlr", be32(0), be32(0), "mdta", new Array(12).fill(0), [0]);
    const meta = box("meta", hdlr, keys, box("ilst"));
    const original = file(bytes(box("wide"), box("mdat", [1, 2]), box("moov", mvhd, meta)), "v.mov");
    const result = await inspectMetadata(original);
    expect(result).toEqual({ file: original, removed: [], warnings: ["video_location"], kind: "video" });
  });

  it("finds loci and ©xyz in ISO meta (FullBox) and trak/udta", () => {
    const isoMeta = box("meta", be32(0), box("hdlr", be32(0), be32(0), "mdir", new Array(13).fill(0)), box("ilst", xyz));
    expect(scanMp4(bytes(ftyp("isom"), box("moov", box("udta", isoMeta))))).toEqual({ location: true });
    expect(scanMp4(bytes(ftyp("isom"), box("moov", box("trak", box("udta", box("loci", be32(0), "x"))))))).toEqual({ location: true });
    expect(scanMp4(bytes(ftyp("isom"), box("moov", mvhd)))).toEqual({ location: false });
  });

  it("malformed boxes give a warning, not an exception", async () => {
    const original = file(bytes(ftyp("isom"), be32(500), "moov", mvhd));
    expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: ["malformed"], kind: "video" });
    expect(scanMp4(bytes(be32(4), "free"))).toBeNull();
  });

  it("does not strip HEIC/AVIF", async () => {
    for (const data of [bytes(ftyp("heic", "mif1", "heic"), box("meta", be32(0))), bytes(ftyp("mp41", "avif"), box("mdat"))]) {
      const original = file(data, "p.heic", "image/heic");
      expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: ["heif_not_stripped"], kind: "heif" });
    }
  });
});

describe("everything else", () => {
  it("never touches documents, archives or text", async () => {
    for (const data of [bytes("%PDF-1.7\n%âã\n1 0 obj"), bytes("PK", [3, 4, 20, 0, 0, 0]), bytes("Exif\0\0 just text"), bytes()]) {
      const original = file(data);
      expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: [], kind: "other" });
    }
  });

  it("does not parse images above the size cap", async () => {
    const original = file(jpeg());
    Object.defineProperty(original, "size", { value: MAX_PARSE_BYTES + 1 });
    expect(await stripImageMetadata(original)).toEqual({ file: original, removed: [], warnings: [], kind: "jpeg" });
  });
});
