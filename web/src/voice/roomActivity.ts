// SPDX-License-Identifier: Apache-2.0
/**
 * Voice activity derived from the presence store (`presence.ts`) for views outside the channel list: the room rail's
 * speaker/monitor badges and hover card, and where a friend is in voice (docs/CLIENT.md "Voice activity in the room
 * rail and the friends list"). The store holds only channels the node lets the user view (`voice.state` goes to
 * members who can view the channel, `GET /users/me/voice` and `GET /rooms/{id}/voice` are filtered the same way), so
 * these helpers never reveal a channel the user cannot see; rooms the user is not in are excluded by the caller's
 * room list as well.
 */
import type { VoiceParticipant } from "@tavrn/sdk";
import { channelKey } from "./presence";

type Snapshot = { channels: Record<string, VoiceParticipant[]>; rooms: Record<string, string> };

/** The voice channels of a room with their participants (store order: by channel key). */
export interface RoomVoice {
  channels: Array<{ channelId: string; participants: VoiceParticipant[] }>;
  /** Distinct users in voice in the room. */
  count: number;
  /** Somebody shares a screen. */
  streaming: boolean;
}

export const NO_VOICE: RoomVoice = Object.freeze({ channels: [], count: 0, streaming: false }) as RoomVoice;

/** Who is in which voice channel of `roomId` on `domain` (channels the user can view only, see above). */
export function roomVoice(s: Snapshot, domain: string, roomId: string): RoomVoice {
  const room = channelKey(domain, roomId);
  const channels: RoomVoice["channels"] = [];
  const users = new Set<string>();
  let streaming = false;
  for (const [key, list] of Object.entries(s.channels)) {
    if (s.rooms[key] !== room || !list.length) continue;
    channels.push({ channelId: key.slice(domain.length + 1), participants: list });
    for (const p of list) {
      users.add(p.user.toLowerCase());
      if (p.streaming) streaming = true;
    }
  }
  if (!channels.length) return NO_VOICE;
  channels.sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0));
  return { channels, count: users.size, streaming };
}

/** A stable string of a room's voice activity (selectors compare strings, not new objects). */
export function roomVoiceSignature(s: Snapshot, domain: string, roomId: string): string {
  const v = roomVoice(s, domain, roomId);
  return v.count ? `${v.count}:${v.streaming ? 1 : 0}` : "";
}

/** The rail's voice badge: the monitor (somebody streams) takes precedence over the speaker (somebody is in voice). */
export type VoiceBadge = "stream" | "voice" | null;

export function voiceBadge(v: Pick<RoomVoice, "count" | "streaming">): VoiceBadge {
  if (v.streaming) return "stream";
  return v.count > 0 ? "voice" : null;
}

/** Sums the voice activity of several rooms (a collapsed folder). */
export function mergeVoice(list: Array<Pick<RoomVoice, "count" | "streaming">>): Pick<RoomVoice, "count" | "streaming"> {
  return { count: list.reduce((n, v) => n + v.count, 0), streaming: list.some((v) => v.streaming) };
}

/** Where a user is in voice. */
export interface VoiceLocation {
  domain: string;
  roomId: string;
  channelId: string;
}

/**
 * The voice channel `address` is connected to, among the rooms in `memberRooms` (room keys `<domain>/<room id>` of
 * the rooms the user is a member of); null when the user is in no channel the viewer can see. Addresses are
 * compared without case (user ids are node-local, addresses are not).
 */
export function voiceLocationOf(s: Snapshot, address: string, memberRooms: ReadonlySet<string>): VoiceLocation | null {
  const wanted = address.toLowerCase();
  const keys = Object.keys(s.channels).sort();
  for (const key of keys) {
    const room = s.rooms[key];
    if (!room || !memberRooms.has(room)) continue;
    if (!s.channels[key]!.some((p) => p.user.toLowerCase() === wanted)) continue;
    const slash = room.lastIndexOf("/");
    const domain = room.slice(0, slash);
    return { domain, roomId: room.slice(slash + 1), channelId: key.slice(domain.length + 1) };
  }
  return null;
}

/**
 * The first `limit` participants over a room's channels (in order) for avatars; per channel the ones shown and how
 * many more it has ("+n").
 */
export function avatarSlice<T>(channels: Array<{ participants: T[] }>, limit: number): Array<{ shown: T[]; more: number }> {
  let left = limit;
  return channels.map((c) => {
    const shown = c.participants.slice(0, Math.max(0, left));
    left -= shown.length;
    return { shown, more: c.participants.length - shown.length };
  });
}
