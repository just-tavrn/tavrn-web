// SPDX-License-Identifier: Apache-2.0
// A federated session added or dropped opens or closes that node's socket only: the other nodes stay connected
// (before, every session change closed and reopened every node's socket).
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { TavrnSocket } from "@tavrn/sdk";
import { useNodeRealtime, useNodeSockets } from "./useRealtime";
import { useNodes, type FederatedSession } from "../stores/nodes";

const session = (domain: string) =>
  ({ domain, base: `https://${domain}`, ws: `wss://${domain}/ws`, web: `https://${domain}`, token: "t", refresh: "r", deviceId: "d", user: { id: `me-${domain}`, address: "me@home.test" }, expiresAt: Date.now() + 86_400_000 }) as unknown as FederatedSession;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("useNodeRealtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useNodes.setState({ sessions: {} });
  });

  it("keeps the sockets of the other nodes when one session is added or dropped", () => {
    const opened: string[] = [];
    const closed: string[] = [];
    vi.spyOn(TavrnSocket.prototype, "connect").mockImplementation(function (this: TavrnSocket) {
      opened.push((this as unknown as { opts: { url: string } }).opts?.url ?? "?");
    });
    vi.spyOn(TavrnSocket.prototype, "close").mockImplementation(function (this: TavrnSocket) {
      closed.push((this as unknown as { opts: { url: string } }).opts?.url ?? "?");
    });
    useNodes.setState({ sessions: { "a.test": session("a.test") } });
    const { unmount } = renderHook(() => useNodeRealtime(), { wrapper });
    expect(opened).toHaveLength(1);
    const a = useNodeSockets.getState().sockets["a.test"];
    expect(a).toBeDefined();

    act(() => useNodes.setState({ sessions: { "a.test": session("a.test"), "b.test": session("b.test") } }));
    expect(opened).toHaveLength(2);
    expect(closed).toHaveLength(0);
    expect(useNodeSockets.getState().sockets["a.test"]).toBe(a);
    const b = useNodeSockets.getState().sockets["b.test"];
    expect(b).toBeDefined();

    // A renewed session of a node (new tokens) keeps its socket too: the socket reads the token through a getter.
    act(() => useNodes.setState({ sessions: { "a.test": { ...session("a.test"), token: "t2" }, "b.test": session("b.test") } }));
    expect(opened).toHaveLength(2);

    act(() => useNodes.setState({ sessions: { "b.test": session("b.test") } }));
    expect(closed).toHaveLength(1);
    expect(useNodeSockets.getState().sockets).toEqual({ "b.test": b });

    unmount();
    expect(closed).toHaveLength(2);
    expect(useNodeSockets.getState().sockets).toEqual({});
  });
});
