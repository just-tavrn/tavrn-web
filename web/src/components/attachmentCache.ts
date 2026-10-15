// SPDX-License-Identifier: Apache-2.0
/**
 * The session's cache of downloaded (and decrypted) attachments: one load per blob, shared by the preview, the
 * player and the download. Bounded by bytes and entries: the least recently used entries that nothing mounted holds
 * are dropped and their object URLs revoked, so a session that runs for days does not keep every file it showed.
 */

interface Entry {
  blob: Promise<Blob>;
  /** The blob's size once loaded; until then the declared size. */
  size: number;
  url: Promise<string> | null;
  /** Mounted views holding the object URL. */
  refs: number;
}

export interface AttachmentCacheOptions {
  /** Bytes kept for entries that nothing holds. */
  budget: number;
  /** Entries kept at most (each can hold an object URL). */
  maxEntries: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

export class AttachmentCache {
  private readonly entries = new Map<string, Entry>();
  private pending = false;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  constructor(private readonly opts: AttachmentCacheOptions) {
    this.createUrl = opts.createUrl ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = opts.revokeUrl ?? ((u) => URL.revokeObjectURL(u));
  }

  /** The content under `key`, loaded once (`size`: the declared size until the blob is there). */
  blob(key: string, size: number, load: () => Promise<Blob>): Promise<Blob> {
    return this.entry(key, size, load).blob;
  }

  /** An object URL of the content under `key`, held until `release` (idempotent). */
  acquireUrl(key: string, size: number, load: () => Promise<Blob>): { url: Promise<string>; release: () => void } {
    const e = this.entry(key, size, load);
    e.refs++;
    if (!e.url) {
      const url = e.blob.then((b) => this.createUrl(b));
      e.url = url;
      url.catch(() => {
        if (e.url === url) e.url = null;
      });
    }
    let held = true;
    return {
      url: e.url,
      release: () => {
        if (!held) return;
        held = false;
        e.refs--;
        this.scheduleEvict();
      },
    };
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.size;
    return total;
  }

  /** Drops everything (sign-out) and revokes the object URLs. */
  clear(): void {
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all) this.drop(e);
  }

  private entry(key: string, size: number, load: () => Promise<Blob>): Entry {
    let e = this.entries.get(key);
    if (e) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, e);
      return e;
    }
    const blob = load();
    const entry: Entry = { blob, size: Math.max(0, size), url: null, refs: 0 };
    e = entry;
    this.entries.set(key, entry);
    blob.then(
      (b) => {
        entry.size = b.size;
        this.scheduleEvict();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.scheduleEvict();
    return e;
  }

  /** Eviction runs after the current task: a view that remounts (release, then acquire) keeps its entry. */
  private scheduleEvict() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.evict();
    }, 0);
  }

  private evict() {
    let total = this.bytes;
    let count = this.entries.size;
    for (const [key, e] of this.entries) {
      if (total <= this.opts.budget && count <= this.opts.maxEntries) break;
      if (e.refs > 0) continue;
      this.entries.delete(key);
      total -= e.size;
      count--;
      this.drop(e);
    }
  }

  private drop(e: Entry) {
    void e.url?.then((u) => this.revokeUrl(u)).catch(() => undefined);
  }
}
