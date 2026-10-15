// SPDX-License-Identifier: Apache-2.0
// One members entry per room: the member list, the room settings and the ownership transfer share the complete list
// (before, the settings tab filled the same key with one page of 500, truncating the list of every other view).
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { Member } from "@tavrn/sdk";
import { mockFetch } from "../test/render";
import { useRoomMembers } from "../pages/ChannelPage";
import { useMembers } from "../pages/settings/MembersTab";

const member = (n: number) => ({ user: { id: `u${String(n).padStart(5, "0")}`, address: `u${n}@home.test`, display_name: `U${n}`, kind: "user" }, roles: [], joined_at: "2026-01-01T00:00:00Z", room_avatar_animated: false });

describe("room members query", () => {
  it("every view reads the complete list of 600 members from one entry", async () => {
    const all = Array.from({ length: 600 }, (_, i) => member(i));
    const calls = mockFetch({
      "/rooms/r1/members": (_init, url) => {
        const after = new URL(url, "http://x").searchParams.get("after");
        const start = after ? all.findIndex((m) => m.user.id === after) + 1 : 0;
        return { body: all.slice(start, start + 500) };
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const list = renderHook(() => useRoomMembers("r1"), { wrapper });
    await waitFor(() => expect(list.result.current.data).toHaveLength(600));
    const settings = renderHook(() => useMembers("r1"), { wrapper });
    await waitFor(() => expect(settings.result.current.data).toHaveLength(600));
    // The settings tab refetching (stale entry) keeps the full list too.
    await client.refetchQueries({ queryKey: ["members", "r1"] });
    expect(client.getQueryData<Member[]>(["members", "r1"])).toHaveLength(600);
    // Every fetch of the entry pages through the whole list (two pages each), never a single page of 500.
    const pages = calls.filter((c) => c.url.includes("/members"));
    expect(pages.length % 2).toBe(0);
    expect(pages.filter((c) => !c.url.includes("after=")).length).toBe(pages.length / 2);
  });
});
