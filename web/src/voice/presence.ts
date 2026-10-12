// SPDX-License-Identifier: Apache-2.0
/**
 * Who is in which voice channel (VOICE.md §5), for the channel lists of every room the user sees, also
 * when the user is not in a call: seeded from `GET /rooms/{id}/voice`, then replaced per channel by
 * `voice.state` events of the room's node. Keys are `<node domain>/<channel id>` because ids are
 * node-scoped. Speaking is not part of this store (`speaking.ts`, only for the own call).
 *
 * Screen publishers (VOICE.md §4b: a device's second participant that only shares its screen, `screen_of` set) are
 * kept apart in `screens`: they are their device's stream, not people, so every list, count and cue of participants
 * stays as it was; the stage adds their streams (`screensOf`).
 */
import { create } from "zustand";
import type { VoiceChannelState, VoiceParticipant } from "@tavrn/sdk";

export const channelKey = (domain: string, channelId: string) => `${domain}/${channelId}`;

interface PresenceState {
  /** Participants by channel key (absent = nobody connected), without screen publishers. */
  channels: Record<string, VoiceParticipant[]>;
  /** Screen publishers by channel key (absent = none). */
  screens: Record<string, VoiceParticipant[]>;
  /** The node's MLS epoch of each channel's group as last reported. */
  epochs: Record<string, number | null>;
  /** Room key `<domain>/<room id>` of each channel key. */
  rooms: Record<string, string>;
  apply: (domain: string, state: VoiceChannelState) => void;
  seedRoom: (domain: string, roomId: string, items: VoiceChannelState[]) => void;
  /** Replaces everything known of `domain` (`GET /users/me/voice`: rooms without participants are left out). */
  seedAll: (domain: string, rooms: Array<{ room_id: string; channels: VoiceChannelState[] }>) => void;
  removeChannel: (domain: string, channelId: string) => void;
  clearRoom: (domain: string, roomId: string) => void;
  reset: () => void;
}

const EMPTY: VoiceParticipant[] = [];

/** People and screen publishers of a channel's list. */
function split(list: VoiceParticipant[]): { people: VoiceParticipant[]; screens: VoiceParticipant[] } {
  if (!list.some((p) => p.screen_of)) return { people: list, screens: EMPTY };
  return { people: list.filter((p) => !p.screen_of), screens: list.filter((p) => !!p.screen_of) };
}

/** Sets (or, for an empty list, drops) `key` in `record`, in place. */
function put(record: Record<string, VoiceParticipant[]>, key: string, list: VoiceParticipant[]) {
  if (list.length) record[key] = list;
  else delete record[key];
}

function without<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.some((k) => k in record)) return record;
  const next = { ...record };
  for (const k of keys) delete next[k];
  return next;
}

export const useVoicePresence = create<PresenceState>((set) => ({
  channels: {},
  screens: {},
  epochs: {},
  rooms: {},
  apply: (domain, state) =>
    set((s) => {
      const key = channelKey(domain, state.channel_id);
      const { people, screens: published } = split(state.participants);
      const channels = people.length ? { ...s.channels, [key]: people } : without(s.channels, [key]);
      const screens = published.length ? { ...s.screens, [key]: published } : without(s.screens, [key]);
      return { channels, screens, epochs: { ...s.epochs, [key]: state.epoch ?? null }, rooms: { ...s.rooms, [key]: channelKey(domain, state.room_id) } };
    }),
  seedRoom: (domain, roomId, items) =>
    set((s) => {
      const room = channelKey(domain, roomId);
      const stale = Object.entries(s.rooms)
        .filter(([, r]) => r === room)
        .map(([k]) => k);
      const channels = { ...without(s.channels, stale) };
      const screens = { ...without(s.screens, stale) };
      const epochs = { ...s.epochs };
      const rooms = without(s.rooms, stale);
      for (const item of items) {
        const key = channelKey(domain, item.channel_id);
        const { people, screens: published } = split(item.participants);
        put(channels, key, people);
        put(screens, key, published);
        epochs[key] = item.epoch ?? null;
        rooms[key] = room;
      }
      return { channels, screens, epochs, rooms };
    }),
  seedAll: (domain, list) =>
    set((s) => {
      const prefix = `${domain}/`;
      const stale = Object.entries(s.rooms)
        .filter(([, r]) => r.startsWith(prefix))
        .map(([k]) => k);
      const channels = { ...without(s.channels, stale) };
      const screens = { ...without(s.screens, stale) };
      const epochs = { ...s.epochs };
      const rooms = without(s.rooms, stale);
      for (const room of list) {
        for (const item of room.channels) {
          const key = channelKey(domain, item.channel_id);
          const { people, screens: published } = split(item.participants);
          put(channels, key, people);
          put(screens, key, published);
          epochs[key] = item.epoch ?? null;
          rooms[key] = channelKey(domain, room.room_id);
        }
      }
      return { channels, screens, epochs, rooms };
    }),
  removeChannel: (domain, channelId) =>
    set((s) => {
      const key = channelKey(domain, channelId);
      return { channels: without(s.channels, [key]), screens: without(s.screens, [key]), epochs: without(s.epochs, [key]), rooms: without(s.rooms, [key]) };
    }),
  clearRoom: (domain, roomId) =>
    set((s) => {
      const room = channelKey(domain, roomId);
      const keys = Object.entries(s.rooms)
        .filter(([, r]) => r === room)
        .map(([k]) => k);
      return { channels: without(s.channels, keys), screens: without(s.screens, keys), epochs: without(s.epochs, keys), rooms: without(s.rooms, keys) };
    }),
  reset: () => set({ channels: {}, screens: {}, epochs: {}, rooms: {} }),
}));

type Snapshot = Pick<PresenceState, "channels" | "rooms">;

/** Participants of a channel (a stable empty list when nobody is connected), without screen publishers. */
export function participantsOf(s: Snapshot, domain: string, channelId: string): VoiceParticipant[] {
  return s.channels[channelKey(domain, channelId)] ?? EMPTY;
}

/** The screen publishers of a channel (VOICE.md §4b; a stable empty list when there are none). */
export function screensOf(s: Pick<PresenceState, "screens">, domain: string, channelId: string): VoiceParticipant[] {
  return s.screens[channelKey(domain, channelId)] ?? EMPTY;
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
