// SPDX-License-Identifier: Apache-2.0
/**
 * Security notices in a channel (APPLICATIONS.md §3.6): the node writes `system.bot_added` / `system.bot_removed`
 * about a channel `@everyone` cannot view into that channel itself instead of the room's welcome channel (which every
 * member reads). Such a notice is a quiet inline line: it never counts as unread and never notifies.
 */
import type { Message } from "@tavrn/sdk";

const BOT_ENTRIES = new Set(["system.bot_added", "system.bot_removed"]);

/** Is `m` a node-written bot entry about its own conversation (a security notice in the channel)? */
export function isChannelNotice(m: Pick<Message, "encrypted" | "content" | "conversation_id"> & { device_id?: string | null }): boolean {
  if (m.encrypted || m.device_id || !m.content || typeof m.content !== "object") return false;
  const c = m.content as { type?: unknown; channel?: unknown };
  return typeof c.type === "string" && BOT_ENTRIES.has(c.type) && c.channel === m.conversation_id;
}
