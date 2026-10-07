// SPDX-License-Identifier: Apache-2.0
/**
 * Pure building blocks of the whiteboard sync (tavrn-protocol/WHITEBOARD.md): element diffs with Excalidraw's
 * version/versionNonce, reconciliation, validation of untrusted payloads, permission checks, throttling,
 * the send budget and the chunking of large payloads. No DOM, no Excalidraw, no network: unit-tested.
 */
import { b64urlDecode, b64urlEncode, type WhiteboardSession } from "@tavrn/sdk";

/** The parts of an Excalidraw element the sync relies on; everything else is carried along untouched. */
export interface WbElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  /** Fractional index (Excalidraw ≥ 0.18): the z-order. */
  index?: string | null;
  fileId?: string | null;
  [key: string]: unknown;
}

/** An image of the board (Excalidraw `BinaryFileData`). */
export interface WbFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export const LIMITS = {
  /** Elements on one board. */
  maxElements: 20_000,
  /** Characters of one serialized element (freehand strokes with many points are the largest). */
  maxElementChars: 256 * 1024,
  /** Characters of one image data URL. */
  maxFileChars: 6 * 1024 * 1024,
  /** Images on one board. */
  maxFiles: 64,
  /** Serialized payloads up to this size go out in one event (the encrypted event stays below 64 KiB). */
  directBytes: 40_000,
  /** Raw bytes per chunk of a larger payload (base64: 40 000 characters). */
  chunkBytes: 30_000,
  /** A reassembled payload may not exceed this. */
  maxAssembledBytes: 16 * 1024 * 1024,
  /** Assemblies in progress per sender. */
  maxAssembliesPerSender: 4,
  /** An incomplete assembly is dropped after this. */
  chunkTimeoutMs: 30_000,
} as const;

/** Drawable element types. Embeds and iframes (web content inside the board) are never accepted from others. */
const ELEMENT_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame"]);
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif|svg\+xml)$/;

/** `version:versionNonce`: two elements with the same stamp are the same state. */
export function stamp(e: Pick<WbElement, "version" | "versionNonce">): string {
  return `${e.version}:${e.versionNonce}`;
}

/**
 * The elements whose state differs from what is known (sent or received before); records them as known.
 * Excalidraw bumps `version` and `versionNonce` on every change, so this is the exact diff of `onChange`.
 */
export function diffElements(elements: readonly WbElement[], known: Map<string, string>): WbElement[] {
  const changed: WbElement[] = [];
  for (const e of elements) {
    const s = stamp(e);
    if (known.get(e.id) !== s) {
      known.set(e.id, s);
      changed.push(e);
    }
  }
  return changed;
}

/**
 * Merges `incoming` into `local` (by id) and returns the accepted elements. A higher `version` wins; at
 * the same version with another nonce the incoming state wins only if `incomingWinsTies` (viewers take the
 * owner's state, the owner keeps its own against proposals).
 */
export function reconcile(local: Map<string, WbElement>, incoming: readonly WbElement[], opts: { incomingWinsTies: boolean }): WbElement[] {
  const accepted: WbElement[] = [];
  for (const e of incoming) {
    const current = local.get(e.id);
    const newer = !current || e.version > current.version || (e.version === current.version && e.versionNonce !== current.versionNonce && opts.incomingWinsTies);
    if (newer) {
      local.set(e.id, e);
      accepted.push(e);
    }
  }
  return accepted;
}

/** Elements in z-order (fractional index, then id), optionally without deleted ones. */
export function ordered(elements: Iterable<WbElement>, opts: { withDeleted?: boolean } = {}): WbElement[] {
  const list = [...elements].filter((e) => opts.withDeleted || !e.isDeleted);
  return list.sort((a, b) => {
    const ia = a.index ?? "￿";
    const ib = b.index ?? "￿";
    return ia < ib ? -1 : ia > ib ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/**
 * Untrusted elements from the network: plain objects with a string id, a known type and integer version
 * and nonce, bounded in number and size. Everything else is dropped (Excalidraw's `restoreElements`
 * normalizes the remaining fields before rendering).
 */
export function sanitizeElements(raw: unknown): WbElement[] {
  if (!Array.isArray(raw)) return [];
  const out: WbElement[] = [];
  for (const item of raw.slice(0, LIMITS.maxElements)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 64) continue;
    if (typeof e.type !== "string" || !ELEMENT_TYPES.has(e.type)) continue;
    if (!isInt(e.version) || !isInt(e.versionNonce) || e.version < 0) continue;
    if (e.index !== undefined && e.index !== null && (typeof e.index !== "string" || e.index.length > 64)) continue;
    if (e.fileId !== undefined && e.fileId !== null && (typeof e.fileId !== "string" || e.fileId.length > 128)) continue;
    if (JSON.stringify(e).length > LIMITS.maxElementChars) continue;
    out.push(e as WbElement);
  }
  return out;
}

/** Untrusted images: raster or SVG data URLs of the declared type, bounded in number and size. */
export function sanitizeFiles(raw: unknown): WbFile[] {
  if (!Array.isArray(raw)) return [];
  const out: WbFile[] = [];
  for (const item of raw.slice(0, LIMITS.maxFiles)) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.id !== "string" || f.id.length === 0 || f.id.length > 128) continue;
    if (typeof f.mimeType !== "string" || !IMAGE_MIME.test(f.mimeType)) continue;
    if (typeof f.dataURL !== "string" || f.dataURL.length > LIMITS.maxFileChars || !f.dataURL.startsWith(`data:${f.mimeType};base64,`)) continue;
    out.push({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: isInt(f.created) ? f.created : Date.now() });
  }
  return out;
}

