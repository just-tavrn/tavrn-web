// SPDX-License-Identifier: Apache-2.0
/**
 * Bots and encrypted channels in the client (design note 4.7, APPLICATIONS.md §3.5): which marker a channel gets in the
 * lists, and the "no bots" input of the ghost rule (ENCRYPTION.md §4.6). The client recomputes the effective flag
 * from the room and channel settings with the shared rule (`noBotsEffective` of the SDK) and ORs it with the node's
 * `no_bots_effective`, so a node can never make a channel look open to bots that the room closed.
 */
import { noBotsEffective, type Category, type Channel } from "@tavrn/sdk";

export interface BotRoomData {
  no_bots?: boolean;
  bots_in_encrypted_channels?: string | null;
  categories?: Pick<Category, "id" | "no_bots">[];
}

type BotChannel = Pick<Channel, "category_id" | "encrypted"> & { no_bots?: boolean; no_bots_effective?: boolean; bots_allowed?: boolean; kind?: string };

/** The channel, its category or the room set "no bots" explicitly. */
export function explicitNoBots(channel: BotChannel, room: BotRoomData): boolean {
  if (channel.no_bots || room.no_bots) return true;
  return !!room.categories?.find((c) => c.id === channel.category_id)?.no_bots;
}

/** The "no bots" input of the ghost rule: the node's flag or the client's own computation. */
export function ghostNoBots(channel: BotChannel | undefined, room: BotRoomData | undefined): boolean {
  if (!channel) return false;
  if (channel.no_bots_effective) return true;
  if (!room || channel.kind === "system") return false;
  return noBotsEffective({
    room_no_bots: room.no_bots,
    category_no_bots: !!room.categories?.find((c) => c.id === channel.category_id)?.no_bots,
    channel_no_bots: channel.no_bots,
    encrypted: channel.encrypted,
    bots_allowed: channel.bots_allowed,
    bots_in_encrypted_channels: room.bots_in_encrypted_channels ?? "allowed",
  });
}

/** Which bot marker the channel list shows: an explicit "no bots" zone, an encrypted channel that admits bots, none. */
export function botMarker(channel: BotChannel, room: BotRoomData): "no_bots" | "bots_allowed" | null {
  if (explicitNoBots(channel, room)) return "no_bots";
  if (channel.encrypted && channel.bots_allowed && room.bots_in_encrypted_channels === "per_channel" && !channel.no_bots_effective) return "bots_allowed";
  return null;
}
