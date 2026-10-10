// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseHistoryPolicy } from "@tavrn/e2ee";
import type { TavrnApi } from "@tavrn/sdk";
import { historyPending, historyReceive } from "../crypto/history";
import { useAuth } from "../stores/auth";

/**
 * History for new members of an encrypted room channel (ENCRYPTION.md §7b), under every policy (`since_join` included:
 * the messages since the join that were posted before this device entered the group). Once the channel's group is
 * ready: takes the keys shared while this device was away, then shares with members who still wait. `locked` = this
 * user still waits for keys ("Older messages are being unlocked…").
 */
export function useChannelHistory(opts: {
  api: TavrnApi;
  domain: string;
  /** Qualified channel id. */
  q: string;
  channelId: string;
  /** The channel is an encrypted room channel; `policy` its `history_for_new_members`. */
  encrypted: boolean;
  policy: string | null | undefined;
  ready: boolean;
}): { active: boolean; locked: boolean } {
  const { api, domain, q, channelId, encrypted, ready } = opts;
  const queryClient = useQueryClient();
  const address = useAuth((s) => s.user?.address);
  const policy = useMemo(() => (encrypted ? parseHistoryPolicy(opts.policy) : null), [encrypted, opts.policy]);
  const active = !!policy && ready;
  const pending = useQuery({
    queryKey: ["history-pending", domain, channelId],
    queryFn: () => api.history.pending(channelId),
    enabled: active,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!active || !policy) return;
    void historyReceive(q).then((n) => {
      if (n > 0) void queryClient.invalidateQueries({ queryKey: ["history-pending", domain, channelId] });
    });
    historyPending(q, policy);
  }, [active, policy, q, domain, channelId, queryClient]);
  return { active, locked: active && !!pending.data?.items.some((i) => i.user === address) };
}
