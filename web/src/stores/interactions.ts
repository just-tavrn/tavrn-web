// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";

/**
 * What the invoker of an application command sees besides messages (tavrn-protocol/APPLICATIONS.md §5.7): "… is
 * thinking" for a deferred interaction, ephemeral replies ("only you can see this") and error notices. Memory
 * only: dropped on reload, a deferred interaction is forgotten when it expires (15 minutes).
 */
export interface InteractionNotice {
  /** Unique per notice (an interaction can have several ephemeral follow-ups). */
  key: string;
  interactionId: string;
  conversationId: string;
  kind: "thinking" | "ephemeral" | "error";
  application: { ref: string; name: string; bot: string };
  /** Ephemeral: the content object, or ciphertext in encrypted conversations. */
  content?: unknown;
  epoch?: number | null;
  deviceId?: string | null;
  /** Error notices: the application's text. */
  text?: string;
  createdAt: number;
}

export const INTERACTION_LIFETIME_MS = 15 * 60 * 1000;
/** Notices kept per conversation (the oldest go first). */
const MAX_PER_CONVERSATION = 20;

interface InteractionsState {
  notices: InteractionNotice[];
  add: (n: Omit<InteractionNotice, "key" | "createdAt"> & { key?: string }) => void;
  /** A message or ephemeral reply arrived for this interaction: "thinking" ends. */
  resolve: (interactionId: string) => void;
  dismiss: (key: string) => void;
  /** Drops expired "thinking" notices. */
  prune: (now?: number) => void;
}

let counter = 0;

export const useInteractions = create<InteractionsState>((set) => ({
  notices: [],
  add: (n) =>
    set((s) => {
      const notice: InteractionNotice = { ...n, key: n.key ?? `${n.interactionId}:${++counter}`, createdAt: Date.now() };
      if (s.notices.some((x) => x.key === notice.key)) return s;
      // An answer replaces the "thinking" notice of its interaction.
      const others = notice.kind === "thinking" ? s.notices : s.notices.filter((x) => !(x.kind === "thinking" && x.interactionId === notice.interactionId));
      const mine = others.filter((x) => x.conversationId === notice.conversationId);
      const drop = mine.length >= MAX_PER_CONVERSATION ? new Set([mine[0]!.key]) : new Set<string>();
      return { notices: [...others.filter((x) => !drop.has(x.key)), notice] };
    }),
  resolve: (interactionId) => set((s) => ({ notices: s.notices.filter((x) => !(x.kind === "thinking" && x.interactionId === interactionId)) })),
  dismiss: (key) => set((s) => ({ notices: s.notices.filter((x) => x.key !== key) })),
  prune: (now = Date.now()) => set((s) => ({ notices: s.notices.filter((x) => x.kind !== "thinking" || now - x.createdAt < INTERACTION_LIFETIME_MS) })),
}));
