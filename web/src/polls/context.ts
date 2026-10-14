// SPDX-License-Identifier: Apache-2.0
/**
 * What a poll in the message list can reach: the conversation's vote routes, the codec that seals and opens votes
 * (encrypted and device-signed in E2EE conversations, signed plaintext elsewhere) and the viewer's rights. Provided by
 * the conversation view; without it (search results, pins) polls render read-only.
 */
import { createContext, useContext } from "react";
import type { Message } from "@tavrn/sdk";
import type { CheckedVote, Poll, PollSelection } from "@tavrn/e2ee";

/** A vote record as the node lists it (`GET …/poll/votes`) or sends it (`poll.vote`). */
export interface PollVoteRecord {
  user: string;
  device_id?: string | null;
  epoch?: number | null;
  content: unknown;
  created_at: string;
  updated_at: string;
  message_id?: string;
  conversation_id?: string;
  signature?: string | null;
  /** Local only: this device's vote until the node confirmed it. */
  pending?: PollSelection;
}

export interface PollEnv {
  conversationId: string;
  /** The viewer's address on the conversation's node. */
  me: string | undefined;
  /** May vote here (`view_channel`; members of DMs). */
  canVote: boolean;
  /** `manage_messages`: may close polls of others. */
  canManage: boolean;
  /** Display name of a member. */
  name: (address: string) => string;
  list: (messageId: string) => Promise<PollVoteRecord[]>;
  /**
   * Verifies and reads the records against the poll as shown (signature, `ctx.poll`, `poll_hash`); `raw` is the poll's
   * content object as this client holds it (the hash covers it).
   */
  open: (m: Message, raw: Record<string, unknown>, poll: Poll, records: PollVoteRecord[]) => Promise<CheckedVote[]>;
  vote: (m: Message, raw: Record<string, unknown>, poll: Poll, choice: PollSelection) => Promise<PollVoteRecord>;
  retract: (m: Message) => Promise<void>;
  /** Closes the poll now (the edit route with `poll_closes_at`). */
  close: (m: Message) => Promise<void>;
}

export const PollContext = createContext<PollEnv | null>(null);
export const usePollEnv = () => useContext(PollContext);

/** The query key of a poll's vote records (conversation ids are unique across nodes). */
export const pollVotesKey = (conversationId: string, messageId: string) => ["poll-votes", conversationId, messageId] as const;
