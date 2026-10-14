// SPDX-License-Identifier: Apache-2.0
/**
 * The votes of a poll (PROTOCOL.md §7g): fetched when the poll is shown (`GET …/poll/votes`), kept current by the
 * `poll.vote` / `poll.vote.delete` events, verified by the conversation's codec. The own vote is applied at once and
 * replaced by the node's record (or rolled back when the node refuses it); the last device wins.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message, TavrnSocket } from "@tavrn/sdk";
import { pollVotesKey, usePollEnv, type PollEnv, type PollVoteRecord, type VoteChoice } from "./context";
import type { PollContent } from "./model";
import type { OpenedVote } from "./tally";

/** Replaces the record of `user` (one per member and poll) or adds it. */
export function upsertVote(list: PollVoteRecord[] | undefined, record: PollVoteRecord): PollVoteRecord[] | undefined {
  if (!list) return list;
  return [...list.filter((r) => r.user !== record.user), record];
}

export function removeVote(list: PollVoteRecord[] | undefined, user: string): PollVoteRecord[] | undefined {
  return list?.filter((r) => r.user !== user);
}

/** The records of a poll and what they say, verified (null while loading). */
export function usePollVotes(m: Message, poll: PollContent | null, enabled = true): { records: PollVoteRecord[] | undefined; opened: OpenedVote[] | null; error: unknown } {
  const env = usePollEnv();
  const query = useQuery({
    queryKey: pollVotesKey(m.conversation_id, m.id),
    queryFn: () => env!.list(m.id),
    enabled: !!env && enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [opened, setOpened] = useState<OpenedVote[] | null>(null);
  const records = query.data;
  useEffect(() => {
    if (!env || !records || !poll) return;
    let cancelled = false;
    void env.open(m, poll, records).then(
      (v) => !cancelled && setOpened(v),
      () => !cancelled && setOpened([]),
    );
    return () => {
      cancelled = true;
    };
    // `poll` is derived from the message's content: the message identity stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, records, m]);
  return { records, opened, error: query.error };
}

/** Vote, retract and close with the optimistic update of the own record. */
export function usePollActions(m: Message, poll: PollContent | null) {
  const env = usePollEnv();
  const queryClient = useQueryClient();
  const key = pollVotesKey(m.conversation_id, m.id);
  const vote = async (choice: VoteChoice) => {
    if (!env?.me || !poll) return;
    const before = queryClient.getQueryData<PollVoteRecord[]>(key);
    const now = new Date().toISOString();
    queryClient.setQueryData<PollVoteRecord[]>(key, (list) => upsertVote(list ?? [], { user: env.me!, content: null, created_at: now, updated_at: now, pending: choice }));
    try {
      const record = await env.vote(m, poll, choice);
      queryClient.setQueryData<PollVoteRecord[]>(key, (list) => upsertVote(list ?? [], { ...record, user: record.user || env.me! }));
    } catch (e) {
      queryClient.setQueryData(key, before);
      throw e;
    }
  };
  const retract = async () => {
    if (!env?.me) return;
    const before = queryClient.getQueryData<PollVoteRecord[]>(key);
    queryClient.setQueryData<PollVoteRecord[]>(key, (list) => removeVote(list, env.me!));
    try {
      await env.retract(m);
    } catch (e) {
      queryClient.setQueryData(key, before);
      throw e;
    }
  };
  return { vote, retract, close: () => env?.close(m) ?? Promise.resolve() };
}

interface VoteEvent extends PollVoteRecord {
  conversation_id: string;
  message_id: string;
}

/** `poll.vote` / `poll.vote.delete` for the polls that are shown (others have no cache entry and are fetched later). */
export function pollHandlers(socket: TavrnSocket, queryClient: QueryClient): Array<() => void> {
  const apply = (conversationId: string | undefined, messageId: string | undefined, fn: (l: PollVoteRecord[] | undefined) => PollVoteRecord[] | undefined) => {
    if (!conversationId || !messageId) return;
    const key = pollVotesKey(conversationId, messageId);
    if (queryClient.getQueryData(key)) queryClient.setQueryData<PollVoteRecord[]>(key, fn);
  };
  return [
    socket.on<VoteEvent | { vote: VoteEvent }>("poll.vote", (d) => {
      const v = "vote" in d && d.vote ? d.vote : (d as VoteEvent);
      apply(v.conversation_id, v.message_id, (l) => upsertVote(l, v));
    }),
    socket.on<{ conversation_id: string; message_id: string; user: string }>("poll.vote.delete", (d) => apply(d.conversation_id, d.message_id, (l) => removeVote(l, d.user))),
  ];
}

export type { PollEnv };
