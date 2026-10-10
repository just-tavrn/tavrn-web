// SPDX-License-Identifier: Apache-2.0
// The room card of the rail: hover with a delay, keyboard focus, Escape, hoverable (WCAG 1.4.13), content with the
// voice channels and the avatar limit, and the touch variant as the head of the long-press menu (docs/CLIENT.md).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceParticipant } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { resetNodeCaches, useNodes } from "../stores/nodes";
import { useUnread } from "../stores/unread";
import { useRailFolders } from "../stores/railFolders";
import { useVoicePresence } from "../voice/presence";
import { mockFetch, renderWithProviders } from "../test/render";
import { RoomRail } from "./RoomRail";
import { HOVER_DELAY_MS } from "./RoomHoverCard";

const me = { id: "A-ID", username: "alice", domain: "a.test", address: "alice@a.test", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const room = (id: string, name: string, description = "") => ({ id, name, icon: null, icon_still: null, description, join_mode: "invite", owner_id: "A-ID" });
const ROOMS = [room("A", "Alpha", "Raids every Friday"), room("B", "Bravo")];
const detailA = {
  ...room("A", "Alpha", "Raids every Friday"),
  member_count: 42,
  channels: [
    { id: "cA", kind: "text", name: "general" },
    { id: "V1", kind: "voice", name: "Lounge" },
    { id: "V2", kind: "voice", name: "Raid" },
  ],
  read_states: [{ conversation_id: "cA", last_message_id: "02", last_read_message_id: "01", unread_count: 0, mention_count: 0 }],
  my_permissions: "0",
  is_owner: false,
};
const p = (user: string, streaming = false): VoiceParticipant => ({ user: `${user}@a.test`, user_id: user, device_id: "D", identity: `${user}@a.test/D`, muted: false, deafened: false, streaming, camera: false, server_muted: false, joined_at: "", connection: "connected" });
const coarse = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({ matches: matches && query.includes("coarse"), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });

beforeEach(() => {
  localStorage.clear();
  resetNodeCaches();
  useNodes.getState().clear();
  useUnread.setState({ states: {}, held: {} });
  useRailFolders.getState().reset();
  useVoicePresence.getState().reset();
  useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "D", home: null });
  mockFetch({ "/rooms/A": { body: detailA }, "/rooms/B": { body: { ...detailA, ...room("B", "Bravo"), member_count: 1, channels: [] } }, "/rooms": { body: ROOMS }, "/conversations": { body: [] } });
  coarse(false);
});

afterEach(() => coarse(false));

