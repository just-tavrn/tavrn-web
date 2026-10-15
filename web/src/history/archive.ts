// SPDX-License-Identifier: Apache-2.0
/**
 * The device's archive of decrypted history (#4, design note 4.4): for conversations with "keep the full history on
 * this device", the messages and their decrypted content stay in an encrypted local store, for reading while the node
 * cannot be reached and without decrypting them again. History is otherwise lazy (pages are dropped when a
 * conversation closes); this archive exists only for the conversations the user chose, up to a size cap each.
 *
 * Storage: a {@link SearchBackend} (IndexedDB database `tavrn-history` in the client) with the keys of the local
 * search index (HKDF of the local storage key, so it locks and unlocks with the crypto store). Record names are HMAC
 * tokens and every value is sealed with AES-256-GCM bound to its record name, as in the search index: the store
 * reveals record counts and sizes, no conversation or message ids, no text.
 *
 * Per conversation one sealed manifest lists the archived message ids in order with their record sizes and thread
 * (the paging and the cap work on it); one sealed record per message holds the message as the node sent it, its
 * decrypted content (null for plaintext messages) and a fingerprint (author, device, epoch, edit time and a hash of
 * the ciphertext) that tells whether the content still belongs to the message the node serves now. A node can serve a
 * message id again with another author or device: the archived content is then never handed out for it.
 */
import { open, seal, tokenKey, type Decrypted, type SearchBackend, type SearchKeys } from "@tavrn/e2ee";
import type { Message } from "@tavrn/sdk";

/** [message id, sealed record size in bytes, thread id or null] */
type Entry = [string, number, string | null];

interface Manifest {
  e: Entry[];
}

interface ArchivedMessage {
  m: Message;
  d: Decrypted | null;
  f: string;
}

export interface ArchiveItem {
  message: Message;
  /** The decrypted content of an encrypted message (only successful results are kept); null for plaintext ones. */
  decrypted: Decrypted | null;
}

/** A page request as in `lib/messagePages.ts`. */
export type ArchivePageParam = { before?: string; after?: string; around?: string } | undefined;

/**
 * Ties archived content to the message it was decrypted from: the author, the sending device, the epoch, the edit and
 * the SHA-256 of the ciphertext. Entries of the earlier format (edit, epoch and device only) never match: they are
 * decrypted again and replaced.
 */
