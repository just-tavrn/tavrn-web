// SPDX-License-Identifier: Apache-2.0
/**
 * Reachability per node domain, learned from the API calls themselves: a request that fails on the
 * network marks the node unreachable, any answer marks it reachable again. Only that node's rooms show
 * the "unreachable" state; everything else keeps working (design note 9, FEDERATION.md §4).
 */
import { create } from "zustand";
import { previewGuard } from "../lib/previewGuard";

export type Reach = "ok" | "unreachable";

interface ReachState {
  nodes: Record<string, Reach>;
  set: (domain: string, reach: Reach) => void;
}

export const useReach = create<ReachState>((set, get) => ({
  nodes: {},
  set: (domain, reach) => {
    if (get().nodes[domain] === reach) return;
    set((s) => ({ nodes: { ...s.nodes, [domain]: reach } }));
  },
}));

export function isUnreachable(domain: string): boolean {
  return useReach.getState().nodes[domain] === "unreachable";
}

/**
 * A `fetch` that records the reachability of `domain()` (the domain is read per request). It also applies the role
 * preview's write guard (lib/previewGuard.ts): a refused request never leaves this device.
 */
export function trackingFetch(domain: () => string | null, inner: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return async (input, init) => {
    const refused = previewGuard(input, init);
    if (refused) return refused;
    const d = domain();
    try {
      const resp = await inner(input, init);
      if (d) useReach.getState().set(d, "ok");
      return resp;
    } catch (e) {
      // An aborted request (navigation, unmount) says nothing about the node.
      if (d && !(e instanceof DOMException && e.name === "AbortError" && init?.signal?.aborted)) useReach.getState().set(d, "unreachable");
      throw e;
    }
  };
}
