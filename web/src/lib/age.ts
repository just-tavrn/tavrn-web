// SPDX-License-Identifier: Apache-2.0
/**
 * The own age status (protocol PROTOCOL.md §5e, `age.v1`): only `GET /users/me` of the home node carries it, and the
 * client never shows anybody else's. Gated channels are locked for everybody but adults; `unknown` counts as minor.
 */
import { useQuery } from "@tanstack/react-query";
import { channelLocked, type AgeStatus, type Channel } from "@tavrn/sdk";
import { api } from "./api";
import { useAuth } from "../stores/auth";

/** `GET /users/me` of the home node (shared query key `["me"]`). */
export function useMe() {
  const signedIn = useAuth((s) => !!s.token);
  return useQuery({ queryKey: ["me"], queryFn: () => api.users.me(), enabled: signedIn, staleTime: 60_000 });
}

/** The own status: `undefined` while loading, `null` for nodes without `age.v1`. */
export function useAgeStatus(): AgeStatus | null | undefined {
  const me = useMe();
  if (!me.data) return undefined;
  return me.data.age_status ?? null;
}

/**
 * `locked`: the channel's effective gate is `adults_only` and the user is not an adult. `pending`: the status is still
 * loading for a gated channel (show neither the content nor the notice yet).
 */
export function useChannelLock(channel: Pick<Channel, "age_gate_effective"> | null | undefined): { locked: boolean; pending: boolean } {
  const status = useAgeStatus();
  if (!channel || channel.age_gate_effective !== "adults_only") return { locked: false, pending: false };
  if (status === undefined) return { locked: false, pending: true };
  return { locked: channelLocked(channel, status), pending: false };
}

/** Today's date `YYYY-MM-DD` in UTC (the node's clock for ages). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
