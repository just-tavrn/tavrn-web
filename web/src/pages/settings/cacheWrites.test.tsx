// SPDX-License-Identifier: Apache-2.0
// Room administration writes the node's answer into the cached room detail: no refetch of the whole room after a
// saved role, a new category or saved overrides (the realtime event confirms the change).
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { ChannelsTab } from "./ChannelsTab";
import { RolesTab } from "./RolesTab";
import { useAuth } from "../../stores/auth";
import { useLocale } from "../../i18n";
import { mockFetch } from "../../test/render";
import { useToasts } from "../../stores/toasts";

const everyone = { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: Permission.VIEW_CHANNEL.toString(), hoist: false, mentionable: false, is_everyone: true };
const room = {
  id: "r1", name: "Room", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2, categories: [], channels: [{ id: "c1", room_id: "r1", category_id: null, kind: "text", name: "general", topic: "", position: 0, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: null, no_bots: false }],
  roles: [everyone], overrides: [], my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
} as unknown as RoomDetail;

function renderCached(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["room", "r1"], room);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return () => client.getQueryData<RoomDetail>(["room", "r1"])!;
}

const roomGets = (calls: { url: string; init: RequestInit }[]) => calls.filter((c) => /\/rooms\/r1$/.test(c.url) && (c.init.method ?? "GET") === "GET");

describe("room administration writes answers into the cache", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
  });

  it("a saved role", async () => {
    const saved = { ...everyone, permissions: (Permission.VIEW_CHANNEL | Permission.ADD_REACTIONS).toString() };
    const calls = mockFetch({ "/rooms/r1/roles/everyone": { body: saved } });
    const cached = renderCached(<RolesTab room={room} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(cached().roles[0]!.permissions).toBe(saved.permissions));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Role saved"));
    expect(roomGets(calls)).toEqual([]);
  });

  it("a new category and saved overrides", async () => {
    const category = { id: "k1", room_id: "r1", name: "Team", position: 0, no_bots: false };
    const override = { id: "o1", target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "everyone", allow: "0", deny: Permission.VIEW_CHANNEL.toString() };
    const calls = mockFetch({ "/rooms/r1/categories": { body: category }, "/rooms/r1/overrides": { body: [override] } });
    const cached = renderCached(<ChannelsTab room={room} />);
    const u = userEvent.setup();
    await u.type(await screen.findByRole("textbox", { name: "New category" }), "Team{Enter}");
    await waitFor(() => expect(cached().categories).toEqual([category]));
    const editor = screen.getByTestId("channel-editor");
    await u.click(within(editor).getByRole("radio", { name: "View channel: deny" }));
    await u.click(within(editor).getByRole("button", { name: "Save permissions" }));
    await waitFor(() => expect(cached().overrides).toEqual([override]));
    expect(roomGets(calls)).toEqual([]);
  });
});
