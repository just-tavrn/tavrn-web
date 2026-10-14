// SPDX-License-Identifier: Apache-2.0
// The room detail query of the room views: whatever brings the room's data (its own fetch or another view's), the
// session manager learns which encrypted channels have webhooks (their inbox keys, APPLICATIONS.md §6.1a), and an
// unlocked device joins the groups of the encrypted channels right away (ENCRYPTION.md §7b).
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../stores/mls", async (importOriginal) => ({ ...(await importOriginal<typeof import("../stores/mls")>()), syncInboxChannels: sync }));
const joins = vi.hoisted(() => vi.fn());
vi.mock("../crypto/groupJoins", () => ({ joinRoomGroups: joins, resetGroupJoins: () => undefined }));

import { useRoom } from "./ChannelSidebar";
import { useAuth } from "../stores/auth";
import { useE2ee } from "../stores/e2ee";
import { useRolePreview } from "../stores/rolePreview";

const channels = [{ id: "c1", encrypted: true, has_webhooks: true }];

beforeEach(() => {
  sync.mockClear();
  joins.mockClear();
  useE2ee.setState({ status: null });
  useAuth.setState({ token: "t", user: { address: "alice@localhost", username: "alice", domain: "localhost" } as never, deviceId: "D1", home: null });
});

describe("useRoom", () => {
  it("hands the channels of room data that another view fetched to the session manager", async () => {
    // The room's own fetch never answers here: the data in the cache came from elsewhere (the rail, an invalidation).
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["room", "r1"], { id: "r1", channels, read_states: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    renderHook(() => useRoom("r1"), { wrapper });
    await waitFor(() => expect(sync).toHaveBeenCalledWith("localhost", channels));
  });

  it("joins the groups of the room's encrypted channels once the device is unlocked, not before", async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["room", "r1"], { id: "r1", channels, read_states: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    useE2ee.setState({ status: "locked" });
    renderHook(() => useRoom("r1"), { wrapper });
    await waitFor(() => expect(sync).toHaveBeenCalled());
    expect(joins).not.toHaveBeenCalled();
    act(() => useE2ee.setState({ status: "unlocked" }));
    await waitFor(() => expect(joins).toHaveBeenCalledWith("localhost", channels));
  });

  it("returns the room as the previewed roles see it while a preview is active; the session work keeps the real channels", async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const everyone = { id: "e", is_everyone: true, permissions: "1", position: 0, name: "@everyone" };
    const detail = {
      id: "r1", is_owner: true, my_roles: [], my_permissions: "-1", categories: [], roles: [everyone], read_states: [],
      channels: [{ id: "c1", kind: "text", encrypted: true, has_webhooks: true }, { id: "c2", kind: "text", encrypted: true }],
      overrides: [{ id: "o", target_type: "channel", target_id: "c2", subject_type: "role", subject_id: "e", allow: "0", deny: "1" }],
    };
    client.setQueryData(["room", "r1"], detail);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useRoom("r1"), { wrapper });
    await waitFor(() => expect(result.current.data?.channels.map((c) => c.id)).toEqual(["c1", "c2"]));
    act(() => useRolePreview.getState().start({ roomId: "r1", roleIds: [], joinedAt: Date.now(), label: "@everyone" }));
    await waitFor(() => expect(result.current.data?.channels.map((c) => c.id)).toEqual(["c1"]));
    expect(result.current.data?.is_owner).toBe(false);
    expect(sync).toHaveBeenLastCalledWith("localhost", detail.channels);
    act(() => useRolePreview.getState().exit());
    await waitFor(() => expect(result.current.data).toBe(detail));
  });
});
