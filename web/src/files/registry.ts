// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted files channels this tab has open, by qualified conversation id → room id. History key checks
 * (ENCRYPTION.md §7b, `crypto/history.ts`) use entry records instead of messages for them (FILES.md §8.7): the
 * files routes need the room id, which the conversation routes do not.
 */
import { create } from "zustand";

const open = new Map<string, string>();

/** Registers an encrypted files channel while its view is mounted; returns the cleanup. */
export function registerFilesChannel(conversation: string, roomId: string): () => void {
  open.set(conversation, roomId);
  return () => {
    if (open.get(conversation) === roomId) open.delete(conversation);
  };
}

/** The room of an open encrypted files channel, or undefined for every other conversation. */
export function filesChannelRoom(conversation: string): string | undefined {
  return open.get(conversation);
}

/** Bumps whenever history keys arrived (any conversation): open files views decrypt their records again. */
export const useHistoryKeys = create<{ version: number; bump: () => void }>((set) => ({ version: 0, bump: () => set((s) => ({ version: s.version + 1 })) }));
