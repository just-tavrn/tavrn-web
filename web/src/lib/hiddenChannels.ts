// SPDX-License-Identifier: Apache-2.0
// Channels that disappeared because the user lost access to them, not because they were deleted (PROTOCOL.md §6
// "Audiences of the room's metadata": `channel.delete` with `hidden: true`). The channel page then says so instead
// of "Channel not found"; the local search index keeps the channel's messages (access may come back).
import { create } from "zustand";

interface HiddenChannels {
  /** Ids of channels hidden from the user (channel ids are ULIDs, unique across nodes). */
  ids: Record<string, true>;
  /** A `channel.delete`: a hidden channel is remembered, a real deletion forgets it. */
  deleted: (event: { id?: string; hidden?: boolean }) => void;
  /** A `channel.create`: the channel is visible (again). */
  created: (id: string | undefined) => void;
}

export const useHiddenChannels = create<HiddenChannels>((set) => ({
  ids: {},
  deleted: ({ id, hidden }) => {
    if (!id) return;
    set((s) => {
      const ids = { ...s.ids };
      if (hidden === true) ids[id] = true;
      else delete ids[id];
      return { ids };
    });
  },
  created: (id) => {
    if (!id) return;
    set((s) => {
      if (!s.ids[id]) return s;
      const ids = { ...s.ids };
      delete ids[id];
      return { ids };
    });
  },
}));

/** Is a `channel.delete` event a real deletion (the channel's local search entries go with it)? */
export function isRealDeletion(event: { hidden?: boolean }): boolean {
  return event.hidden !== true;
}
