// SPDX-License-Identifier: Apache-2.0
/**
 * The votes of a poll (PROTOCOL.md §7g): fetched when the poll is shown (`GET …/poll/votes`), kept current by the
 * `poll.vote` / `poll.vote.delete` events, verified by the conversation's codec. The own vote is applied at once and
 * replaced by the node's record (or rolled back when the node refuses it); the last device wins.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Message, TavrnSocket } from "@tavrn/sdk";
import type { CheckedVote, Poll, PollSelection } from "@tavrn/e2ee";
import { pollVotesKey, usePollEnv, type PollEnv, type PollVoteRecord } from "./context";

/** Replaces the record of `user` (one per member and poll) or adds it. */
export function upsertVote(list: PollVoteRecord[] | undefined, record: PollVoteRecord): PollVoteRecord[] | undefined {
  if (!list) return list;
  return [...list.filter((r) => r.user !== record.user), record];
}

export function removeVote(list: PollVoteRecord[] | undefined, user: string): PollVoteRecord[] | undefined {
  return list?.filter((r) => r.user !== user);
}

/** Everything a record's check depends on (the query cache does not keep record objects across updates). */
const recordKeys = new WeakMap<PollVoteRecord, string>();
function recordKey(r: PollVoteRecord): string {
  let k = recordKeys.get(r);
  if (k === undefined) {
    k = JSON.stringify([r.user, r.updated_at, r.created_at, r.device_id ?? null, r.epoch ?? null, r.signature ?? null, r.message_id ?? null, r.conversation_id ?? null, r.content ?? null, r.pending ?? null]);
    recordKeys.set(r, k);
  }
  return k;
}

/** The records of a poll and what they say, verified (null while loading). */
export function usePollVotes(m: Message, raw: Record<string, unknown> | null, poll: Poll | null, enabled = true): { records: PollVoteRecord[] | undefined; checked: CheckedVote[] | null; error: unknown } {
  const env = usePollEnv();
  const query = useQuery({
    queryKey: pollVotesKey(m.conversation_id, m.id),
    queryFn: () => env!.list(m.id),
    enabled: !!env && enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [checked, setChecked] = useState<CheckedVote[] | null>(null);
  const records = query.data;
  // Checked votes per record version (a vote event replaces one record), valid for one poll version and one codec:
  // only new or changed records are checked.
  const cache = useRef<{ env: PollEnv | null; m: Message | null; raw: Record<string, unknown> | null; byRecord: Map<string, CheckedVote> }>({ env: null, m: null, raw: null, byRecord: new Map() });
  useEffect(() => {
    if (!env || !records || !poll || !raw) return;
    if (cache.current.env !== env || cache.current.m !== m || cache.current.raw !== raw) cache.current = { env, m, raw, byRecord: new Map() };
    const { byRecord } = cache.current;
    let cancelled = false;
    const keys = records.map(recordKey);
    const todo = records.filter((_, i) => !byRecord.has(keys[i]!));
    const done = () => {
      // Records that are gone (retracted, replaced) leave the cache.
      if (byRecord.size > keys.length * 2) {
        const present = new Set(keys);
        for (const k of [...byRecord.keys()]) if (!present.has(k)) byRecord.delete(k);
      }
      return keys.map((k) => byRecord.get(k)).filter((c): c is CheckedVote => !!c);
    };
    if (todo.length === 0) {
      setChecked(done());
      return;
    }
    void env.open(m, raw, poll, todo).then(
      (v) => {
        todo.forEach((r, i) => v[i] && byRecord.set(recordKey(r), v[i]));
        if (!cancelled) setChecked(done());
      },
      () => !cancelled && setChecked([]),
    );
    return () => {
      cancelled = true;
    };
    // `poll` is derived from the message's content: the message and the raw content stand for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, records, m, raw]);
  return { records, checked, error: query.error };
}

/** Vote, retract and close with the optimistic update of the own record. */
export function usePollActions(m: Message, raw: Record<string, unknown> | null, poll: Poll | null) {
  const env = usePollEnv();
  const queryClient = useQueryClient();
  const key = pollVotesKey(m.conversation_id, m.id);
  const vote = async (choice: PollSelection) => {
    if (!env?.me || !poll || !raw) return;
    const before = queryClient.getQueryData<PollVoteRecord[]>(key);
    const now = new Date().toISOString();
    queryClient.setQueryData<PollVoteRecord[]>(key, (list) => upsertVote(list ?? [], { user: env.me!, content: null, created_at: now, updated_at: now, pending: choice }));
    try {
      const record = await env.vote(m, raw, poll, choice);
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
