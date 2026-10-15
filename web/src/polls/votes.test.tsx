// SPDX-License-Identifier: Apache-2.0
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";
import type { CheckedVote, Poll } from "@tavrn/e2ee";
import { PollContext, pollVotesKey, type PollEnv, type PollVoteRecord } from "./context";
import { upsertVote, usePollVotes } from "./votes";

const m = { id: "m1", conversation_id: "c1" } as Message;
const raw = { type: "poll" };
const poll = {} as Poll;
const record = (i: number, at = "2026-10-15T10:00:00Z"): PollVoteRecord => ({ user: `u${i}@t`, content: { choice: i % 3 }, created_at: at, updated_at: at });

describe("usePollVotes", () => {
  it("checks only new or changed records on a vote event", async () => {
    const checkedRecords: string[] = [];
    const env = {
      conversationId: "c1",
      me: "me@t",
      canVote: true,
      canManage: false,
      name: (a: string) => a,
      list: async () => Array.from({ length: 200 }, (_, i) => record(i)),
      open: vi.fn(async (_m: Message, _raw: unknown, _poll: Poll, records: PollVoteRecord[]): Promise<CheckedVote[]> => {
        checkedRecords.push(...records.map((r) => r.user));
        return records.map((r) => ({ user: r.user, updated_at: r.updated_at, check: { ok: false, reason: "invalid" } }) as CheckedVote);
      }),
      vote: vi.fn(),
      retract: vi.fn(),
      close: vi.fn(),
    } as unknown as PollEnv;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <PollContext.Provider value={env}>{children}</PollContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => usePollVotes(m, raw, poll), { wrapper });
    await waitFor(() => expect(result.current.checked).toHaveLength(200));
    expect(checkedRecords).toHaveLength(200);
    for (let i = 0; i < 10; i++) {
      // Five changed votes and five new voters.
      const changed = i < 5 ? record(i, `2026-10-15T11:0${i}:00Z`) : record(200 + i);
      act(() => {
        client.setQueryData<PollVoteRecord[]>(pollVotesKey("c1", "m1"), (l) => upsertVote(l, changed));
      });
    }
    await waitFor(() => expect(result.current.checked).toHaveLength(205));
    expect(checkedRecords).toHaveLength(210);
    expect(result.current.checked!.find((c) => c.user === "u3@t")?.updated_at).toBe("2026-10-15T11:03:00Z");
  });
});
