// SPDX-License-Identifier: Apache-2.0
// Layered overrides in the channel settings (tavrn-protocol permissions.md): the category editor, the channel editor
// without the sync switch, inherited values and "Reset to category".
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { ChannelsTab } from "./ChannelsTab";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const channel = (id: string, name: string, category_id: string | null) => ({ id, room_id: "r1", category_id, kind: "text", name, topic: "", position: 0, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: null, no_bots: false });
const room: RoomDetail = {
  id: "r1", name: "Raum", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2, categories: [{ id: "team", room_id: "r1", name: "Team", position: 0, no_bots: false }],
  channels: [channel("c1", "allgemein", "team")],
  roles: [{ id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES).toString(), hoist: false, mentionable: false, is_everyone: true }],
  overrides: [
    { id: "o1", target_type: "category", target_id: "team", subject_type: "role", subject_id: "everyone", allow: "0", deny: Permission.SEND_MESSAGES.toString() },
    { id: "o2", target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "everyone", allow: Permission.ADD_REACTIONS.toString(), deny: "0" },
  ],
  my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
} as unknown as RoomDetail;

describe("ChannelsTab: layered overrides", () => {
  beforeEach(() => useAuth.setState({ token: "acc" }));

  it("the channel editor has no sync switch and shows what each neutral bit inherits", async () => {
    mockFetch({});
    renderWithProviders(<ChannelsTab room={room} />, { route: "/rooms/r1/settings/channels" });
    const editor = await screen.findByTestId("channel-editor");
    expect(within(editor).queryByText(/synchronisieren/)).toBeNull();
    expect(within(editor).getByTestId("inherited-SEND_MESSAGES")).toHaveTextContent("Geerbt: von der Kategorie verboten");
    expect(within(editor).getByTestId("inherited-VIEW_CHANNEL")).toHaveTextContent("Geerbt: von den Rollen erlaubt");
    expect(within(editor).queryByRole("radiogroup", { name: "Mitglieder bannen" })).toBeNull();
  });

  it("the category's permissions are edited with the same editor", async () => {
    const calls = mockFetch({ "/rooms/r1/overrides": { body: [] } });
    renderWithProviders(<ChannelsTab room={room} />, { route: "/rooms/r1/settings/channels" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Berechtigungen in der Kategorie Team" }));
    const editor = screen.getByTestId("category-editor");
    expect(within(editor).getByRole("heading", { name: "Berechtigungen in dieser Kategorie: Team" })).toBeInTheDocument();
    expect(within(editor).getByRole("radio", { name: "Nachrichten senden: verbieten" })).toHaveAttribute("aria-checked", "true");
    expect(within(editor).getByTestId("inherited-SEND_MESSAGES")).toHaveTextContent("Geerbt: von den Rollen erlaubt");
    expect(within(editor).queryByTestId("reset-to-category")).toBeNull();
    await u.click(within(editor).getByRole("radio", { name: "Channel ansehen: verbieten" }));
    await u.click(within(editor).getByRole("button", { name: "Berechtigungen speichern" }));
    const put = calls.find((c) => c.url.endsWith("/rooms/r1/overrides"));
    expect(JSON.parse(String(put!.init.body))).toMatchObject({ target_type: "category", target_id: "team", subject_type: "role", subject_id: "everyone", allow: "0", deny: (Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL).toString() });
  });

  it("\"Reset to category\" asks first, then removes the channel's own overrides", async () => {
    const calls = mockFetch({ "/rooms/r1/overrides": { body: [] } });
    renderWithProviders(<ChannelsTab room={room} />, { route: "/rooms/r1/settings/channels" });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId("reset-to-category"));
    const dialog = screen.getByRole("dialog", { name: "Auf Kategorie zurücksetzen" });
    expect(dialog).toHaveTextContent("(1)");
    expect(calls.filter((c) => c.url.endsWith("/overrides"))).toHaveLength(0);
    await u.click(within(dialog).getByRole("button", { name: "Zurücksetzen" }));
    const puts = calls.filter((c) => c.url.endsWith("/rooms/r1/overrides"));
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]!.init.body))).toEqual({ target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "everyone", allow: "0", deny: "0", upload_allow: [], upload_deny: [] });
  });
});