export async function fingerprint(m: Pick<Message, "author" | "device_id" | "epoch" | "edited_at" | "content">): Promise<string> {
  const content = new TextEncoder().encode(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `v2|${JSON.stringify([m.author ?? "", m.device_id ?? "", m.epoch ?? "", m.edited_at ?? ""])}|${hash}`;
}

const MANIFEST_OVERHEAD = 12 + 16 + '{"e":[]}'.length;
const entryBytes = (e: Entry) => JSON.stringify(e).length + 1;

/** Bytes the conversation takes: its records plus its sealed manifest. */
function usageOf(entries: Entry[]): number {
  if (entries.length === 0) return 0;
  return entries.reduce((sum, e) => sum + e[1] + entryBytes(e), MANIFEST_OVERHEAD - 1);
}

export class HistoryArchive {
  private readonly manifests = new Map<string, Promise<Entry[]>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: SearchBackend,
    private readonly keys: SearchKeys,
  ) {}

  /** One change at a time (the background sync and the message list write concurrently). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private manifestKey(c: string) {
    return tokenKey(this.keys, "history manifest v1", c);
  }

  private docKey(c: string, id: string) {
    return tokenKey(this.keys, "history message v1", c, id);
  }

  private listKey() {
    return tokenKey(this.keys, "history conversations v1");
  }

  private async readSealed<T>(store: "docs" | "meta", key: string): Promise<T | null> {
    const raw = await this.backend.get(store, key);
    if (!raw) return null;
    try {
      return await open<T>(this.keys, `history\u0000${key}`, raw);
    } catch {
      return null;
    }
  }

  private manifest(c: string): Promise<Entry[]> {
    let m = this.manifests.get(c);
    if (!m) {
      m = this.manifestKey(c).then(async (k) => (await this.readSealed<Manifest>("meta", k))?.e ?? []);
      this.manifests.set(c, m);
      m.catch(() => this.manifests.delete(c));
    }
    return m;
  }

  /** The archived conversations (qualified ids). */
  async conversations(): Promise<string[]> {
    return (await this.readSealed<string[]>("meta", await this.listKey())) ?? [];
  }

  private async saveList(list: string[]) {
    const key = await this.listKey();
    await this.backend.write([{ store: "meta", key, value: list.length ? await seal(this.keys, `history\u0000${key}`, list) : null }]);
  }

  private async saveManifest(c: string, entries: Entry[], extra: { key: string; value: Uint8Array | null }[]) {
    const key = await this.manifestKey(c);
    const value = entries.length ? await seal(this.keys, `history\u0000${key}`, { e: entries } satisfies Manifest) : null;
    await this.backend.write([...extra.map((w) => ({ store: "docs" as const, ...w })), { store: "meta", key, value }]);
    this.manifests.set(c, Promise.resolve(entries));
    const list = await this.conversations();
    if (entries.length && !list.includes(c)) await this.saveList([...list, c].sort());
    if (!entries.length && list.includes(c)) await this.saveList(list.filter((x) => x !== c));
  }

  /** Drops the oldest entries until the conversation fits `cap`; returns the deletions. */
  private async evict(c: string, entries: Entry[], cap: number) {
    const deletes: { key: string; value: null }[] = [];
    let total = usageOf(entries);
    while (entries.length && total > cap) {
      const gone = entries.shift()!;
      total -= gone[1] + entryBytes(gone);
      deletes.push({ key: await this.docKey(c, gone[0]), value: null });
    }
    return deletes;
  }

  /** Adds or replaces messages of a conversation and keeps it under `cap` bytes (the oldest messages go first). */
  put(c: string, items: ArchiveItem[], cap: number): Promise<void> {
    const kept = items.filter((i) => !i.message.encrypted || i.decrypted?.ok);
    if (kept.length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      const entries = [...(await this.manifest(c))];
      const index = new Map(entries.map((e, i) => [e[0], i]));
      const writes: { key: string; value: Uint8Array | null }[] = [];
      for (const { message, decrypted } of kept) {
        const key = await this.docKey(c, message.id);
        const value = await seal(this.keys, `history\u0000${key}`, { m: message, d: message.encrypted ? decrypted : null, f: await fingerprint(message) } satisfies ArchivedMessage);
        writes.push({ key, value });
        const entry: Entry = [message.id, value.byteLength, message.thread_id ?? null];
        const at = index.get(message.id);
        if (at === undefined) {
          index.set(message.id, entries.length);
          entries.push(entry);
        } else entries[at] = entry;
      }
      entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      const deletes = await this.evict(c, entries, cap);
      const deleted = new Set(deletes.map((d) => d.key));
      await this.saveManifest(c, entries, [...writes.filter((w) => !deleted.has(w.key)), ...deletes]);
    });
  }

  /** Applies a (smaller) cap to a conversation. */
  enforce(c: string, cap: number): Promise<void> {
    return this.exclusive(async () => {
      const entries = [...(await this.manifest(c))];
      const deletes = await this.evict(c, entries, cap);
      if (deletes.length) await this.saveManifest(c, entries, deletes);
    });
  }

  /** Bytes a conversation takes on this device (0 when nothing is archived). */
  async usage(c: string): Promise<number> {
    return usageOf(await this.manifest(c));
  }

  /** A page like the node's (newest first): the channel's messages (`thread` null) or one thread's. */
  async page(c: string, param: ArchivePageParam, thread: string | null, limit: number): Promise<Message[]> {
    const ids = (await this.manifest(c)).filter((e) => e[2] === thread).map((e) => e[0]);
    let slice: string[];
    if (param?.before) {
      const before = param.before;
      const older = ids.filter((id) => id < before);
      slice = older.slice(Math.max(0, older.length - limit));
    } else if (param?.after) {
      const after = param.after;
      slice = ids.filter((id) => id > after).slice(0, limit);
    } else if (param?.around) {
      const around = param.around;
      const at = Math.max(0, ids.findIndex((id) => id >= around));
      const start = Math.max(0, Math.min(at - Math.floor(limit / 2), ids.length - limit));
      slice = ids.slice(start, start + limit);
    } else slice = ids.slice(Math.max(0, ids.length - limit));
    const records = await this.records(c, slice);
    return slice
      .map((id) => records.get(id)?.m)
      .filter((m): m is Message => !!m)
      .reverse();
  }

  private async records(c: string, ids: string[]): Promise<Map<string, ArchivedMessage>> {
    const keys = await Promise.all(ids.map((id) => this.docKey(c, id)));
    const raw = await this.backend.getMany("docs", keys);
    const out = new Map<string, ArchivedMessage>();
    await Promise.all(
      raw.map(async (r, i) => {
        if (!r) return;
        try {
          out.set(ids[i]!, await open<ArchivedMessage>(this.keys, `history\u0000${keys[i]}`, r));
        } catch {
          /* another key or damaged: not used */
        }
      }),
    );
    return out;
  }

  /** The archived decrypted content of `messages` where it still belongs to the message version (fingerprint). */
  async decrypted(c: string, messages: Message[]): Promise<Map<string, Decrypted>> {
    const known = new Set((await this.manifest(c)).map((e) => e[0]));
    const wanted = messages.filter((m) => m.encrypted && known.has(m.id));
    const out = new Map<string, Decrypted>();
    if (wanted.length === 0) return out;
    const records = await this.records(
      c,
      wanted.map((m) => m.id),
    );
    for (const m of wanted) {
      const r = records.get(m.id);
      // The same author and device as the archived copy, and the same fingerprint (never another sender's text).
      if (r?.d?.ok && r.m?.id === m.id && r.m.author === m.author && r.m.device_id === m.device_id && r.f === (await fingerprint(m))) out.set(m.id, r.d);
    }
    return out;
  }

  /** Forgets deleted messages. */
  remove(c: string, ids: string[]): Promise<void> {
    return this.exclusive(async () => {
      const gone = new Set(ids);
      const entries = await this.manifest(c);
      if (!entries.some((e) => gone.has(e[0]))) return;
      const deletes = await Promise.all(entries.filter((e) => gone.has(e[0])).map(async (e) => ({ key: await this.docKey(c, e[0]), value: null })));
      await this.saveManifest(
        c,
        entries.filter((e) => !gone.has(e[0])),
        deletes,
      );
    });
  }

  /** Deletes everything archived of a conversation (the setting turned off, the conversation left or purged). */
  removeConversation(c: string): Promise<void> {
    return this.exclusive(async () => {
      const entries = await this.manifest(c);
      const deletes = await Promise.all(entries.map(async (e) => ({ key: await this.docKey(c, e[0]), value: null })));
      await this.saveManifest(c, [], deletes);
    });
  }

  /** Deletes every archived conversation of this account. */
  async clear(): Promise<void> {
    for (const c of await this.conversations()) await this.removeConversation(c);
  }

  /** Forgets the cached manifests (lock). */
  lock(): void {
    this.manifests.clear();
  }
}
