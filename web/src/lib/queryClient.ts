// SPDX-License-Identifier: Apache-2.0
import { QueryClient } from "@tanstack/react-query";
import { onAccountChange } from "../stores/auth";

/** The page's query cache. Its keys are not account-scoped, so it is emptied whenever the signed-in account ends. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/**
 * Empties the cache. `clear()` cancels fetches in flight silently and leaves the components that wait for them
 * `pending` for good (their observers keep the removed query; nothing refetches until they render again): those
 * fetches start again on fresh queries, with the credentials of now (web #167: the login page's node queries).
 */
export function clearQueryCache(client: QueryClient): void {
  const waiting = client
    .getQueryCache()
    .findAll({ fetchStatus: "fetching" })
    .flatMap((q) => q.observers);
  client.clear();
  for (const observer of waiting) void observer.refetch().catch(() => undefined);
}

onAccountChange(() => clearQueryCache(queryClient));