/** `#rrggbb`, `#rgb`, `transparent` or null for anything else (no CSS injection through the background). */
export function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw === "transparent" || /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  return null;
}

/** May `address` edit the board of `session` (owner, open for everyone, or granted)? */
export function mayEdit(session: Pick<WhiteboardSession, "owner" | "open_for_all" | "grants"> | null, address: string): boolean {
  if (!session) return false;
  const a = address.toLowerCase();
  return session.owner.toLowerCase() === a || session.open_for_all || session.grants.some((g) => g.toLowerCase() === a);
}

/** The device presenting the board. */
export function isOwnerDevice(session: Pick<WhiteboardSession, "owner" | "device_id"> | null, user: string, deviceId: string): boolean {
  return !!session && session.owner.toLowerCase() === user.toLowerCase() && session.device_id === deviceId;
}

/**
 * Leading and trailing throttle: the first call runs at once, further calls within `ms` collapse into one
 * run at the end of the window.
 */
export class Throttle {
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ms: number,
    private readonly fn: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  schedule(): void {
    if (this.timer) return;
    const wait = this.last + this.ms - this.now();
    if (wait <= 0) {
      this.run();
      return;
    }
    this.timer = setTimeout(() => this.run(), wait);
  }

  /** Runs a pending call now. */
  flush(): void {
    if (this.timer) this.run();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.last = this.now();
    this.fn();
  }
}

/** Token bucket: `perSecond` events per second, bursts up to `perSecond`. */
export class RateBudget {
  private tokens: number;
  private at: number;

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = perSecond;
    this.at = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.perSecond, this.tokens + ((t - this.at) / 1000) * this.perSecond);
    this.at = t;
  }

  /** Takes a token if more than `reserve` are left. */
  take(reserve = 0): boolean {
    this.refill();
    if (this.tokens - 1 < reserve) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until a token is available. */
  wait(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 size of a string. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Splits a serialized payload into base64url parts of at most `chunkBytes` raw bytes. */
export function splitPayload(json: string, chunkBytes: number = LIMITS.chunkBytes): string[] {
  const bytes = encoder.encode(json);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) parts.push(b64urlEncode(bytes.subarray(i, i + chunkBytes)));
  return parts;
}

export interface Chunk {
  id: string;
  index: number;
  total: number;
  data: string;
}

/** Validates the fields of a `whiteboard.chunk` payload. */
export function parseChunk(raw: Record<string, unknown>): Chunk | null {
  const { id, index, total, data } = raw;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (!isInt(total) || total < 1 || total > Math.ceil(LIMITS.maxAssembledBytes / LIMITS.chunkBytes)) return null;
  if (!isInt(index) || index < 0 || index >= total) return null;
  if (typeof data !== "string" || data.length > Math.ceil((LIMITS.chunkBytes * 4) / 3) + 4) return null;
  return { id, index, total, data };
}

/**
 * Reassembles chunked payloads per sender with bounds (assemblies per sender, total size, timeout), so a
 * sender cannot make the receiver keep unbounded state.
 */
export class ChunkAssembler {
  private readonly parts = new Map<string, { sender: string; total: number; got: Map<number, Uint8Array>; bytes: number; started: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Adds a chunk; returns the complete payload (UTF-8 JSON text) when the last part arrived. */
  add(sender: string, chunk: Chunk): string | null {
    this.prune();
    const key = `${sender}|${chunk.id}`;
    let entry = this.parts.get(key);
    if (!entry) {
      const open = [...this.parts.values()].filter((p) => p.sender === sender).length;
      if (open >= LIMITS.maxAssembliesPerSender) return null;
      entry = { sender, total: chunk.total, got: new Map(), bytes: 0, started: this.now() };
      this.parts.set(key, entry);
    }
    if (entry.total !== chunk.total || entry.got.has(chunk.index)) return null;
    let bytes: Uint8Array;
    try {
      bytes = b64urlDecode(chunk.data);
    } catch {
      this.parts.delete(key);
      return null;
    }
    entry.bytes += bytes.length;
    if (entry.bytes > LIMITS.maxAssembledBytes) {
      this.parts.delete(key);
      return null;
    }
    entry.got.set(chunk.index, bytes);
    if (entry.got.size < entry.total) return null;
    this.parts.delete(key);
    const all = new Uint8Array(entry.bytes);
    let offset = 0;
    for (let i = 0; i < entry.total; i++) {
      const part = entry.got.get(i)!;
      all.set(part, offset);
      offset += part.length;
    }
    try {
      return decoder.decode(all);
    } catch {
      return null;
    }
  }

  /** Drops assemblies older than the timeout. */
  prune(): void {
    const t = this.now();
    for (const [k, v] of this.parts) if (t - v.started > LIMITS.chunkTimeoutMs) this.parts.delete(k);
  }

  get pending(): number {
    return this.parts.size;
  }
}
