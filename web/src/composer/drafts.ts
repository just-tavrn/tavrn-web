// SPDX-License-Identifier: Apache-2.0
/**
 * Unsent composer text per conversation (docs/CLIENT.md "The composer"): switching to another channel, DM or the
 * settings and back finds the text where it was. Kept ONLY in this module's memory: never in localStorage,
 * sessionStorage, IndexedDB or on disk, never sent anywhere, gone when the tab or app closes. Encrypted
 * conversations follow the same rule (the draft is plaintext the user typed, like the textarea's own content).
 * Every draft is dropped when the account ends or the app locks ({@link clearDrafts}, called by `stores/e2ee`
 * `forgetUnlocked`); a composer still mounted at that moment cannot write its text back (the generation changed).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface Draft {
  text: string;
  /** The message being answered (ConversationView's reply bar). */
  reply?: unknown;
}

/** Drafts kept at most; the least recently written goes first. */
export const MAX_DRAFTS = 200;
/** Writes are debounced by this much while typing (the unmount writes at once). */
export const DRAFT_DEBOUNCE_MS = 300;

const drafts = new Map<string, Draft>();
let generation = 0;

/** The key of a conversation's draft: account, node, conversation and thread; null without an account. */
export function draftKey(account: string | null | undefined, node: string, conversation: string, thread?: string | null): string | null {
  if (!account || !conversation) return null;
  return [account.toLowerCase(), node.toLowerCase(), conversation, thread ?? ""].join("\u0000");
}

export function getDraft(key: string | null | undefined): Draft | undefined {
  return key ? drafts.get(key) : undefined;
}

/** Changes after every {@link clearDrafts}: writes of an older generation are ignored. */
export function draftGeneration(): number {
  return generation;
}

function put(key: string, patch: Partial<Draft>, gen: number) {
  if (gen !== generation) return;
  const next = { text: "", ...drafts.get(key), ...patch };
  drafts.delete(key);
  if (!next.text && !next.reply) return;
  drafts.set(key, next);
  if (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value as string);
}

export function saveDraftText(key: string, text: string, gen = generation): void {
  put(key, { text }, gen);
}

export function saveDraftReply(key: string, reply: unknown, gen = generation): void {
  put(key, { reply: reply ?? undefined }, gen);
}

/** The text was sent: the draft goes (the reply goes with the send as well). */
export function clearDraft(key: string | null | undefined): void {
  if (key) drafts.delete(key);
}

/** Sign-out, another account, the app locking: every draft leaves memory. */
export function clearDrafts(): void {
  generation++;
  drafts.clear();
}

/** Number of drafts (tests, diagnostics). */
export function draftCount(): number {
  return drafts.size;
}

/**
 * Keeps the composer text of `key` in the draft memory: restores it on mount (and when the key changes), writes it
 * debounced while typing and at once on unmount. `restore` sets the composer's value (the caret goes to its end).
 */
export function useDraft(key: string | null | undefined, value: string, restore: (text: string) => void): void {
  const gen = useRef(generation);
  const latest = useRef(value);
  latest.current = value;
  const mounted = useRef(false);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useLayoutEffect(() => {
    if (!key) return;
    gen.current = generation;
    const text = drafts.get(key)?.text ?? "";
    // Another conversation in the same composer: its own draft (or an empty box).
    if (text || mounted.current) {
      latest.current = text;
      restoreRef.current(text);
    }
    mounted.current = true;
    return () => saveDraftText(key, latest.current, gen.current);
  }, [key]);
  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => saveDraftText(key, value, gen.current), DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, value]);
}

/** The reply target of a conversation's draft: kept and restored like the text. */
export function useDraftReply<T>(key: string | null | undefined): [T | null, (next: T | null) => void] {
  const gen = useRef(generation);
  const [reply, setReply] = useState<T | null>(() => (getDraft(key)?.reply as T | undefined) ?? null);
  useEffect(() => {
    if (key) saveDraftReply(key, reply, gen.current);
  }, [key, reply]);
  return [reply, setReply];
}
