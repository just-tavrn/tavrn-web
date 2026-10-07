// SPDX-License-Identifier: Apache-2.0
/**
 * Background sync of the local search index (design note 4.4 "Lazy history" and "Search", tavrn-protocol/SEARCH.md
 * §3.4): while the crypto store is unlocked, the client pages through the history of the encrypted
 * conversations this device is a member of (an MLS group here) and indexes what it decrypts. Throttled: one
 * page of 100 messages at a time with a pause in between, slower while the tab is hidden, never the whole
 * history at once and never at start-up for everything (lazy history).
 *
 * - Conversations with "keep the full history on this device" are paged back to their very start (and kept
 *   current with newer pages).
 * - Every other conversation the index already knows (it was opened on this device) is paged back to the
 *   start of the window (90 days); older messages are not kept there.
 *
 * Progress lives in the index's sealed sync state (`cursor` is this module's JSON: oldest and newest id
 * reached, and the room of a room channel).
 */
import { splitQualified, type Coverage, type MlsManager } from "@tavrn/e2ee";
import { DEFAULT_WINDOW_DAYS } from "@tavrn/e2ee";
import { apiFor, isHome } from "../stores/nodes";
import { getMls } from "../stores/mls";
import { indexEntry, indexMessages, localIndex, onLocalConversationAdded, refreshLocalState, useLocalSearch } from "./local";

export const SYNC_PAGE = 100;
/** Pause between two pages (visible tab) and while there is nothing to do. */
export const PAUSE_MS = 1200;
export const IDLE_MS = 15_000;
/** Conversations whose history is synced look for newer messages this often. */
export const FORWARD_EVERY_MS = 2 * 60_000;
/** A conversation whose page failed (node unreachable, access gone) is left alone this long. */
export const BACKOFF_MS = 5 * 60_000;
/** The budget (window and byte cap) is enforced this often. */
export const BUDGET_EVERY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The sync's own cursor (stored as the opaque `sync.cursor` of the index). */
export interface SyncCursor {
  /** Oldest message id reached going back. */
  b: string | null;
  /** Newest message id reached going forward. */
  f: string | null;
  /** Room of a room channel (to open a local result). */
  r?: string;
}

export function parseCursor(raw: string | null | undefined): SyncCursor {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<SyncCursor>) : {};
    return { b: typeof v.b === "string" ? v.b : null, f: typeof v.f === "string" ? v.f : null, ...(typeof v.r === "string" ? { r: v.r } : {}) };
  } catch {
    return { b: null, f: null };
  }
}

export type Job = { conversation: string; direction: "back" | "forward" };

/**
 * The next job: unfinished backward syncs first (complete conversations before the others), then
 * conversations due for newer messages. Only conversations this device can decrypt (`member`).
 */
export function pickJob(coverage: Coverage[], member: (q: string) => boolean, lastForward: ReadonlyMap<string, number>, now: number, backoff: ReadonlyMap<string, number> = new Map()): Job | null {
  const candidates = coverage.filter((c) => member(c.conversation) && (backoff.get(c.conversation) ?? 0) <= now);
  const back = candidates.filter((c) => !c.sync.done).sort((a, b) => Number(b.complete) - Number(a.complete));
  if (back[0]) return { conversation: back[0].conversation, direction: "back" };
  const due = candidates.find((c) => now - (lastForward.get(c.conversation) ?? 0) >= FORWARD_EVERY_MS);
  return due ? { conversation: due.conversation, direction: "forward" } : null;
}

let wake: (() => void) | null = null;
/** Sleeps `ms` or until {@link wakeSearchSync}. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (wake === done) wake = null;
      resolve();
    }
    wake = done;
  });

/** Starts the next round right away (after a toggle of "keep the full history"). */
export function wakeSearchSync(): void {
  wake?.();
}

/** Remembers the room of a room channel for the conversation's local results (once per conversation). */
export async function rememberRoom(conversation: string, roomId: string): Promise<void> {
  const idx = await localIndex();
  if (!idx) return;
  const [cov] = await idx.coverage(conversation);
  const cursor = parseCursor(cov?.sync.cursor);
  if (cursor.r === roomId) return;
  await idx.setSync(conversation, { cursor: JSON.stringify({ ...cursor, r: roomId }) }).catch(() => undefined);
}

