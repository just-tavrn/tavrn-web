// SPDX-License-Identifier: Apache-2.0
/** Starting threads (PROTOCOL.md §7e): the request with a sealed title, and the race with another member. */
import { TavrnApiError, newUlid, type CreateMessageRequest, type TavrnApi, type Thread } from "@tavrn/sdk";
import { qualify, type MlsManager } from "@tavrn/e2ee";
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
  /** The thread id chosen by the client (node capability `threads.client_ids`); the first message is signed with it. */
  id?: string;
}

/**
 * Starts a thread and returns its id. When the root already has a thread (another member was faster), that thread's
 * id comes back instead. The creator follows the thread.
 */
export async function startThread(s: StartThread): Promise<string> {
  const title = await sealTitle(qualify(s.domain, s.channelId), s.encrypted, s.title, null);
  try {
    const thread: Thread = await s.api.threads.create(s.roomId, s.channelId, {
      ...(s.id ? { id: s.id } : {}),
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

export interface NewPost {
  api: TavrnApi;
  domain: string;
  roomId: string;
  channelId: string;
  encrypted: boolean;
  title: string;
  tags: string[];
  body: string;
  /** The device's session manager (encrypts, signs); null before E2EE is unlocked. */
  mls: Pick<MlsManager, "encrypt" | "signPlaintext"> | null;
  /** The node announces `threads.client_ids` (PROTOCOL.md §3): it keeps the client's thread id. */
  clientIds: boolean;
  /** Thread ids (tests). */
  newId?: () => string;
}

/**
 * Creates a forum post (PROTOCOL.md §7e) and returns its id. Where the node keeps the client's thread id, the client
 * picks it so the device signature of a plaintext first message covers `thread_id` like every reply
 * (FEDERATION.md §10.3); a node that refuses the id (this device's clock is far off) gets the post with an unsigned
 * first message instead, which readers show as unverified.
 */
export async function createPost(p: NewPost): Promise<string> {
  const content = { type: "text", body: p.body };
  const base = { api: p.api, domain: p.domain, roomId: p.roomId, channelId: p.channelId, encrypted: p.encrypted, title: p.title, tags: p.tags };
  const q = qualify(p.domain, p.channelId);
  if (p.encrypted) {
    if (!p.mls) throw new Error("e2ee locked");
    return startThread({ ...base, message: await p.mls.encrypt(q, content) });
  }
  const id = p.clientIds && p.mls ? (p.newId ?? newUlid)() : undefined;
  const signature = id ? p.mls?.signPlaintext(q, { reply_to: null, thread_id: id, mentions_everyone: false, mentions: [], attachments: [] }, content) : null;
  if (!id || !signature) return startThread({ ...base, message: { content } });
  try {
    return await startThread({ ...base, id, message: { content, mentions: [], signature } });
  } catch (e) {
    if (e instanceof TavrnApiError && e.code === "thread.id_invalid") return startThread({ ...base, message: { content } });
    throw e;
  }
}
