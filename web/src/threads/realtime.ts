// SPDX-License-Identifier: Apache-2.0
/**
 * Realtime events of threads (PROTOCOL.md §7e): `thread.create|update|delete` refresh the lists and the summary
 * under the root message, `thread.read` moves the follow state and read markers, and thread messages go to the open
 * thread instead of the channel. Thread messages count and notify only for followers (and direct mentions).
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Message, TavrnSocket, Thread, ThreadReadState, ThreadSummary } from "@tavrn/sdk";
import { mapMessages, messagesKey, prependMessage, type MessagePages } from "../lib/messagePages";
import { isAttentive } from "../hooks/useMarkRead";
import { useUnread } from "../stores/unread";
import { useThreads } from "./store";

/** The summary under a root message, from a thread object. */
export function summaryOf(t: Thread): ThreadSummary {
  return { id: t.id, message_count: t.message_count, last_message_id: t.last_message_id ?? null, last_message_at: t.last_message_at, participant_ids: t.participant_ids, archived_at: t.archived_at ?? null, locked: t.locked };
}

/** Sets (or with null removes) the thread summary of the root message in the channel's loaded pages. */
export function patchRoot(queryClient: QueryClient, channelId: string, rootId: string | null | undefined, threadId: string, summary: ThreadSummary | null) {
  const key = messagesKey(channelId);
  if (!queryClient.getQueryData(key)) return;
  queryClient.setQueryData<MessagePages<Message>>(key, (d) =>
    mapMessages(d, (page) =>
      page.some((m) => m.id === rootId || m.thread?.id === threadId)
        ? page.map((m) => {
            if (summary && m.id === rootId) return { ...m, thread: summary };
            if (!summary && m.thread?.id === threadId) {
              const { thread: _gone, ...rest } = m;
              return rest as Message;
            }
            return m;
          })
        : page,
    ),
  );
}

/** Applies a thread's read state and keeps the channel's count (which includes followed threads) in step. */
export function applyThreadState(s: ThreadReadState) {
  const before = useThreads.getState().followed[s.thread_id];
  useThreads.getState().state(s);
  const after = useThreads.getState().followed[s.thread_id];
  const delta = (after?.unread ?? 0) - (before?.unread ?? 0);
  const mentions = (after?.mentions ?? 0) - (before?.mentions ?? 0);
  if (delta || mentions) useUnread.getState().bump(s.channel_id, delta, mentions);
}

/**
 * A new thread message: into the open thread's pages; counted (thread and channel) only in followed threads unless the
 * thread is open in a focused tab. Returns whether it concerns the user (notifications).
 */
export function threadMessage(m: Message, queryClient: QueryClient, me: { id: string; address: string } | null): boolean {
  const thread = m.thread_id!;
  const key = messagesKey(m.conversation_id, thread);
  if (queryClient.getQueryData(key)) queryClient.setQueryData<MessagePages<Message>>(key, (d) => prependMessage(d, m));
  if (!me) return false;
  const followed = !!useThreads.getState().followed[thread];
  const active = useThreads.getState().open === thread && isAttentive();
  if (followed && !active && m.author_id !== me.id) {
    useThreads.getState().message(m, me, false);
    useUnread.getState().bump(m.conversation_id, 1, m.mentions_everyone || (m.mentions ?? []).includes(me.address) ? 1 : 0);
  }
  return followed || (m.mentions ?? []).includes(me.address);
}

export function threadHandlers(socket: TavrnSocket, queryClient: QueryClient): Array<() => void> {
  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: ["threads"] });
    void queryClient.invalidateQueries({ queryKey: ["followed-threads"] });
  };
  const changed = (d: { room_id: string; thread: Thread }) => {
    patchRoot(queryClient, d.thread.channel_id, d.thread.root_message_id, d.thread.id, summaryOf(d.thread));
    // The open thread keeps its per-user state; the rest comes from the event.
    for (const [key, old] of queryClient.getQueriesData<Thread>({ queryKey: ["thread"] })) {
      if (old?.id === d.thread.id) queryClient.setQueryData<Thread>(key, { ...old, ...d.thread, me: old.me, root_message: old.root_message, first_message: old.first_message });
    }
    refreshLists();
  };
  return [
    socket.on<{ room_id: string; thread: Thread }>("thread.create", changed),
    socket.on<{ room_id: string; thread: Thread }>("thread.update", changed),
    socket.on<{ room_id: string; channel_id: string; id: string }>("thread.delete", (d) => {
      patchRoot(queryClient, d.channel_id, null, d.id, null);
      queryClient.removeQueries({ queryKey: messagesKey(d.channel_id, d.id), exact: true });
      void queryClient.invalidateQueries({ queryKey: ["thread"] });
      const f = useThreads.getState().followed[d.id];
      if (f) applyThreadState({ thread_id: d.id, channel_id: f.channelId, room_id: f.roomId, following: false, last_read_message_id: null, unread_count: 0, mention_count: 0 });
      refreshLists();
    }),
    socket.on<ThreadReadState>("thread.read", (s) => applyThreadState(s)),
  ];
}
