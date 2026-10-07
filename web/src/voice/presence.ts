// SPDX-License-Identifier: Apache-2.0
/**
 * Who is in which voice channel (VOICE.md §5), for the channel lists of every room the user sees, also
 * when the user is not in a call: seeded from `GET /rooms/{id}/voice`, then replaced per channel by
 * `voice.state` events of the room's node. Keys are `<node domain>/<channel id>` because ids are
 * node-scoped. Speaking is not part of this store (`speaking.ts`, only for the own call).
 */
import { create } from "zustand";
import type { VoiceChannelState, VoiceParticipant } from "@tavrn/sdk";

export const channelKey = (domain: string, channelId: string) => `${domain}/${channelId}`;

interface PresenceState {
  /** Participants by channel key (absent = nobody connected). */
  channels: Record<string, VoiceParticipant[]>;
  /** The node's MLS epoch of each channel's group as last reported. */
  epochs: Record<string, number | null>;
  /** Room key `<domain>/<room id>` of each channel key. */
  rooms: Record<string, string>;
  apply: (domain: string, state: VoiceChannelState) => void;
  seedRoom: (domain: string, roomId: string, items: VoiceChannelState[]) => void;
  removeChannel: (domain: string, channelId: string) => void;
  clearRoom: (domain: string, roomId: string) => void;
  reset: () => void;
}

const EMPTY: VoiceParticipant[] = [];

function without<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.some((k) => k in record)) return record;
  const next = { ...record };
  for (const k of keys) delete next[k];
  return next;
}

export const useVoicePresence = create<PresenceState>((set) => ({
  channels: {},
  epochs: {},
  rooms: {},
  apply: (domain, state) =>
    set((s) => {
      const key = channelKey(domain, state.channel_id);
      const channels = state.participants.length ? { ...s.channels, [key]: state.participants } : without(s.channels, [key]);
      return { channels, epochs: { ...s.epochs, [key]: state.epoch ?? null }, rooms: { ...s.rooms, [key]: channelKey(domain, state.room_id) } };
    }),
  seedRoom: (domain, roomId, items) =>
    set((s) => {
      const room = channelKey(domain, roomId);
      const stale = Object.entries(s.rooms)
        .filter(([, r]) => r === room)
        .map(([k]) => k);
      const channels = without(s.channels, stale);
      const epochs = { ...s.epochs };
      const rooms = without(s.rooms, stale);
      for (const item of items) {
        const key = channelKey(domain, item.channel_id);
        if (item.participants.length) channels[key] = item.participants;
        epochs[key] = item.epoch ?? null;
        rooms[key] = room;
      }
      return { channels, epochs, rooms };
    }),
  removeChannel: (domain, channelId) =>
    set((s) => {
      const key = channelKey(domain, channelId);
      return { channels: without(s.channels, [key]), epochs: without(s.epochs, [key]), rooms: without(s.rooms, [key]) };
    }),
  clearRoom: (domain, roomId) =>
    set((s) => {
      const room = channelKey(domain, roomId);
      const keys = Object.entries(s.rooms)
        .filter(([, r]) => r === room)
        .map(([k]) => k);
      return { channels: without(s.channels, keys), epochs: without(s.epochs, keys), rooms: without(s.rooms, keys) };
    }),
  reset: () => set({ channels: {}, epochs: {}, rooms: {} }),
}));

type Snapshot = Pick<PresenceState, "channels" | "rooms">;

/** Participants of a channel (a stable empty list when nobody is connected). */
export function participantsOf(s: Snapshot, domain: string, channelId: string): VoiceParticipant[] {
  return s.channels[channelKey(domain, channelId)] ?? EMPTY;
}

/** The voice channel of `roomId` the user is connected to (any device), or null. */
export function voiceChannelOfUser(s: Snapshot, domain: string, roomId: string, userId: string): string | null {
  const room = channelKey(domain, roomId);
  for (const [key, list] of Object.entries(s.channels)) {
    if (s.rooms[key] !== room) continue;
    if (list.some((p) => p.user_id === userId)) return key.slice(domain.length + 1);
  }
  return null;
}
