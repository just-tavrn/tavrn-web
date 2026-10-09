// SPDX-License-Identifier: Apache-2.0
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import type { Message, RoomDetail } from "@tavrn/sdk";
import { MessageList } from "../components/MessageList";
import { ChannelSidebar } from "./ChannelSidebar";
import { mockFetch, renderWithProviders } from "../test/render";
import { useUnread } from "../stores/unread";
import { useMlsUi } from "../stores/mls";

// The welcome channel (design note 4.11): kind `system`, pinned at the top, join/leave entries, read-only.
const channel = (id: string, kind: string, name: string, position: number, category_id: string | null = "cat") => ({ id, room_id: "r1", category_id, kind, name, topic: "", position, encrypted: false, sync_with_category: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: kind === "system" ? "welcome" : null });
const room: RoomDetail = {
  id: "r1", name: "Gilde", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed", age_gate: "none",
  member_count: 2, categories: [{ id: "cat", room_id: "r1", name: "Allgemein", position: 0, no_bots: false }],
  channels: [channel("c1", "text", "allgemein", 0), channel("w1", "system", "welcome", 5, null)],
  roles: [{ id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: "3", hoist: false, mentionable: false, is_everyone: true }],
  overrides: [], my_roles: [], my_permissions: "3", is_owner: false,
  read_states: [
    { conversation_id: "w1", last_message_id: "m5", last_read_message_id: "m4", unread_count: 1, mention_count: 1 },
    { conversation_id: "c1", last_message_id: "m3", last_read_message_id: "m1", unread_count: 2, mention_count: 0 },
  ],
};

