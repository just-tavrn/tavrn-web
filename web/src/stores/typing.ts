// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

interface TypingState {
  /** channelId → userId → Ablaufzeit */
  byChannel: Record<string, Record<string, number>>;
  mark: (channelId: string, userId: string) => void;
  prune: () => void;
}

export const useTyping = create<TypingState>((set) => ({
  byChannel: {},
  mark: (channelId, userId) =>
    set((s) => ({ byChannel: { ...s.byChannel, [channelId]: { ...(s.byChannel[channelId] ?? {}), [userId]: Date.now() + 6000 } } })),
  prune: () =>
    set((s) => {
      const now = Date.now();
      const next: Record<string, Record<string, number>> = {};
      for (const [c, users] of Object.entries(s.byChannel)) {
        const alive = Object.fromEntries(Object.entries(users).filter(([, t]) => t > now));
        if (Object.keys(alive).length) next[c] = alive;
      }
      return { byChannel: next };
    }),
}));
