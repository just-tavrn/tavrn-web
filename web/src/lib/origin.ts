// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { publicApi } from "./api";

/** Discovery document of the node this web client was loaded from (not necessarily the home node). */
export function useOriginNode() {
  return useQuery({ queryKey: ["well-known", "origin"], queryFn: () => publicApi.node.wellKnown(), staleTime: 10 * 60_000 });
}

/** Domain of the node this web client was loaded from, once known. */
export function useOriginDomain(): string | null {
  return useOriginNode().data?.domain ?? null;
}