async function decryptPage(mls: MlsManager, conversation: string, page: Awaited<ReturnType<ReturnType<typeof apiFor>["conversations"]["messages"]>>, room?: string) {
  const entries = [];
  for (const m of page) {
    if (!m.encrypted) continue;
    try {
      const entry = indexEntry(conversation, m, await mls.decrypt(conversation, m), room);
      if (entry) entries.push(entry);
    } catch {
      /* not decryptable on this device: skipped */
    }
  }
  return entries;
}

/** Runs one page of a job. Returns false when the conversation cannot be synced now. */
export async function runJob(job: Job, deps: { mls: MlsManager; now: number; lastForward: Map<string, number> }): Promise<boolean> {
  const idx = await localIndex();
  if (!idx) return false;
  const [cov] = await idx.coverage(job.conversation);
  if (!cov) return false;
  const cursor = parseCursor(cov.sync.cursor);
  const { domain, id } = splitQualified(job.conversation);
  const api = apiFor(isHome(domain) ? null : domain);
  if (job.direction === "forward") {
    deps.lastForward.set(job.conversation, deps.now);
    if (!cursor.f) return true;
    const page = (await api.conversations.messages(id, { limit: SYNC_PAGE, after: cursor.f })).reverse();
    await indexMessages(await decryptPage(deps.mls, job.conversation, page, cursor.r));
    if (page[0]) await idx.setSync(job.conversation, { cursor: JSON.stringify({ ...cursor, f: page[0].id }) });
    // More than a page arrived meanwhile: go on soon.
    if (page.length >= SYNC_PAGE) deps.lastForward.delete(job.conversation);
    return true;
  }
  useLocalSearch.setState((s) => ({ syncing: { ...s.syncing, [job.conversation]: true } }));
  try {
    const page = await api.conversations.messages(id, { limit: SYNC_PAGE, before: cursor.b ?? undefined });
    await indexMessages(await decryptPage(deps.mls, job.conversation, page, cursor.r));
    const oldest = page.at(-1);
    const next: SyncCursor = { ...cursor, b: oldest?.id ?? cursor.b, f: cursor.f ?? page[0]?.id ?? null };
    const reachedStart = page.length < SYNC_PAGE;
    const windowStart = deps.now - DEFAULT_WINDOW_DAYS * DAY_MS;
    const pastWindow = !cov.complete && !!oldest && Date.parse(oldest.created_at) < windowStart;
    await idx.setSync(job.conversation, { cursor: JSON.stringify(next), reachedStart, done: reachedStart || pastWindow });
    if (reachedStart || pastWindow) deps.lastForward.set(job.conversation, deps.now);
    return true;
  } finally {
    useLocalSearch.setState((s) => {
      const { [job.conversation]: _, ...rest } = s.syncing;
      return { syncing: rest };
    });
  }
}

let running: { stop: () => void } | null = null;

/** Starts the sync loop (once); returns the stop function. Stops by itself when the store locks. */
export function startSearchSync(): () => void {
  if (running) return running.stop;
  let stopped = false;
  const lastForward = new Map<string, number>();
  const backoff = new Map<string, number>();
  let lastBudget = 0;
  const stop = () => {
    stopped = true;
    running = null;
    onLocalConversationAdded(null);
  };
  onLocalConversationAdded(() => wakeSearchSync());
  running = { stop };
  void (async () => {
    while (!stopped) {
      const hidden = typeof document !== "undefined" && document.hidden;
      try {
        const idx = await localIndex();
        const mls = idx ? await getMls() : null;
        if (!idx || !mls) {
          await sleep(IDLE_MS);
          continue;
        }
        const now = Date.now();
        if (now - lastBudget >= BUDGET_EVERY_MS) {
          lastBudget = now;
          await idx.enforceBudget().catch(() => 0);
          await refreshLocalState(idx);
        }
        const job = pickJob(await idx.coverage(), (q) => mls.hasGroup(q), lastForward, now, backoff);
        if (!job) {
          await sleep(IDLE_MS);
          continue;
        }
        const ok = await runJob(job, { mls, now, lastForward }).catch(() => false);
        // A failing conversation (node unreachable, no access any more) is left alone for a while.
        if (!ok) backoff.set(job.conversation, now + BACKOFF_MS);
        await sleep(hidden ? PAUSE_MS * 5 : PAUSE_MS);
      } catch {
        await sleep(IDLE_MS);
      }
    }
  })();
  return stop;
}
