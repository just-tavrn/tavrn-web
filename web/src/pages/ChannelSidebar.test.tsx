// SPDX-License-Identifier: Apache-2.0
// The room header of the sidebar: one menu button (icon, name, chevron) with the room menu; reports on the chevron.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { Permission, type RoomDetail } from "@tavrn/sdk";
import { ChannelSidebar } from "./ChannelSidebar";
import { mockFetch, renderWithProviders } from "../test/render";
import { useUnread } from "../stores/unread";

const channel = (id: string, kind: string, name: string, position: number) => ({ id, room_id: "r1", category_id: null, kind, name, topic: "", position, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: null });
const perms = (...bits: bigint[]) => bits.reduce((a, b) => a | b, 0n).toString();
const room = (my_permissions: string): RoomDetail => ({
  id: "r1", name: "Gilde der sehr langen Raumnamen", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, age_gate: "none", history_restore: "request", no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2, categories: [], channels: [channel("c1", "text", "allgemein", 0)],
  roles: [{ id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: "3", hoist: false, mentionable: false, is_everyone: true }],
  overrides: [], my_roles: [], my_permissions, is_owner: false, read_states: [],
});

function renderSidebar() {
  return renderWithProviders(
    <Routes>
      <Route path="/rooms/r1/settings" element={<p data-testid="settings-page">settings</p>} />
      <Route path="/rooms/r1/settings/reports" element={<p data-testid="reports-page">reports</p>} />
      <Route path="*" element={<ChannelSidebar roomId="r1" />} />
    </Routes>,
    { route: "/rooms/r1" },
  );
}

const ids = (menu: HTMLElement) => [...menu.querySelectorAll("[data-menu-item]")].map((e) => e.getAttribute("data-menu-item"));

describe("room header", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  it("is one menu button with the room name; no separate invite, settings or ⋯ buttons", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: room(perms(Permission.CREATE_INVITES)) }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    const header = await screen.findByTestId("room-header-menu");
    expect(header.tagName).toBe("BUTTON");
    expect(header).toHaveAttribute("aria-haspopup", "menu");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(within(header).getByTestId("room-name")).toHaveTextContent("Gilde der sehr langen Raumnamen");
    expect(header).toHaveAccessibleName("Gilde der sehr langen Raumnamen");
    // The header is the heading of the sidebar.
    expect(screen.getByRole("heading", { level: 2 })).toContainElement(header);
    expect(screen.queryByRole("button", { name: "Einladen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Aktionen für/ })).toBeNull();
    expect(screen.queryByTestId("room-settings-button")).toBeNull();
    const top = container.querySelector("[data-testid='room-header']")!;
    expect(top.textContent ?? "").not.toMatch(/[⚙✉⋯]/u);
  });

  it("opens the room menu with invite and settings first; settings navigates", async () => {
    const user = userEvent.setup();
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: room(perms(Permission.CREATE_INVITES)) }, "/node": { body: { capabilities: [] } } });
    renderSidebar();
    const header = await screen.findByTestId("room-header-menu");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    const menu = await screen.findByTestId("room-menu");
    await within(menu).findByRole("menuitem", { name: "Leute einladen" });
    expect(ids(menu).slice(0, 2)).toEqual(["invite", "settings"]);
    expect(within(menu).getByTestId("room-settings-button")).toHaveAccessibleName("Raumeinstellungen");
    await user.click(within(menu).getByTestId("room-settings-button"));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("the keyboard opens it with Enter and moves with the arrow keys", async () => {
    const user = userEvent.setup();
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: room(perms(Permission.CREATE_INVITES)) }, "/node": { body: { capabilities: [] } } });
    renderSidebar();
    const header = await screen.findByTestId("room-header-menu");
    header.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByTestId("room-menu");
    await within(menu).findByRole("menuitem", { name: "Leute einladen" });
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByTestId("room-settings-button")).toHaveFocus();
    // Escape closes it and gives the focus back; Space opens it again.
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("room-menu")).toBeNull();
    expect(header).toHaveFocus();
    await user.keyboard(" ");
    expect(await screen.findByTestId("room-menu")).toBeInTheDocument();
  });

  it("moderators see the open reports on the chevron and as the hint of the settings entry, which opens the inbox", async () => {
    const user = userEvent.setup();
    mockFetch({ "/rooms/r1/reports": { body: { open: 3, reports: [] } }, "/rooms/r1": { body: room(perms(Permission.CREATE_INVITES, Permission.MODERATE_MEMBERS)) }, "/node": { body: { capabilities: ["reports.v1"] } } });
    renderSidebar();
    const badge = await screen.findByTestId("room-reports-badge");
    expect(badge).toHaveTextContent("3");
    const header = screen.getByTestId("room-header-menu");
    expect(header).toContainElement(badge);
    expect(header).toHaveAccessibleName("Gilde der sehr langen Raumnamen, 3 offene Meldungen");
    await user.click(header);
    const settings = within(await screen.findByTestId("room-menu")).getByTestId("room-settings-button");
    expect(settings).toHaveTextContent("3");
    expect(settings).toHaveAccessibleName("Raumeinstellungen · 3 offene Meldungen");
    await user.click(settings);
    expect(screen.getByTestId("reports-page")).toBeInTheDocument();
  });
});

