// SPDX-License-Identifier: Apache-2.0
/**
 * The poll services of one conversation (PROTOCOL.md §7g): vote records over `api.polls`, sealed and checked with the
 * `@tavrn/e2ee` poll helpers. Encrypted conversations: the vote is content under the current epoch, signed by this
 * device (retried once on `mls.epoch_stale`, like messages); plaintext ones: the vote object with this device's
 * plaintext signature when it has one.
 */
import { useMemo, useRef } from "react";
import type { Message, TavrnApi } from "@tavrn/sdk";
import { checkPollVote, parsePollVote, pollHash, pollVoteContent, signPlainPollVote, type CheckedVote, type MlsManager, type Poll, type PollVoteContent } from "@tavrn/e2ee";
import { withFreshEpoch } from "../lib/epochRetry";
import type { PollEnv, PollVoteRecord } from "./context";

export interface ConversationPollOptions {
  api: TavrnApi;
  conversationId: string;
  /** Qualified id `<node>/<ulid>` (MLS and plaintext signatures name the conversation so). */
  q: string;
  encrypted: boolean;
  mls: MlsManager | null;
  me: string | undefined;
  canVote: boolean;
  canManage: boolean;
  name: (address: string) => string;
  /** Encrypts a vote for the group (the conversation's ghost check and departed-leaf cleanup apply). */
  encryptVote: (vote: PollVoteContent) => Promise<{ content: string; epoch: number }>;
  /** The node's answer to closing a poll (the updated message). */
  onClosed: (m: Message) => void;
}

/** The poll content as the client holds it (decrypted, or the plaintext object): what `poll_hash` covers. */
export type RawPoll = Record<string, unknown>;

/** `poll_hash` per poll content object (JCS + SHA-256): computed once, not again for every vote event. */
const hashes = new WeakMap<RawPoll, Promise<string>>();
function cachedPollHash(raw: RawPoll): Promise<string> {
  let h = hashes.get(raw);
  if (!h) {
    h = pollHash(raw);
    hashes.set(raw, h);
    h.catch(() => hashes.delete(raw));
  }
  return h;
}

export function useConversationPolls(o: ConversationPollOptions): PollEnv {
  const { api, conversationId, q, encrypted, mls, me, canVote, canManage } = o;
  // Callbacks of the caller change on every render: read through a ref, so the services (and the verified votes of
  // every shown poll) stay stable.
  const latest = useRef(o);
  latest.current = o;
  return useMemo<PollEnv>(
    () => ({
      conversationId,
      me,
      canVote,
      canManage,
      name: (address) => latest.current.name(address),
      list: async (messageId) => (await api.polls.votes(conversationId, messageId)).items as PollVoteRecord[],
      open: async (m, raw, poll, records) => {
        const hash = await cachedPollHash(raw);
        return Promise.all(
          records.map(async (r): Promise<CheckedVote> => {
            if (r.pending) return { user: r.user, updated_at: r.updated_at, check: { ok: true, vote: null as unknown as PollVoteContent, selection: r.pending } };
            const record = { ...r, conversation_id: r.conversation_id ?? conversationId, message_id: r.message_id ?? m.id };
            // Without the session manager (encryption not unlocked) plaintext votes count unverified.
            if (!mls) {
              const check = typeof r.content === "string" ? ({ ok: false, reason: "locked" } as const) : parsePollVote(r.content, poll, m.id, hash);
              return { user: r.user, updated_at: r.updated_at, check: check.ok ? { ...check, unverified: true } : check };
            }
            const check = await checkPollVote(mls, q, record as Parameters<typeof checkPollVote>[2], poll, hash).catch(() => ({ ok: false, reason: "invalid" }) as const);
            return { user: r.user, updated_at: r.updated_at, check };
          }),
        );
      },
      vote: async (m, raw, poll, choice) => {
        const vote = pollVoteContent(poll, m.id, await cachedPollHash(raw), choice);
        if (encrypted) {
          if (!mls) throw new Error("locked");
          return (await withFreshEpoch(mls, q, async () => api.polls.vote(conversationId, m.id, await latest.current.encryptVote(vote)))) as PollVoteRecord;
        }
        const signature = mls ? signPlainPollVote(mls, q, vote) : null;
        return (await api.polls.vote(conversationId, m.id, { content: vote as unknown as Record<string, unknown>, ...(signature ? { signature } : {}) })) as PollVoteRecord;
      },
      retract: async (m) => {
        await api.polls.retract(conversationId, m.id);
      },
      close: async (m) => latest.current.onClosed(await api.polls.close(conversationId, m.id)),
    }),
    [api, conversationId, q, encrypted, mls, me, canVote, canManage],
  );
}

export type { Poll };