describe("welcome channel", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  it("is pinned above the categories with its own icon and only a 'new' dot, no counts", async () => {
    mockFetch({ "/rooms/r1": { body: room } });
    renderWithProviders(<ChannelSidebar roomId="r1" />);
    const pinned = await screen.findByTestId("pinned-channels");
    const row = within(pinned).getByTestId("channel-row");
    expect(row).toHaveAttribute("data-kind", "system");
    expect(row).toHaveTextContent("👋");
    expect(within(row).getByTestId("welcome-new")).toBeInTheDocument();
    expect(within(row).queryByTestId("mention-count")).toBeNull();
    expect(within(row).queryByTestId("unread-count")).toBeNull();
    // Ordinary channels keep their badges.
    const general = screen.getAllByTestId("channel-row").find((r) => r.getAttribute("data-channel") === "c1")!;
    expect(within(general).getByTestId("unread-count")).toHaveTextContent("2");
  });

  it("shows no dot once the user opened it since the last entry", async () => {
    mockFetch({ "/rooms/r1": { body: { ...room, read_states: [{ conversation_id: "w1", last_message_id: "m5", last_read_message_id: "m5", unread_count: 0, mention_count: 0 }] } } });
    renderWithProviders(<ChannelSidebar roomId="r1" />);
    const pinned = await screen.findByTestId("pinned-channels");
    expect(within(pinned).queryByTestId("welcome-new")).toBeNull();
  });

  it("renders join and leave entries localized with avatar and time", () => {
    const base = { conversation_id: "w1", author_id: "u2", device_id: null, encrypted: false, format: 1, epoch: null, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };
    const messages = [
      { ...base, id: "m2", author: "bob@x", content: { type: "system.leave", user: "bob@x" } },
      { ...base, id: "m1", author: "bob@x", content: { type: "system.join", user: "bob@x", display_name: "Bob" } },
    ] as Message[];
    render(<MessageList messages={messages} currentUserId="u1" canManage={false} canReact hasMore={false} />);
    const events = screen.getAllByTestId("member-event");
    expect(events.map((e) => e.getAttribute("data-event"))).toEqual(["join", "leave"]);
    expect(events[0]).toHaveTextContent("Bob ist dem Raum beigetreten");
    expect(events[1]).toHaveTextContent("bob hat den Raum verlassen");
    expect(within(events[0]!).getByTestId("message-avatar")).toHaveAttribute("data-address", "bob@x");
    expect(events[0]!.querySelector("time")).not.toBeNull();
  });

  it("renders security key entries; the badge comes from this device's own pin", () => {
    const base = { conversation_id: "w1", author_id: "u2", device_id: null, encrypted: false, format: 1, epoch: null, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };
    const messages = [
      { ...base, id: "m4", author: "carol@x", content: { type: "system.key_changed", user: "carol@x", display_name: "Carol", at: base.created_at, rotated: false } },
      { ...base, id: "m3", author: "bob@x", content: { type: "system.key_changed", user: "bob@x", display_name: "Bob", at: base.created_at, rotated: true } },
    ] as Message[];
    useMlsUi.setState({ changedKeys: { "carol@x": true }, rotatedKeys: { "bob@x": true } });
    render(<MessageList messages={messages} currentUserId="u1" canManage={false} canReact hasMore={false} />);
    const events = screen.getAllByTestId("key-event");
    expect(events.map((e) => e.getAttribute("data-rotated"))).toEqual(["true", "false"]);
    expect(events[0]).toHaveTextContent("Bob hat den Sicherheitsschlüssel erneuert (vom bisherigen Schlüssel signiert)");
    expect(within(events[0]!).getByTestId("key-rotated-badge")).toBeInTheDocument();
    expect(events[1]).toHaveTextContent("Der Sicherheitsschlüssel von Carol hat sich geändert");
    expect(within(events[1]!).getByTestId("key-changed-badge")).toBeInTheDocument();
    // Acknowledged: plain text only.
    act(() => useMlsUi.setState({ changedKeys: {}, rotatedKeys: {} }));
    expect(within(screen.getAllByTestId("key-event")[1]!).queryByTestId("key-changed-badge")).toBeNull();
    expect(within(screen.getAllByTestId("key-event")[0]!).queryByTestId("key-rotated-badge")).toBeNull();
  });

  it("renders bot entries of encrypted channels (design note 4.7): added by itself or a member, removed with the reason", () => {
    const base = { conversation_id: "w1", author_id: "b1", device_id: null, encrypted: false, format: 1, epoch: null, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };
    const messages = [
      { ...base, id: "m7", author: "echo@x", content: { type: "system.bot_removed", bot: "echo@x", display_name: "Echo", channel: "c1", channel_name: "geheim", reason: "bots_not_allowed" } },
      { ...base, id: "m6", author: "echo@x", content: { type: "system.bot_added", bot: "echo@x", display_name: "Echo", channel: "c1", channel_name: "geheim", by: "carol@x" } },
      { ...base, id: "m5", author: "echo@x", content: { type: "system.bot_added", bot: "echo@x", display_name: "Echo", channel: "c0", channel_name: "general", channel_system_name: "general", by: "echo@x" } },
    ] as Message[];
    render(<MessageList messages={messages} currentUserId="u1" canManage={false} canReact hasMore={false} />);
    const events = screen.getAllByTestId("bot-event");
    expect(events.map((e) => e.getAttribute("data-event"))).toEqual(["added", "added", "removed"]);
    expect(events[0]).toHaveTextContent("Bot Echo ist dem verschlüsselten Channel #allgemein beigetreten");
    expect(events[1]).toHaveTextContent("carol@x hat Bot Echo zum verschlüsselten Channel #geheim hinzugefügt");
    expect(events[2]).toHaveTextContent("Bot Echo hat den verschlüsselten Channel #geheim verlassen: Bots sind in diesem Channel nicht mehr erlaubt");
    expect(events[2]).toHaveAttribute("data-reason", "bots_not_allowed");
    expect(within(events[0]!).getByTestId("message-avatar")).toHaveAttribute("data-address", "echo@x");
  });

  it("marks encrypted channels that allow bots in a per_channel room, and explicit no-bots zones only", async () => {
    const enc = (id: string, extra: object) => ({ ...channel(id, "text", id, 1), encrypted: true, no_bots: false, no_bots_effective: true, bots_allowed: false, ...extra });
    const perChannel = {
      ...room,
      bots_in_encrypted_channels: "per_channel",
      channels: [enc("closed", {}), enc("open", { bots_allowed: true, no_bots_effective: false }), enc("zone", { no_bots: true }), channel("w1", "system", "welcome", 5, null)],
    };
    mockFetch({ "/rooms/r1": { body: perChannel } });
    renderWithProviders(<ChannelSidebar roomId="r1" />);
    await screen.findByTestId("pinned-channels");
    const row = (id: string) => screen.getAllByTestId("channel-row").find((r) => r.getAttribute("data-channel") === id)!;
    expect(within(row("open")).getByTestId("bots-allowed-icon")).toBeInTheDocument();
    expect(within(row("closed")).queryByTestId("bots-allowed-icon")).toBeNull();
    expect(within(row("closed")).queryByTestId("no-bots-icon")).toBeNull();
    expect(within(row("zone")).getByTestId("no-bots-icon")).toBeInTheDocument();
  });
});