describe("channel encryption marks", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  it("encrypted and plaintext channels show 16 px SVG locks with a name, no text glyph", async () => {
    const detail = { ...room(perms()), channels: [{ ...channel("c1", "text", "geheim", 0), encrypted: true }, channel("c2", "text", "offen", 1), channel("v1", "voice", "Sprache", 2)] };
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: detail }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    const lock = await screen.findByTestId("channel-lock");
    expect(lock).toHaveAccessibleName("Verschlüsselt");
    expect(lock).toHaveAttribute("title", "Verschlüsselt");
    expect(lock.querySelector("svg")).toHaveAttribute("width", "16");
    const open = screen.getByTestId("channel-unlocked");
    expect(open).toHaveAccessibleName("Unverschlüsselt");
    expect(open.querySelector("svg")).toHaveAttribute("width", "16");
    expect(container.querySelector("nav")?.textContent ?? "").not.toMatch(/[\u{1F512}\u{1F513}]/u);
  });
});

describe("visible channels and categories (layered overrides)", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  const layered = (my_permissions: string): RoomDetail => ({
    ...room(my_permissions),
    // @everyone without view_channel; one channel allows it.
    roles: [{ id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: perms(Permission.SEND_MESSAGES), hoist: false, mentionable: false, is_everyone: true }],
    categories: [
      { id: "team", room_id: "r1", name: "Team", position: 0, no_bots: false },
      { id: "staff", room_id: "r1", name: "Staff", position: 1, no_bots: false },
    ],
    channels: [
      { ...channel("w", "system", "welcome", -1), system_name: "welcome" },
      { ...channel("open", "text", "offen", 0), category_id: "team" },
      { ...channel("secret", "text", "geheim", 1), category_id: "team" },
      { ...channel("staff-room", "text", "intern", 2), category_id: "staff" },
    ],
    overrides: [{ id: "o1", target_type: "channel", target_id: "open", subject_type: "role", subject_id: "everyone", allow: perms(Permission.VIEW_CHANNEL), deny: "0" }],
  });

  it("a member sees exactly the visible channel and its category, plus the welcome channel", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: layered(perms(Permission.SEND_MESSAGES)) }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    await screen.findByText("offen");
    const rows = [...container.querySelectorAll("[data-testid='channel-row']")].map((e) => e.getAttribute("data-channel"));
    expect(rows).toEqual(["w", "open"]);
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.queryByText("Staff")).toBeNull();
  });

  it("channel managers also see empty categories", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: layered(perms(Permission.SEND_MESSAGES, Permission.MANAGE_CHANNELS)) }, "/node": { body: { capabilities: [] } } });
    renderSidebar();
    await screen.findByText("offen");
    expect(screen.getByText("Staff")).toBeInTheDocument();
    expect(screen.queryByText("intern")).toBeNull();
  });
});
