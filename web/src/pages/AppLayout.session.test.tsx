// SPDX-License-Identifier: Apache-2.0
// A token refresh (hourly, or another tab's rotation) is no new session: the sign-in housekeeping of AppLayout and the
// presence sync run once per account and device, not again with every new access token.
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserPrivate } from "@tavrn/sdk";

const calls = vi.hoisted(() => ({ syncIndex: 0, searchSync: 0, searchStop: 0, presence: 0 }));

vi.mock("../stores/conversationIndex", async (orig) => ({
  ...(await orig<typeof import("../stores/conversationIndex")>()),
  syncIndex: () => {
    calls.syncIndex++;
    return Promise.resolve();
  },
}));
vi.mock("../lib/invites", async (orig) => ({ ...(await orig<typeof import("../lib/invites")>()), acceptFriendInvites: () => Promise.resolve([]) }));
vi.mock("../search/sync", () => ({
  startSearchSync: () => {
    calls.searchSync++;
    return () => void calls.searchStop++;
  },
}));
vi.mock("../lib/presence", async (orig) => ({
  ...(await orig<typeof import("../lib/presence")>()),
  syncPresence: () => {
    calls.presence++;
    return Promise.resolve();
  },
  setAutoIdle: () => Promise.resolve(),
}));

import { useAuth } from "../stores/auth";
import { useNotifications } from "../stores/notifications";
import { usePush } from "../stores/push";
import { useE2ee } from "../stores/e2ee";
import { useRealtimeState } from "../hooks/useRealtime";
import { mockFetch } from "../test/render";
import { useSessionHousekeeping } from "./AppLayout";
import { usePresenceSync } from "../components/PresenceMenu";

const user = { id: "u1", username: "alice", address: "alice@home.test", domain: "home.test" } as unknown as UserPrivate;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("AppLayout session housekeeping", () => {
  const load = vi.fn(() => Promise.resolve());
  const notificationReset = vi.fn();
  const pushInit = vi.fn(() => Promise.resolve());
  const pushReset = vi.fn();
  const refresh = vi.fn(() => Promise.resolve("unlocked" as const));
  const ensureDevice = vi.fn(() => Promise.resolve());
  let fetches: Array<{ url: string }> = [];

  beforeEach(() => {
    Object.assign(calls, { syncIndex: 0, searchSync: 0, searchStop: 0, presence: 0 });
    for (const f of [load, notificationReset, pushInit, pushReset, refresh, ensureDevice]) f.mockClear();
    useNotifications.setState({ load, reset: notificationReset } as never);
    usePush.setState({ init: pushInit, reset: pushReset } as never);
    useE2ee.setState({ status: "unlocked", refresh, ensureDevice } as never);
    useRealtimeState.setState({ status: "ready" });
    useAuth.setState({ token: "access-1", refresh: "refresh-1", user, deviceId: "dev1", home: null });
    fetches = mockFetch({
      "/friends": { body: { friends: [], incoming: [], outgoing: [], blocked: [] } },
      "/users/me": { body: { ...user, auto_preview: "friends", locale: "de" } },
      "/node": { body: { preview_auto_max_bytes: 1000 } },
    });
  });
  afterEach(() => useAuth.setState({ token: null, refresh: null, user: null, deviceId: null }));

  it("runs once per session and not again after a token refresh", async () => {
    const { unmount } = renderHook(
      () => {
        useSessionHousekeeping();
        usePresenceSync();
      },
      { wrapper },
    );
    await flush();
    const before = {
      syncIndex: calls.syncIndex,
      searchSync: calls.searchSync,
      presence: calls.presence,
      me: fetches.filter((c) => c.url.endsWith("/users/me")).length,
    };
    expect(before).toEqual({ syncIndex: 1, searchSync: 1, presence: 1, me: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(pushInit).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The hourly refresh, and another tab's rotation adopted from the storage.
    act(() => useAuth.getState().setTokens({ access_token: "access-2", refresh_token: "refresh-2", device_id: "dev1" } as never));
    act(() => useAuth.setState({ token: "access-3", refresh: "refresh-3" }));
    await flush();

    expect(calls).toMatchObject({ syncIndex: 1, searchSync: 1, searchStop: 0, presence: 1 });
    expect(fetches.filter((c) => c.url.endsWith("/users/me")).length).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(notificationReset).not.toHaveBeenCalled();
    expect(pushInit).toHaveBeenCalledTimes(1);
    expect(pushReset).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a new device or account sets up again", async () => {
    renderHook(() => useSessionHousekeeping(), { wrapper });
    await flush();
    act(() => useAuth.setState({ token: "access-9", deviceId: "dev2" }));
    await flush();
    expect(calls.syncIndex).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(notificationReset).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending notification-settings save across a token refresh", async () => {
    vi.useFakeTimers();
    try {
      const put = vi.fn((s: unknown) => Promise.resolve(s as never));
      const real = useNotifications.getInitialState();
      // The real reset (it drops a pending save); the load of the hook stays mocked, the settings come from here.
      useNotifications.setState({ reset: real.reset } as never);
      renderHook(() => useSessionHousekeeping(), { wrapper });
      await real.load({ get: () => Promise.resolve({ global: { mode: "mentions", sound: true, browser: false }, rooms: {}, channels: {} }), put }, user.address);
      useNotifications.getState().update((s) => ({ ...s, global: { ...s.global, mode: "all" } }));
      act(() => useAuth.getState().setTokens({ access_token: "access-2", refresh_token: "refresh-2", device_id: "dev1" } as never));
      await vi.advanceTimersByTimeAsync(1000);
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0]![0]).toMatchObject({ global: { mode: "all" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
