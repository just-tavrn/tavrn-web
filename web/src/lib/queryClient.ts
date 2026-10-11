// SPDX-License-Identifier: Apache-2.0
import { QueryClient } from "@tanstack/react-query";
import { onAccountChange } from "../stores/auth";

/** The page's query cache. Its keys are not account-scoped, so it is emptied whenever the signed-in account ends. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

onAccountChange(() => queryClient.clear());
