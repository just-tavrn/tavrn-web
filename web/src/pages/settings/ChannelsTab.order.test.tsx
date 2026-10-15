// SPDX-License-Identifier: Apache-2.0
// Reordering channels and categories in the room settings' channel tree (lib/channelOrder.ts): the arrows and drag and
// drop send the planned PATCHes one by one, write the answers into the cached room and refetch it on an error.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { ChannelsTab } from "./ChannelsTab";
import { useAuth } from "../../stores/auth";
import { useLocale } from "../../i18n";
import { mockFetch } from "../../test/render";
import { useToasts } from "../../stores/toasts";

const channel = (id: string, name: string, category_id: string | null, position: number, kind = "text") => ({ id, room_id: "r1", category_id, kind, name, topic: "", position, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: null, no_bots: false });
const category = (id: string, name: string, position: number) => ({ id, room_id: "r1", name, position, no_bots: false });
const everyone = { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: Permission.VIEW_CHANNEL.toString(), hoist: false, mentionable: false, is_everyone: true };
const room = {
  id: "r1", name: "Room", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2,
  categories: [category("team", "Team", 0), category("play", "Play", 1)],
  channels: [channel("welcome", "welcome", null, -1, "system"), channel("c1", "one", "team", 0), channel("c2", "two", "team", 1), channel("c3", "three", "team", 2), channel("p1", "dice", "play", 3)],
  roles: [everyone], overrides: [], my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
} as unknown as RoomDetail;

/** The tab on the cached room, as the settings page renders it: patches of the cache re-render it. */
function renderLive(detail: RoomDetail = room) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let fetches = 0;
  client.setQueryData(["room", "r1"], detail);
  function Live() {
    const q = useQuery({ queryKey: ["room", "r1"], queryFn: async () => (fetches++, detail), staleTime: Infinity });
    return q.data ? <ChannelsTab room={q.data} /> : null;
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/rooms/r1/settings/channels"]}>
        <Live />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { cached: () => client.getQueryData<RoomDetail>(["room", "r1"])!, fetches: () => fetches };
}

/** The node's answer to a PATCH: the stored channel or category with the request applied. */
function answers(failOn?: string) {
  return mockFetch({
    "/rooms/r1/channels/": (init, url) => {
      const id = decodeURIComponent(url.split("/channels/")[1]!);
      if (id === failOn) return { status: 403, body: { code: "channel.overrides_forbidden", status: 403, title: "Forbidden", detail: "Needs manage_roles there", type: "x" } };
      return { body: { ...room.channels.find((c) => c.id === id), ...JSON.parse(String(init.body)) } };
    },
    "/rooms/r1/categories/": (init, url) => {
      const id = decodeURIComponent(url.split("/categories/")[1]!);
      return { body: { ...room.categories.find((c) => c.id === id), ...JSON.parse(String(init.body)) } };
    },
  });
}

