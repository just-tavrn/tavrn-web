// SPDX-License-Identifier: Apache-2.0
/**
 * Reaction state from realtime events (PROTOCOL.md §6 "Message events carry no per-viewer state"): a `message.update`
 * carries `reactions[].me = false` for every recipient and, for a reaction change, `reaction: { emoji, user, user_id,
 * added }`. The viewer's own flags therefore come from the cached copy (set by the viewer's own requests and the
 * node's responses) and change only when the event names the viewer as the reactor; `me` is never taken from an event.
 */
import type { Message, ReactionChange } from "@tavrn/sdk";

/** The `data` of a `message.update`: the message and, for a reaction change, the change. */
export type MessageUpdateEvent = Message & { reaction?: ReactionChange | null };

/** The viewer as the node hosting the conversation knows it (user ids are node-local). */
export interface Viewer {
  id: string;
  address: string;
}

function isViewer(change: ReactionChange, viewer: Viewer | null): boolean {
  if (!viewer) return false;
  return change.user_id === viewer.id || change.user.toLowerCase() === viewer.address.toLowerCase();
}

/**
 * The message to keep after a `message.update`: the event's message with the viewer's `me` flags of the cached copy;
 * a reaction change by the viewer (another tab or device) sets or clears the flag of its emoji. The `reaction` field
 * itself is not kept.
 */
export function mergeMessageUpdate(cached: Message | undefined, event: MessageUpdateEvent, viewer: Viewer | null): Message {
  const { reaction, ...message } = event;
  const own = new Map((cached?.reactions ?? []).map((r) => [r.emoji, r.me] as const));
  const mine = reaction && isViewer(reaction, viewer) ? reaction : null;
  const reactions = (message.reactions ?? []).map((r) => {
    const me = mine && mine.emoji === r.emoji ? mine.added : (own.get(r.emoji) ?? false);
    return me === r.me ? r : { ...r, me };
  });
  return { ...message, reactions };
}
