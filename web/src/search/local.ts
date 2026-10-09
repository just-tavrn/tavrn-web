// SPDX-License-Identifier: Apache-2.0
/**
 * The local encrypted search index of this device (design note 4.4 "Search", tavrn-protocol/SEARCH.md §3): one
 * `SearchIndex` of `@tavrn/e2ee` per signed-in account on the IndexedDB backend, keyed by the local store
 * key. It exists only while the crypto store is unlocked ("lock on close" covers it); signing out wipes it.
 *
 * What goes in: encrypted messages whenever they are decrypted anyway (the message list and the throttled
 * background sync in `sync.ts`), text and attachment file names only. Plaintext messages are searched by the
 * node. The per-conversation setting "keep the full history on this device" is the index's `complete` flag
 * (stored sealed in the index, mirrored in {@link useLocalSearch} for the UI).
 */
import { create } from "zustand";
import { SearchIndex, contentAttachments, searchKeysFromStore, type Coverage, type Decrypted, type IndexedMessage } from "@tavrn/e2ee";
import type { Message } from "@tavrn/sdk";
import { cryptoStore } from "../crypto/store";
import { IdbSearchBackend } from "./idbBackend";
import { HistoryArchive } from "../history/archive";

/** Database of the archived full history (#4, `history/archive.ts`); the same backend kind as the index. */
const HISTORY_DB = "tavrn-history";

export interface LocalSearchState {
  /** Coverage per qualified conversation id (what the index holds, the complete flag, the sync state). */
  coverage: Record<string, Coverage>;
  stats: { bytes: number; conversations: number; messages: number; complete: number } | null;
  /** Conversations the background sync is working on right now. */
  syncing: Record<string, boolean>;
  /** The index is open (unlocked store). */
  ready: boolean;
  /** Bytes of the archived full history per qualified conversation id (#4). */
  history: Record<string, number>;
}

export const useLocalSearch = create<LocalSearchState>(() => ({ coverage: {}, stats: null, syncing: {}, ready: false, history: {} }));

let current: { account: string; index: Promise<SearchIndex | null>; backend: IdbSearchBackend; archive: Promise<HistoryArchive | null> } | null = null;

/**
 * Development builds only: a shorter window (days) for the end-to-end tests of the budget
 * (`localStorage["tavrn.dev.searchWindowDays"]`). Production builds always use the default of 90 days.
 */