const patches = (calls: { url: string; init: RequestInit }[]) => calls.filter((c) => c.init.method === "PATCH").map((c) => [c.url.replace(/^.*\/rooms\/r1\//, ""), JSON.parse(String(c.init.body))]);
const treeOrder = () => within(screen.getByTestId("channel-tree")).getAllByTestId("channel-tree-row").map((r) => r.dataset.channel);

describe("ChannelsTab: reordering", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
    useToasts.setState({ toasts: [] });
  });

  it("the tree follows the sidebar: welcome channel and channels without category first, then the categories", async () => {
    renderLive();
    expect(await screen.findByTestId("channel-tree")).toBeInTheDocument();
    expect(treeOrder()).toEqual(["welcome", "c1", "c2", "c3", "p1"]);
    // The welcome channel has no handle and no arrows; every other row has both, named after the channel.
    expect(screen.getAllByTestId("reorder-handle")).toHaveLength(4 + 2);
    expect(screen.getByRole("img", { name: "Drag one to reorder" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Drag the category Team to reorder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move welcome up" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move one up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move three down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move the category Team up" })).toBeDisabled();
  });

  it("an arrow button sends the planned PATCHes in order, updates the cache and keeps the focus", async () => {
    const calls = answers();
    const { cached } = renderLive();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Move one down" }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Order saved"));
    expect(patches(calls)).toEqual([
      ["channels/c1", { position: 1 }],
      ["channels/c2", { position: 0 }],
    ]);
    expect(cached().channels.filter((c) => c.category_id === "team").map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
    expect(treeOrder()).toEqual(["welcome", "c2", "c1", "c3", "p1"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Move one down" })).toHaveFocus());
  });

  it("a category moves up with its arrow", async () => {
    const calls = answers();
    const { cached } = renderLive();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Move the category Play up" }));
    await waitFor(() => expect(cached().categories.map((c) => c.id)).toEqual(["play", "team"]));
    expect(patches(calls)).toEqual([
      ["categories/play", { position: 0 }],
      ["categories/team", { position: 1 }],
    ]);
  });

  it("a refused move shows the node's error and refetches the room", async () => {
    const calls = answers("c3");
    const { fetches } = renderLive();
    const tree = await screen.findByTestId("channel-tree");
    // Drag "three" onto the header of "Play": into that category, at its end.
    const row = within(tree).getAllByTestId("channel-tree-row").find((r) => r.dataset.channel === "c3")!;
    const header = within(tree).getAllByTestId("channel-tree-category").find((r) => r.dataset.category === "play")!;
    const dataTransfer = { setData: () => {}, getData: () => "channel:c3", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(header, { dataTransfer });
    expect(header.className).toContain("ring-2");
    await act(async () => {
      fireEvent.drop(header, { dataTransfer });
    });
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.kind === "error")).toBe(true));
    expect(patches(calls)).toEqual([["channels/c3", { position: 1, category_id: "play" }]]);
    await waitFor(() => expect(fetches()).toBe(1));
  });

  it("a channel dragged onto another row takes its place", async () => {
    const calls = answers();
    renderLive();
    const tree = await screen.findByTestId("channel-tree");
    const row = (id: string) => within(tree).getAllByTestId("channel-tree-row").find((r) => r.dataset.channel === id)!;
    const dataTransfer = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(row("p1"), { dataTransfer });
    // Nothing goes onto the welcome channel, and a category never between channels.
    fireEvent.dragOver(row("welcome"), { dataTransfer });
    expect(row("welcome").className).not.toContain("ring-2");
    await act(async () => {
      fireEvent.drop(row("c2"), { dataTransfer });
    });
    await waitFor(() => expect(treeOrder()).toEqual(["welcome", "c1", "p1", "c2", "c3"]));
    expect(patches(calls)).toEqual([
      ["channels/p1", { position: 1, category_id: "team" }],
      ["channels/c2", { position: 2 }],
      ["channels/c3", { position: 3 }],
    ]);
  });

  it("the editor's category dropdown appends to the end of the new category and closes the gap in the old one", async () => {
    const calls = answers();
    const { cached } = renderLive();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /^#\s*one/ }));
    const editor = await screen.findByTestId("channel-editor");
    await u.selectOptions(within(editor).getByRole("combobox", { name: "Category" }), "play");
    await u.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Channel saved"));
    const sent = patches(calls);
    expect(sent[0]![0]).toBe("channels/c1");
    expect(sent[0]![1]).toMatchObject({ category_id: "play", position: 1, name: "one" });
    expect(sent.slice(1)).toEqual([
      ["channels/p1", { position: 0 }],
      ["channels/c2", { position: 0 }],
      ["channels/c3", { position: 1 }],
    ]);
    expect(cached().channels.filter((c) => c.category_id === "play").map((c) => c.id)).toEqual(["p1", "c1"]);
  });

  it("members without manage_channels see the tree without handles or arrows", async () => {
    renderLive({ ...room, is_owner: false, my_permissions: (Permission.VIEW_CHANNEL | Permission.MANAGE_ROLES).toString() } as RoomDetail);
    expect(await screen.findByTestId("channel-tree")).toBeInTheDocument();
    expect(treeOrder()).toEqual(["welcome", "c1", "c2", "c3", "p1"]);
    expect(screen.queryAllByTestId("reorder-handle")).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.getAllByTestId("channel-tree-row").every((r) => r.getAttribute("draggable") === null)).toBe(true);
  });
});

describe("ChannelsTab: the welcome channel's editor", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
    useToasts.setState({ toasts: [] });
  });

  it("sends only the topic (the node refuses renaming, moving and the other fields of the welcome channel)", async () => {
    const calls = answers();
    renderLive();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /welcome/ }));
    const editor = await screen.findByTestId("channel-editor");
    expect(within(editor).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(editor).getByRole("combobox", { name: "Category" })).toBeDisabled();
    await u.type(within(editor).getByRole("textbox", { name: "Topic" }), "Hello");
    await u.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Channel saved"));
    expect(patches(calls)).toEqual([["channels/welcome", { topic: "Hello" }]]);
  });
});
