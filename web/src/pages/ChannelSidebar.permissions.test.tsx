// SPDX-License-Identifier: Apache-2.0
// The channel list evaluates the layered permissions once per channel and room version (tavrn-web#155): one map per
// room object gives every row its permissions and access marks; rows that did not change do not compute again.
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Permission, type RoomDetail } from "@tavrn/sdk";

const compute = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@tavrn/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@tavrn/sdk")>();
  return {
    ...sdk,
    computePermissions: (...args: Parameters<typeof sdk.computePermissions>) => {
      compute.calls++;
      return sdk.computePermissions(...args);
    },
  };
});

import { ChannelSidebar } from "./ChannelSidebar";
import { mockFetch } from "../test/render";
import { useUnread } from "../stores/unread";
import { useAuth } from "../stores/auth";

const channel = (id: string, kind: string, position: number, category_id: string | null) => ({ id, room_id: "r1", category_id, kind, name: id, topic: "", position, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: null });
const CHANNELS = 12;
const room = (version: number): RoomDetail =>
  ({
    id: "r1", name: `Raum ${version}`, description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, age_gate: "none", history_restore: "request", no_bots: false, bots_in_encrypted_channels: "allowed",
    member_count: 2,
    categories: [{ id: "k1", room_id: "r1", name: "Eins", position: 0, no_bots: false }, { id: "k2", room_id: "r1", name: "Zwei", position: 1, no_bots: false }],
    channels: Array.from({ length: CHANNELS }, (_, i) => channel(`c${String(i).padStart(2, "0")}`, i % 4 === 3 ? "voice" : "text", i, i < 6 ? "k1" : "k2")),
    roles: [
      { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CONNECT).toString(), hoist: false, mentionable: false, is_everyone: true },
      { id: "mod", room_id: "r1", name: "Mod", color: null, position: 1, permissions: Permission.MANAGE_MESSAGES.toString(), hoist: false, mentionable: false, is_everyone: false },
    ],
    overrides: [
      { id: "o1", target_type: "category", target_id: "k2", subject_type: "role", subject_id: "everyone", allow: "0", deny: Permission.SEND_MESSAGES.toString() },
      { id: "o2", target_type: "channel", target_id: "c01", subject_type: "role", subject_id: "mod", allow: Permission.ADD_REACTIONS.toString(), deny: "0" },
    ],
    my_roles: ["mod"], my_permissions: (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES).toString(), is_owner: false, read_states: [],
  }) as unknown as RoomDetail;

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["room", "r1"], room(0));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/rooms/r1"]}>
        <Routes>
          <Route path="*" element={<ChannelSidebar roomId="r1" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe("channel list permissions", () => {
  beforeEach(() => {
    useUnread.setState({ states: {}, held: {} });
    useAuth.setState({ token: "t", user: { id: "me", address: "me@localhost", username: "me", domain: "localhost" } as never, deviceId: "D1", home: null });
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/node": { body: { capabilities: [] } } });
  });

  it("computes each channel's permissions and marks once per room version (at most two evaluations per channel)", async () => {
    const client = renderSidebar();
    expect(await screen.findAllByTestId("channel-row")).toHaveLength(CHANNELS - CHANNELS / 4);
    expect(compute.calls).toBeLessThanOrEqual(2 * CHANNELS);
    compute.calls = 0;
    act(() => client.setQueryData(["room", "r1"], room(1)));
    expect(await screen.findByText("Raum 1")).toBeInTheDocument();
    expect(compute.calls).toBeGreaterThan(0);
    expect(compute.calls).toBeLessThanOrEqual(2 * CHANNELS);
  });

  it("a row that renders for its own reasons (a new unread message) computes nothing", async () => {
    renderSidebar();
    await screen.findAllByTestId("channel-row");
    compute.calls = 0;
    act(() => useUnread.setState({ states: { c00: { last: "01M", read: null, unread: 3, mentions: 0 } } }));
    expect(compute.calls).toBe(0);
  });
});