function devWindowDays(): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  try {
    const v = Number(localStorage.getItem("tavrn.dev.searchWindowDays"));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The open index of the signed-in account, or null while the store is locked (or IndexedDB is unavailable). */
export function localIndex(): Promise<SearchIndex | null> {
  const account = cryptoStore.account();
  if (!account || !cryptoStore.isUnlocked(account)) {
    closeLocalIndex();
    return Promise.resolve(null);
  }
  if (current?.account === account) return current.index;
  closeLocalIndex();
  const backend = new IdbSearchBackend(account);
  const keys = searchKeysFromStore(cryptoStore);
  keys.catch(() => undefined);
  // The archived full history uses the index's keys: it locks and unlocks with it.
  const archive = keys.then(
    (k) => new HistoryArchive(new IdbSearchBackend(account, HISTORY_DB), k),
    () => null,
  );
  const index = (async () => {
    try {
      const windowDays = devWindowDays();
      const idx = await SearchIndex.open(backend, await keys, windowDays ? { windowDays } : {});
      useLocalSearch.setState({ ready: true });
      void refreshLocalState(idx);
      return idx;
    } catch {
      return null;
    }
  })();
  current = { account, index, backend, archive };
  return index;
}

/** The archived full history of the signed-in account, or null while the store is locked. */
export async function localArchive(): Promise<HistoryArchive | null> {
  if (!(await localIndex())) return null;
  return current?.archive ?? null;
}

/** Forgets the keys of the open index (sign-out, lock). */
export function closeLocalIndex(): void {
  if (!current) return;
  const { index, archive } = current;
  current = null;
  void index.then((i) => i?.lock()).catch(() => undefined);
  void archive.then((a) => a?.lock()).catch(() => undefined);
  useLocalSearch.setState({ coverage: {}, stats: null, syncing: {}, ready: false, history: {} });
}

/** Deletes the index of `account` from this device (sign-out wipes it with the other local data). */
export async function wipeLocalIndex(account: string): Promise<void> {
  const backend = current?.account === account ? current.backend : new IdbSearchBackend(account);
  closeLocalIndex();
  await backend.clear().catch(() => undefined);
  // The archived full history goes with it (#4).
  await new IdbSearchBackend(account, HISTORY_DB).clear().catch(() => undefined);
}

/** Reloads coverage and stats into {@link useLocalSearch}. */
export async function refreshLocalState(index?: SearchIndex | null): Promise<void> {
  const idx = index ?? (await localIndex());
  if (!idx) return;
  try {
    const [coverage, stats] = await Promise.all([idx.coverage(), idx.stats()]);
    const archive = await current?.archive;
    const history: Record<string, number> = {};
    for (const c of (await archive?.conversations()) ?? []) history[c] = await archive!.usage(c);
    useLocalSearch.setState({ coverage: Object.fromEntries(coverage.map((c) => [c.conversation, c])), stats, history });
  } catch {
    /* locked meanwhile */
  }
}

/** The searchable text of a decrypted content object: body, embed titles and descriptions (text and actions). */
export function contentText(content: Record<string, unknown>): string | null {
  if (content.type !== "text" && content.type !== "action") return null;
  const parts: string[] = [];
  if (typeof content.body === "string") parts.push(content.body);
  for (const e of Array.isArray(content.embeds) ? content.embeds : []) {
    if (!e || typeof e !== "object") continue;
    const embed = e as Record<string, unknown>;
    for (const k of ["title", "description"]) if (typeof embed[k] === "string") parts.push(embed[k] as string);
  }
  return parts.join("\n");
}

/** The index entry of a decrypted message, or null when there is nothing to search (system messages, failures). */
export function indexEntry(conversation: string, m: Message, d: Decrypted | undefined, room?: string): IndexedMessage | null {
  if (!m.encrypted || !d?.ok) return null;
  const text = contentText(d.content);
  if (text === null) return null;
  const files = contentAttachments(d.content, m.attachments).map((a) => a.name);
  if (!text.trim() && files.length === 0) return null;
  const ts = Date.parse(m.created_at);
  if (!Number.isFinite(ts)) return null;
  return { conversation, id: m.id, ts, author: m.author, text, files, ...(room ? { room } : {}), ...(m.thread_id ? { thread: m.thread_id } : {}) };
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let onNewConversation: (() => void) | null = null;
/** A conversation new to the index was added since the last flush. */
let pendingFresh = false;

/** Called when the display path brought a conversation into the index (the sync starts on it right away). */
export function onLocalConversationAdded(fn: (() => void) | null): void {
  onNewConversation = fn;
}

/** Adds decrypted messages (display path and sync); written within a few seconds, edits replace. */
export async function indexMessages(entries: IndexedMessage[]): Promise<void> {
  if (entries.length === 0) return;
  const idx = await localIndex();
  if (!idx) return;
  const known = useLocalSearch.getState().coverage;
  if (entries.some((e) => !known[e.conversation])) pendingFresh = true;
  try {
    await idx.add(entries);
  } catch {
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void (async () => {
      const i = await localIndex();
      if (!i) return;
      await i.flush().catch(() => undefined);
      await refreshLocalState(i);
      if (pendingFresh) {
        pendingFresh = false;
        onNewConversation?.();
      }
    })();
  }, 2000);
}

/** Removes deleted messages from the index. */
export async function unindexMessages(conversation: string, ids: string[]): Promise<void> {
  const idx = await localIndex();
  await idx?.remove(conversation, ids).catch(() => undefined);
  await (await current?.archive)?.remove(conversation, ids).catch(() => undefined);
}

/** Drops a conversation (left, deleted, purged); the sync fills it again when it is opened. */
export async function unindexConversation(conversation: string): Promise<void> {
  const idx = await localIndex();
  if (!idx) return;
  await idx.removeConversation(conversation).catch(() => undefined);
  await (await current?.archive)?.removeConversation(conversation).catch(() => undefined);
  await refreshLocalState(idx);
}

/**
 * "Keep the full history on this device" (default off). On: no window and no byte cap for the conversation,
 * the background sync pages its whole history. Off: the bounded window applies again right away.
 */
export async function setKeepFullHistory(conversation: string, on: boolean): Promise<void> {
  const idx = await localIndex();
  if (!idx) throw new Error("locked");
  await idx.setComplete(conversation, on);
  if (on) {
    // From the newest message back again (the cursor keeps only the room): what the window sync paged before is
    // decrypted once more for the archive of the full history (#4).
    const [cov] = await idx.coverage(conversation);
    let room: unknown;
    try {
      room = (JSON.parse(cov?.sync.cursor ?? "{}") as { r?: unknown }).r;
    } catch {
      room = undefined;
    }
    await idx.setSync(conversation, { done: false, reachedStart: false, cursor: JSON.stringify(typeof room === "string" ? { b: null, f: null, r: room } : { b: null, f: null }) });
  }
  else {
    await idx.enforceBudget();
    // Turned off: the archived messages of the conversation are deleted (#4).
    await (await current?.archive)?.removeConversation(conversation);
  }
  await refreshLocalState(idx);
}

/** Clears the whole index of this device (settings: "Clear index"). */
export async function clearLocalIndex(): Promise<void> {
  const idx = await localIndex();
  if (!idx) return;
  await idx.clear();
  // Every "full history" choice is gone with the index: so is the archived history.
  await (await current?.archive)?.clear();
  await refreshLocalState(idx);
}

/**
 * Rebuild: clears the index but keeps the "full history" choices; the background sync fills it again from
 * the node (decrypting what this device can).
 */
export async function rebuildLocalIndex(): Promise<void> {
  const idx = await localIndex();
  if (!idx) return;
  const complete = (await idx.coverage()).filter((c) => c.complete).map((c) => c.conversation);
  await idx.clear();
  for (const c of complete) await idx.setComplete(c, true);
  await refreshLocalState(idx);
}
