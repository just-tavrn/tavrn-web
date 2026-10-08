// SPDX-License-Identifier: Apache-2.0
/**
 * "Keep the full history on this device" in the client (#4): conversations with the setting (the `complete` flag of
 * the local search index, `search/local.ts`) keep their messages with the decrypted content in the device's
 * {@link HistoryArchive}, up to a size cap per conversation (a device setting, default 50 MB). The message list uses
 * the archived content instead of decrypting again and reads pages from the archive while the node cannot be reached.
 */
import { TavrnApiError, type Message } from "@tavrn/sdk";
import type { Decrypted } from "@tavrn/e2ee";
import { PAGE, type PageParam } from "../lib/messagePages";
import { localArchive, localIndex, refreshLocalState, useLocalSearch } from "../search/local";
import type { ArchiveItem, HistoryArchive } from "./archive";
import { cryptoStore } from "../crypto/store";

export const HISTORY_CAP_DEFAULT_MB = 50;
export const HISTORY_CAP_CHOICES_MB = [10, 50, 100, 250, 500] as const;
const CAP_KEY = "tavrn.history.capMb";
const MB = 1024 * 1024;

/** The cap per conversation in bytes (device setting). */
export function historyCapBytes(): number {
  try {
    const v = Number(localStorage.getItem(CAP_KEY));
    return ((HISTORY_CAP_CHOICES_MB as readonly number[]).includes(v) ? v : HISTORY_CAP_DEFAULT_MB) * MB;
  } catch {
    return HISTORY_CAP_DEFAULT_MB * MB;
  }
}

/** Sets the cap (one of {@link HISTORY_CAP_CHOICES_MB}); a smaller cap applies to the archive right away. */
export function setHistoryCapMb(mb: number): void {
  if (!(HISTORY_CAP_CHOICES_MB as readonly number[]).includes(mb)) return;
  try {
    localStorage.setItem(CAP_KEY, String(mb));
  } catch {
    /* storage unavailable: the default stays */
  }
}

/** Applies the current cap to every archived conversation. */
export async function enforceHistoryCap(deps: Deps = defaults): Promise<void> {
  const archive = await deps.archive();
  if (!archive) return;
  for (const c of await archive.conversations()) await archive.enforce(c, historyCapBytes());
  await refreshLocalState();
}

export interface Deps {
  archive: () => Promise<HistoryArchive | null>;
  /** Does the conversation (qualified id) have "keep the full history on this device"? */
  kept: (q: string) => boolean | Promise<boolean>;
  /** Waits (a few seconds at most) until this device's store is unlocked: right after a start it unlocks itself. */
  unlocked?: () => Promise<void>;
}

/** Waits up to 10 seconds for the crypto store to unlock (it resumes by itself after a reload). */
async function waitForUnlock(): Promise<void> {
  for (let i = 0; i < 40 && !cryptoStore.isUnlocked(); i++) await new Promise((r) => setTimeout(r, 250));
}

/** Asks the index itself: right after a start its state may not be in {@link useLocalSearch} yet. */
async function keptInIndex(q: string): Promise<boolean> {
  if (useLocalSearch.getState().coverage[q]?.complete) return true;
  const idx = await localIndex();
  if (!idx) return false;
  const [cov] = await idx.coverage(q).catch(() => []);
  return !!cov?.complete;
}

const defaults: Deps = { archive: localArchive, kept: keptInIndex, unlocked: waitForUnlock };

let usageTimer: ReturnType<typeof setTimeout> | null = null;

/** Keeps decrypted messages of a conversation with the setting (display path and background sync). */
export async function archiveMessages(q: string, items: ArchiveItem[], deps: Deps = defaults): Promise<void> {
  if (items.length === 0 || !(await deps.kept(q))) return;
  const archive = await deps.archive();
  if (!archive) return;
  await archive.put(q, items, historyCapBytes()).catch(() => undefined);
  // The usage figures follow within a few seconds.
  if (deps === defaults && !usageTimer) {
    usageTimer = setTimeout(() => {
      usageTimer = null;
      void refreshLocalState();
    }, 2000);
  }
}

/** Archived decrypted content of `messages` (only for conversations with the setting). */
export async function archivedDecrypted(q: string, messages: Message[], deps: Deps = defaults): Promise<Map<string, Decrypted>> {
  if (messages.length === 0 || !(await deps.kept(q))) return new Map();
  const archive = await deps.archive();
  return archive ? archive.decrypted(q, messages).catch(() => new Map<string, Decrypted>()) : new Map();
}

/** The node could not be reached (no answer, or a gateway in front of it without one); its own answers do not count. */
export function unreachable(e: unknown): boolean {
  if (!(e instanceof TavrnApiError)) return true;
  return e.code === "network.error" || e.status === 502 || e.status === 503 || e.status === 504;
}

/**
 * A page from the node, or from the archive while the node cannot be reached (a network error, not an answer of the
 * node): offline reading of conversations with the setting.
 */
export async function pageWithArchive(q: string, load: () => Promise<Message[]>, param: PageParam, thread: string | undefined, deps: Deps = defaults): Promise<Message[]> {
  try {
    return await load();
  } catch (e) {
    if (!unreachable(e)) throw e;
    await deps.unlocked?.();
    if (!(await deps.kept(q))) throw e;
    const archive = await deps.archive();
    const page = archive ? await archive.page(q, param, thread ?? null, PAGE).catch(() => []) : [];
    if (page.length === 0 && !(param?.before || param?.after)) throw e;
    return page;
  }
}
