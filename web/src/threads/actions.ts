// SPDX-License-Identifier: Apache-2.0
/** Starting threads (PROTOCOL.md §7e): the request with a sealed title, and the race with another member. */
import { TavrnApiError, type CreateMessageRequest, type TavrnApi, type Thread } from "@tavrn/sdk";
import { qualify } from "@tavrn/e2ee";
import { sealTitle } from "./titles";
import { useThreads } from "./store";

export interface StartThread {
  api: TavrnApi;
  domain: string;
  roomId: string;
  channelId: string;
  encrypted: boolean;
  title: string;
  rootMessageId?: string;
  tags?: string[];
  /** The first message (forum posts), already sealed for the channel. */
  message?: CreateMessageRequest;
}

/**
 * Starts a thread and returns its id. When the root already has a thread (another member was faster), that thread's
 * id comes back instead. The creator follows the thread.
 */
export async function startThread(s: StartThread): Promise<string> {
  const title = await sealTitle(qualify(s.domain, s.channelId), s.encrypted, s.title, null);
  try {
    const thread: Thread = await s.api.threads.create(s.roomId, s.channelId, {
      ...title,
      ...(s.rootMessageId ? { root_message_id: s.rootMessageId } : {}),
      ...(s.tags?.length ? { tags: s.tags } : {}),
      ...(s.message ? { message: s.message } : {}),
    });
    useThreads.getState().state({ thread_id: thread.id, channel_id: thread.channel_id, room_id: thread.room_id, following: true, last_read_message_id: thread.last_message_id ?? null, unread_count: 0, mention_count: 0 });
    return thread.id;
  } catch (e) {
    const existing = e instanceof TavrnApiError && e.code === "thread.exists" ? (e.problem as { meta?: { thread_id?: unknown } }).meta?.thread_id : undefined;
    if (typeof existing === "string") return existing;
    throw e;
  }
}
