// SPDX-License-Identifier: Apache-2.0
/**
 * The view after a moderator's move (`voice.move`, VOICE.md §7, issue #196): once the call has rejoined the target
 * channel, a client that showed the old voice channel opens the target channel (same room, same node scope); any
 * other open route stays. A toast names the new channel either way (with a jump link when the view stayed). Nothing
 * happens for a move that was not followed (the rejoin failed, the user left voice meanwhile): the lifecycle's
 * `followMove` decides that.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { RoomDetail } from "@tavrn/sdk";
import { roomPath } from "../components/NodeScope";
import { t } from "../i18n";
import { channelName } from "../lib/names";
import { apiFor } from "../stores/nodes";
import { useToasts } from "../stores/toasts";

export interface MoveData {
  room_id: string;
  from_channel_id: string;
  channel_id: string;
}

/** The route to open after the move: the target channel when `pathname` shows the old one, otherwise null. */
export function followedPath(pathname: string, domain: string, data: MoveData): string | null {
  const old = roomPath(domain, data.room_id, data.from_channel_id);
  if (pathname !== old && !pathname.startsWith(`${old}/`)) return null;
  return roomPath(domain, data.room_id, data.channel_id);
}

/** The target channel's display name (the room detail of the cache, fetched once if missing); null when unknown. */
async function targetName(queryClient: QueryClient, domain: string, data: MoveData): Promise<string | null> {
  try {
    const room = await queryClient.fetchQuery<RoomDetail>({ queryKey: ["room", data.room_id], queryFn: () => apiFor(domain).rooms.get(data.room_id), staleTime: 60_000 });
    const channel = room.channels.find((c) => c.id === data.channel_id);
    return channel ? channelName(channel) : null;
  } catch {
    return null;
  }
}

/** After a followed move: opens the target channel if the old one was open, and tells the user where they are now. */
export async function followMoveView(ctx: { domain: string; data: MoveData; pathname: string; navigate: (path: string) => void; queryClient: QueryClient }): Promise<void> {
  const { domain, data, queryClient } = ctx;
  const next = followedPath(ctx.pathname, domain, data);
  if (next) ctx.navigate(next);
  const name = await targetName(queryClient, domain, data);
  useToasts.getState().push({
    kind: "info",
    title: name ? t("voice.moved_to", { channel: name }) : t("voice.moved"),
    testId: "voice-moved",
    path: next ? undefined : roomPath(domain, data.room_id, data.channel_id),
  });
}
