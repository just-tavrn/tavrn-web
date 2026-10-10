// SPDX-License-Identifier: Apache-2.0
// History for new members in a channel view (ENCRYPTION.md §7b): under every policy, `since_join` included, a ready view
// takes the keys shared with this user, shares with members who wait and says whether this user still waits.
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TavrnApi } from "@tavrn/sdk";

const flows = vi.hoisted(() => ({ receive: vi.fn(async () => 0), pending: vi.fn() }));
vi.mock("../crypto/history", () => ({ historyReceive: flows.receive, historyPending: flows.pending }));

import { useChannelHistory } from "./useChannelHistory";
import { useAuth } from "../stores/auth";

function setup(items: { user: string; since: string }[]) {
  const pending = vi.fn(async () => ({ items }));
  const api = { history: { pending } } as unknown as TavrnApi;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { api, pending, wrapper };
}

beforeEach(() => {
  flows.receive.mockClear();
  flows.pending.mockClear();
  useAuth.setState({ user: { address: "bob@n" } as never });
});

describe("useChannelHistory", () => {
  it("runs under since_join: takes shared keys, shares with members who wait and shows the own wait", async () => {
    const { api, pending, wrapper } = setup([{ user: "bob@n", since: "2026-10-10T00:00:00.000Z" }]);
    const { result } = renderHook(() => useChannelHistory({ api, domain: "n", q: "n/C", channelId: "C", encrypted: true, policy: "since_join", ready: true }), { wrapper });
    await waitFor(() => expect(result.current.locked).toBe(true));
    expect(result.current.active).toBe(true);
    expect(pending).toHaveBeenCalledWith("C");
    expect(flows.receive).toHaveBeenCalledWith("n/C");
    expect(flows.pending).toHaveBeenCalledWith("n/C", { kind: "since_join" });
  });

  it("does nothing before the group is ready or in plaintext channels", async () => {
    const { api, pending, wrapper } = setup([{ user: "bob@n", since: "x" }]);
    const notReady = renderHook(() => useChannelHistory({ api, domain: "n", q: "n/C", channelId: "C", encrypted: true, policy: "all", ready: false }), { wrapper });
    const plain = renderHook(() => useChannelHistory({ api, domain: "n", q: "n/P", channelId: "P", encrypted: false, policy: "all", ready: true }), { wrapper });
    expect(notReady.result.current).toEqual({ active: false, locked: false });
    expect(plain.result.current).toEqual({ active: false, locked: false });
    expect(pending).not.toHaveBeenCalled();
    expect(flows.receive).not.toHaveBeenCalled();
    expect(flows.pending).not.toHaveBeenCalled();
  });
});
