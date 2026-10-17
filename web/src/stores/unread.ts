// SPDX-License-Identifier: Apache-2.0
/**
 * Unread and mention counts per conversation (design note 4.4). The node is the source of truth: the room
 * detail (`read_states`) and the conversation list carry the counts, `message.create` and `read.update`
 * keep them current in between. Message ids are ULIDs, so a larger id is a newer message.
 */
import { create } from "zustand";
import type { Message } from "@tavrn/sdk";
import { useNotifications } from "./notifications";

/** The node caps counts here; the UI shows "999+". */
export const UNREAD_CAP = 999;

export interface ReadInfo {
  /** Newest known message id. */
  last: string | null;
  /** The user's read marker. */
  read: string | null;
  unread: number;
  mentions: number;
}

export interface ServerReadState {
  conversation_id: string;
  last_message_id?: string | null;
  last_read_message_id?: string | null;
  unread_count: number;
  mention_count: number;
}

type States = Record<string, ReadInfo>;
type MessageMeta = Pick<Message, "id" | "conversation_id" | "author_id" | "mentions" | "mentions_everyone">;

const empty: ReadInfo = { last: null, read: null, unread: 0, mentions: 0 };
const max = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

export function applyServer(states: States, list: ServerReadState[]): States {
  const next = { ...states };
  for (const s of list) {
    const last = s.last_message_id ?? null;
    // A marker set here may not have reached the node yet: keep it, and if it covers the newest
    // message, the conversation is read.
    const read = max(s.last_read_message_id ?? null, states[s.conversation_id]?.read ?? null);
    const caughtUp = !!read && read !== (s.last_read_message_id ?? null) && read >= (last ?? "");
    next[s.conversation_id] = { last, read, unread: caughtUp ? 0 : s.unread_count, mentions: caughtUp ? 0 : s.mention_count };
  }
  return next;
}

/** A new message: counted unless it is the user's own, already known, or `active` (being looked at). */
export function applyMessage(states: States, m: MessageMeta, me: { id: string; address: string }, active: boolean): States {
  const s = states[m.conversation_id] ?? empty;
  if (s.last && m.id <= s.last) return states;
  const counted = !active && m.author_id !== me.id;
  const mentioned = counted && (m.mentions_everyone || m.mentions.includes(me.address));
  return {
    ...states,
    [m.conversation_id]: {
      ...s,
      last: m.id,
      unread: counted ? Math.min(UNREAD_CAP, s.unread + 1) : s.unread,
      mentions: mentioned ? Math.min(UNREAD_CAP, s.mentions + 1) : s.mentions,
    },
  };
}

/** The marker moved (here or on another device): reading the newest message clears the counts. */
export function applyRead(states: States, conversationId: string, messageId: string): States {
  const s = states[conversationId] ?? empty;
  const read = max(s.read, messageId);
  const last = max(s.last, messageId);
  const caughtUp = !!read && read >= (last ?? "");
  return { ...states, [conversationId]: { last, read, unread: caughtUp ? 0 : s.unread, mentions: caughtUp ? 0 : s.mentions } };
}

/**
 * Changes the counts without moving the markers: messages of followed threads count towards their channel
 * (PROTOCOL.md §7e) but are not the channel's newest message.
 */
export function applyBump(states: States, conversationId: string, unread: number, mentions: number): States {
  const s = states[conversationId] ?? empty;
  const clamp = (n: number) => Math.min(UNREAD_CAP, Math.max(0, n));
  return { ...states, [conversationId]: { ...s, unread: clamp(s.unread + unread), mentions: clamp(s.mentions + mentions) } };
}

export function formatCount(n: number): string {
  return n >= UNREAD_CAP ? `${UNREAD_CAP}+` : String(n);
}

/**
 * "Mark unread" from a message (design note 4.11): the marker moves back locally to just before `fromId`
 * (`previousId`, or nothing), with `count` unread messages. The node never moves markers backwards, so
 * this lasts on this device until the conversation is read again.
 */
export function applyUnread(states: States, conversationId: string, previousId: string | null, count: number): States {
  const s = states[conversationId] ?? empty;
  return { ...states, [conversationId]: { ...s, read: previousId, unread: Math.min(UNREAD_CAP, Math.max(1, count)) } };
}

interface UnreadState {
  states: States;
  /** Conversations marked unread by hand: the open view does not mark them read until it is left. */
  held: Record<string, true>;
  seed: (list: ServerReadState[], node?: string | null) => void;
  message: (m: MessageMeta, me: { id: string; address: string }, active: boolean) => void;
  read: (conversationId: string, messageId: string, node?: string | null) => void;
  bump: (conversationId: string, unread: number, mentions: number) => void;
  markUnread: (conversationId: string, previousId: string | null, count: number) => void;
  release: (conversationId: string) => void;
}

export const useUnread = create<UnreadState>((set) => ({
  states: {},
  held: {},
  seed: (list, node) => {
    set((st) => ({ states: applyServer(st.states, list) }));
    for (const s of list) if (s.last_read_message_id) useNotifications.getState().markMessagesRead({ node, conversationId: s.conversation_id, messageId: s.last_read_message_id, caughtUp: s.unread_count === 0 && s.mention_count === 0 });
  },
  message: (m, me, active) => set((st) => ({ states: applyMessage(st.states, m, me, active) })),
  read: (conversationId, messageId, node) => {
    const last = useUnread.getState().states[conversationId]?.last;
    set((st) => ({ states: applyRead(st.states, conversationId, messageId) }));
    useNotifications.getState().markMessagesRead({ node, conversationId, messageId, caughtUp: !!last && messageId >= last });
  },
  bump: (conversationId, unread, mentions) => set((st) => ({ states: applyBump(st.states, conversationId, unread, mentions) })),
  markUnread: (conversationId, previousId, count) => set((st) => ({ states: applyUnread(st.states, conversationId, previousId, count), held: { ...st.held, [conversationId]: true } })),
  release: (conversationId) =>
    set((st) => {
      if (!st.held[conversationId]) return st;
      const { [conversationId]: _gone, ...held } = st.held;
      return { held };
    }),
}));

/**
 * "Mark as read" from a menu: moves the marker to the newest known message, locally at once and on the
 * node (`PUT …/read`). Returns false when there is nothing to mark.
 */
export async function markConversationRead(client: { conversations: { markRead: (id: string, messageId: string) => Promise<unknown> } }, conversationId: string, node?: string | null): Promise<boolean> {
  const s = useUnread.getState().states[conversationId];
  if (!s?.last) return false;
  useUnread.getState().release(conversationId);
  useUnread.getState().read(conversationId, s.last, node);
  await client.conversations.markRead(conversationId, s.last);
  return true;
}

/** Has this conversation unread messages (for menus)? */
export function isUnread(states: States, conversationId: string): boolean {
  const s = states[conversationId];
  return !!s && (s.unread > 0 || s.mentions > 0);
}
