// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

interface TypingState {
  /** channelId → userId → expiry time */
  byChannel: Record<string, Record<string, number>>;
  mark: (channelId: string, userId: string) => void;
  /**
   * Drops expired entries (every 2 s). Nothing expired: the state stays the same object, so no view re-renders;
   * channels without an expired entry keep their object too.
   */
  prune: (now?: number) => void;
}

export const useTyping = create<TypingState>((set) => ({
  byChannel: {},
  mark: (channelId, userId) =>
    set((s) => ({ byChannel: { ...s.byChannel, [channelId]: { ...(s.byChannel[channelId] ?? {}), [userId]: Date.now() + 6000 } } })),
  prune: (now = Date.now()) =>
    set((s) => {
      let changed = false;
      const next: Record<string, Record<string, number>> = {};
      for (const [c, users] of Object.entries(s.byChannel)) {
        const entries = Object.entries(users);
        const alive = entries.filter(([, t]) => t > now);
        if (alive.length === entries.length) {
          next[c] = users;
          continue;
        }
        changed = true;
        if (alive.length) next[c] = Object.fromEntries(alive);
      }
      return changed ? { byChannel: next } : s;
    }),
}));
