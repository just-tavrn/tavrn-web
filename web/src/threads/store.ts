// SPDX-License-Identifier: Apache-2.0
/**
 * Followed threads (PROTOCOL.md §7e): which threads the user follows, their read markers and unread counts, and
 * which thread is open. The node is the source of truth (`GET /rooms/{id}/followed-threads`, the thread objects'
 * `me`); `thread.read` and `message.create` keep the state current in between. Only followed threads count
 * towards unread badges and notifications; the channel's own counts from the room detail already include them.
 */
import { create } from "zustand";
import type { Message, ThreadReadState } from "@tavrn/sdk";
import { UNREAD_CAP } from "../stores/unread";

export interface FollowedThread {
  threadId: string;
  channelId: string;
  roomId: string;
  lastRead: string | null;
  unread: number;
  mentions: number;
}

type Followed = Record<string, FollowedThread>;

export function fromServer(s: ThreadReadState): FollowedThread {
  return { threadId: s.thread_id, channelId: s.channel_id, roomId: s.room_id, lastRead: s.last_read_message_id ?? null, unread: s.unread_count, mentions: s.mention_count };
}

/** The followed threads of a room as the node reports them (replaces that room's entries). */
export function applyRoom(followed: Followed, roomId: string, list: ThreadReadState[]): Followed {
  const next: Followed = {};
  for (const [id, f] of Object.entries(followed)) if (f.roomId !== roomId) next[id] = f;
  for (const s of list) next[s.thread_id] = fromServer(s);
  return next;
}

/** A `thread.read` event or a route answer: follows, unfollows or moves the marker. */
export function applyState(followed: Followed, s: ThreadReadState): Followed {
  if (!s.following) {
    if (!followed[s.thread_id]) return followed;
    const { [s.thread_id]: _gone, ...rest } = followed;
    return rest;
  }
  return { ...followed, [s.thread_id]: fromServer(s) };
}

/**
 * A new thread message: counted for followed threads unless it is the user's own or `active` (the thread is open
 * and the tab focused). Mentions of the user or `@everyone` count as mentions.
 */
export function applyMessage(followed: Followed, m: Pick<Message, "id" | "thread_id" | "author_id" | "mentions" | "mentions_everyone">, me: { id: string; address: string }, active: boolean): Followed {
  const f = m.thread_id ? followed[m.thread_id] : undefined;
  if (!f || m.author_id === me.id || active || (f.lastRead && m.id <= f.lastRead)) return followed;
  const mentioned = !!m.mentions_everyone || (m.mentions ?? []).includes(me.address);
  return { ...followed, [f.threadId]: { ...f, unread: Math.min(UNREAD_CAP, f.unread + 1), mentions: mentioned ? Math.min(UNREAD_CAP, f.mentions + 1) : f.mentions } };
}

/** The marker moved here: reading the newest message clears the counts of the thread. */
export function applyRead(followed: Followed, threadId: string, messageId: string): Followed {
  const f = followed[threadId];
  if (!f || (f.lastRead && f.lastRead >= messageId)) return followed;
  return { ...followed, [threadId]: { ...f, lastRead: messageId, unread: 0, mentions: 0 } };
}

interface ThreadState {
  followed: Followed;
  /** The thread shown in the thread panel (one at a time). */
  open: string | null;
  seedRoom: (roomId: string, list: ThreadReadState[]) => void;
  state: (s: ThreadReadState) => void;
  message: (m: Message, me: { id: string; address: string }, active: boolean) => void;
  read: (threadId: string, messageId: string) => void;
}

export const useThreads = create<ThreadState>((set) => ({
  followed: {},
  open: null,
  seedRoom: (roomId, list) => set((s) => ({ followed: applyRoom(s.followed, roomId, list) })),
  state: (st) => set((s) => ({ followed: applyState(s.followed, st) })),
  message: (m, me, active) => set((s) => ({ followed: applyMessage(s.followed, m, me, active) })),
  read: (threadId, messageId) => set((s) => ({ followed: applyRead(s.followed, threadId, messageId) })),
}));

/** Does a thread message concern the user (followed thread, or a direct mention)? */
export function concernsMe(m: Pick<Message, "thread_id" | "mentions">, me: { address: string }): boolean {
  if (!m.thread_id) return true;
  return !!useThreads.getState().followed[m.thread_id] || (m.mentions ?? []).includes(me.address);
}