const link = (name: RegExp) => screen.getByRole("link", { name });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("room hover card", () => {
  it("opens after hovering a moment, shows the room and who is in which voice channel", async () => {
    act(() => {
      useVoicePresence.getState().apply("a.test", { room_id: "A", channel_id: "V1", participants: [p("bob"), p("carol", true)] });
      useVoicePresence.getState().apply("a.test", { room_id: "A", channel_id: "V2", participants: [p("dave")] });
    });
    renderWithProviders(<RoomRail />);
    const alpha = await waitFor(() => link(/^Alpha/));
    fireEvent.pointerEnter(alpha, { pointerType: "mouse" });
    await wait(HOVER_DELAY_MS / 3);
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
    const card = await screen.findByTestId("room-hover-card");
    expect(card).toHaveAttribute("role", "tooltip");
    expect(alpha).toHaveAttribute("aria-describedby", card.id);
    expect(within(card).getByTestId("room-card-name")).toHaveTextContent("Alpha");
    expect(within(card).getByTestId("room-card-description")).toHaveTextContent("Raids every Friday");
    await waitFor(() => expect(within(card).getByTestId("room-card-counts")).toHaveTextContent("42 Mitglieder"));
    const channels = within(card).getAllByTestId("room-card-channel");
    expect(channels.map((c) => c.getAttribute("data-channel"))).toEqual(["V1", "V2"]);
    await waitFor(() => expect(channels[0]).toHaveTextContent("Lounge"));
    expect(within(channels[0]!).getByRole("list", { name: "Sprachkanal Lounge" })).toBeInTheDocument();
    expect(within(channels[0]!).getAllByTestId("room-card-participant").map((li) => li.querySelector(".sr-only")!.textContent)).toEqual(["bob", "carol, streamt"]);
    expect(within(channels[1]!).getAllByTestId("room-card-participant").map((li) => li.getAttribute("data-user"))).toEqual(["dave@a.test"]);
  });

  it("limits the avatars to eight and names the rest", async () => {
    act(() => useVoicePresence.getState().apply("a.test", { room_id: "A", channel_id: "V1", participants: Array.from({ length: 11 }, (_, i) => p(`user${i}`)) }));
    renderWithProviders(<RoomRail />);
    fireEvent.pointerEnter(await waitFor(() => link(/^Alpha/)), { pointerType: "mouse" });
    const card = await screen.findByTestId("room-hover-card");
    expect(within(card).getAllByTestId("room-card-participant")).toHaveLength(8);
    expect(within(card).getByTestId("room-card-more")).toHaveTextContent("+3");
    expect(within(card).getByTestId("room-card-more")).toHaveTextContent("und 3 weitere");
  });

  it("stays open while the pointer is over it, closes when the pointer leaves both and with Escape", async () => {
    renderWithProviders(<RoomRail />);
    const alpha = await waitFor(() => link(/^Alpha/));
    fireEvent.pointerEnter(alpha, { pointerType: "mouse" });
    const card = await screen.findByTestId("room-hover-card");
    // From the room onto the card: it stays.
    fireEvent.pointerLeave(alpha, { pointerType: "mouse" });
    fireEvent.pointerEnter(card);
    await wait(400);
    expect(screen.getByTestId("room-hover-card")).toBeInTheDocument();
    fireEvent.pointerLeave(card);
    await waitFor(() => expect(screen.queryByTestId("room-hover-card")).toBeNull());
    // Escape anywhere dismisses it.
    fireEvent.pointerEnter(alpha, { pointerType: "mouse" });
    await screen.findByTestId("room-hover-card");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
    // A touch never opens it by hover.
    fireEvent.pointerEnter(link(/^Bravo/), { pointerType: "touch" });
    await wait(HOVER_DELAY_MS + 100);
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
  });

  it("opens at once on keyboard focus and closes on blur and Escape", async () => {
    renderWithProviders(<RoomRail />);
    const alpha = await waitFor(() => link(/^Alpha/));
    act(() => alpha.focus());
    expect(screen.getByTestId("room-hover-card")).toBeInTheDocument();
    fireEvent.keyDown(alpha, { key: "Escape" });
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
    expect(alpha).toHaveFocus();
    act(() => link(/^Bravo/).focus());
    expect(within(screen.getByTestId("room-hover-card")).getByTestId("room-card-name")).toHaveTextContent("Bravo");
    act(() => link(/^Bravo/).blur());
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
  });

  it("does not open while the room's menu is open", async () => {
    renderWithProviders(<RoomRail />);
    const alpha = await waitFor(() => link(/^Alpha/));
    fireEvent.contextMenu(alpha, { clientX: 10, clientY: 10 });
    await screen.findByTestId("room-menu");
    fireEvent.pointerEnter(alpha, { pointerType: "mouse" });
    await wait(HOVER_DELAY_MS + 100);
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
  });

  it("on touch devices the card heads the long-press menu (no hover card)", async () => {
    coarse(true);
    act(() => useVoicePresence.getState().apply("a.test", { room_id: "A", channel_id: "V1", participants: [p("bob")] }));
    renderWithProviders(<RoomRail />);
    const alpha = await waitFor(() => link(/^Alpha/));
    act(() => alpha.focus());
    expect(screen.queryByTestId("room-hover-card")).toBeNull();
    fireEvent.contextMenu(alpha, { clientX: 10, clientY: 10 });
    const menu = await screen.findByTestId("room-menu");
    const header = within(menu).getByTestId("menu-header");
    expect(within(header).getByTestId("room-card-name")).toHaveTextContent("Alpha");
    expect(within(header).getAllByTestId("room-card-participant").map((li) => li.getAttribute("data-user"))).toEqual(["bob@a.test"]);
    // Not a stop of the arrow keys: the first item has the focus.
    await waitFor(() => expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus());
  });
});

