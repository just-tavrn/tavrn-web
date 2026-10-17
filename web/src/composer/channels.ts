// SPDX-License-Identifier: Apache-2.0
/**
 * The `#channel` provider of the composer's autocomplete (docs/CLIENT.md "The composer"). Candidates are the channels
 * of the CURRENT room the user can view (any kind; the same permission rules as the channel list), never channels of
 * other rooms and none in DMs. Picking inserts the channel's canonical link (`lib/tavrnLinks.ts` `channelUrl`), which
 * readers see as a `#name` chip. The trigger needs at least one character after `#` and matches only name prefixes,
 * so `#1`, `C#` or a Markdown heading are never taken over.
 */
import { Permission, hasPermission, type RoomDetail } from "@tavrn/sdk";
import { channelPermissions } from "../lib/channelPermissions";
import { categoryName, channelName } from "../lib/names";
import { channelUrl } from "../lib/tavrnLinks";
import { MAX_SUGGESTIONS, type CompletionProvider, type Suggestion } from "./autocomplete";

export interface ChannelCandidate {
  /** The channel id. */
  key: string;
  /** The channel's link (without the trailing space). */
  insert: string;
  /** Shown name (default channels localized). */
  name: string;
  /** text, voice, files, forum, announcement, system. */
  kind: string;
  /** The category's shown name, null outside categories. */
  category: string | null;
}

/** The channels of `room` the user (`userId`, the room node's user id) can view, in the room's order. */
export function channelCandidates(src: { room: RoomDetail; userId: string; domain: string }): ChannelCandidate[] {
  // Partial room objects (an older node, a cache entry being filled) offer what they have.
  const r = src.room;
  const room: RoomDetail = r.channels && r.categories && r.roles && r.overrides && r.my_roles ? r : { ...r, channels: r.channels ?? [], categories: r.categories ?? [], roles: r.roles ?? [], overrides: r.overrides ?? [], my_roles: r.my_roles ?? [] };
  const categories = new Map(room.categories.map((c) => [c.id, categoryName(c)]));
  return [...room.channels]
    .filter((c) => hasPermission(channelPermissions(room, c.id, src.userId), Permission.VIEW_CHANNEL))
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      key: c.id,
      insert: channelUrl(src.domain, room.id, c.id),
      name: channelName(c),
      kind: c.kind,
      category: c.category_id ? (categories.get(c.category_id) ?? null) : null,
    }));
}

/** Channels whose name, or a word of it, starts with `query` (a query with a space: the whole name), at most eight. */
export function matchChannels(candidates: ChannelCandidate[], query: string): ChannelCandidate[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const scored = candidates
    .map((c, index) => {
      const name = c.name.toLowerCase();
      const score = name.startsWith(q) ? 2 : !/\s/.test(q) && name.split(/[\s_\-.]+/).some((w) => w.startsWith(q)) ? 1 : 0;
      return { c, index, score };
    })
    .filter((x) => x.score > 0);
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.c);
}

export function channelProvider(candidates: ChannelCandidate[]): CompletionProvider<ChannelCandidate> {
  return {
    id: "channel",
    trigger: "#",
    minQuery: 1,
    suggest: (query): Suggestion<ChannelCandidate>[] => matchChannels(candidates, query).map((c) => ({ key: c.key, insert: c.insert, data: c })),
  };
}
