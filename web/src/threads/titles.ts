// SPDX-License-Identifier: Apache-2.0
/**
 * Thread titles (PROTOCOL.md §7e): plaintext in unencrypted channels, ciphertext of `{ type: "thread.title", body }`
 * in encrypted ones, decrypted and verified here like message content. Results live in memory only.
 */
import { useEffect, useMemo, useState } from "react";
import type { Thread } from "@tavrn/sdk";
import { THREAD_TITLE_MAX, type MlsManager } from "@tavrn/e2ee";
import { getMls } from "../stores/mls";

/** A decrypted title, or null when it cannot be read (missing key, bad signature, …). */
export type TitleResult = string | null;

/** A title from free text: one line, at most 100 characters, never empty. */
export function defaultTitle(text: string, fallback: string): string {
  const line = Array.from(text.replace(/\s+/g, " ").trim());
  const title = line.length > THREAD_TITLE_MAX ? `${line.slice(0, THREAD_TITLE_MAX - 1).join("")}…` : line.join("");
  return title || fallback;
}

/** The title to send for `channel`: plaintext, or ciphertext with its epoch in encrypted channels. */
export async function sealTitle(q: string, encrypted: boolean, title: string, mls: MlsManager | null): Promise<{ title: string; title_epoch?: number }> {
  if (!encrypted) return { title: title.trim() };
  const manager = mls ?? (await getMls());
  if (!manager) throw new Error("locked");
  return manager.encryptThreadTitle(q, title);
}

/** Titles of `threads` (thread id → title, null if unreadable); plaintext ones at once, encrypted ones decrypted. */
export function useThreadTitles(q: string, threads: Thread[] | undefined, tick = 0): Record<string, TitleResult> {
  const [map, setMap] = useState<Record<string, TitleResult>>({});
  const list = useMemo(() => threads ?? [], [threads]);
  const plain = useMemo(() => Object.fromEntries(list.filter((t) => !t.encrypted).map((t) => [t.id, t.title])), [list]);
  useEffect(() => {
    const encrypted = list.filter((t) => t.encrypted);
    if (encrypted.length === 0) return;
    let cancelled = false;
    void (async () => {
      const mls = await getMls();
      const next: Record<string, TitleResult> = {};
      for (const t of encrypted) {
        if (!mls) {
          next[t.id] = null;
          continue;
        }
        try {
          const r = await mls.decryptThreadTitle(q, t);
          next[t.id] = r.ok ? r.title : null;
        } catch {
          next[t.id] = null;
        }
      }
      if (!cancelled) setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [q, list, tick]);
  return useMemo(() => ({ ...map, ...plain }), [map, plain]);
}
