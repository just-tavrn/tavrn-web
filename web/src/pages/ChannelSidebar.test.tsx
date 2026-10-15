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

describe("channel access marks (private and restricted, never the lock)", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  const { VIEW_CHANNEL: V, READ_HISTORY: H, CONNECT: C, SEND_MESSAGES: M } = Permission;
  // @everyone may view, read, write and connect; "stage" denies connect to it, "staff" view (the "mods" role may view
  // it again), "news" denies @everyone writing.
  const marked = (is_owner: boolean, my_roles: string[]): RoomDetail => ({
    ...room(perms(V, H, M, C)),
    roles: [
      { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: perms(V, H, M, C), hoist: false, mentionable: false, is_everyone: true },
      { id: "mods", room_id: "r1", name: "Mods", color: null, position: 1, permissions: "0", hoist: false, mentionable: false, is_everyone: false },
    ],
    channels: [{ ...channel("open", "text", "offen", 0), encrypted: true }, { ...channel("staff", "text", "intern", 1), encrypted: true }, channel("news", "text", "news", 2), channel("stage", "voice", "Bühne", 3)],
    overrides: [
      { id: "o1", target_type: "channel", target_id: "stage", subject_type: "role", subject_id: "everyone", allow: "0", deny: perms(C) },
      { id: "o2", target_type: "channel", target_id: "staff", subject_type: "role", subject_id: "everyone", allow: "0", deny: perms(V) },
      { id: "o3", target_type: "channel", target_id: "staff", subject_type: "role", subject_id: "mods", allow: perms(V), deny: "0" },
      { id: "o4", target_type: "channel", target_id: "news", subject_type: "role", subject_id: "everyone", allow: "0", deny: perms(M) },
    ],
    my_roles, is_owner,
  });
  const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-channel='${id}']`)!;

  it("a member sees the restricted marks on the channels they may not use and the private marks, in that order after the name", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: marked(false, ["mods"]) }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    await screen.findByText("Bühne");
    // Open channel with the rights: no access mark, the lock stays the encryption mark.
    expect(within(row(container, "open")).queryByTestId("channel-private")).toBeNull();
    expect(within(row(container, "open")).queryByTestId("channel-restricted")).toBeNull();
    expect(within(row(container, "open")).getByTestId("channel-lock")).toHaveAccessibleName("Verschlüsselt");
    // Private text channel (visible through the role): the group-with-a-slash mark, named, with its tooltip.
    const priv = within(row(container, "staff")).getByTestId("channel-private");
    expect(priv).toHaveAccessibleName("Nur für bestimmte Rollen sichtbar");
    expect(priv).toHaveAttribute("title", "Nur für bestimmte Rollen sichtbar");
    expect(priv.querySelector("svg")).toHaveAttribute("width", "16");
    expect(within(row(container, "staff")).queryByTestId("channel-restricted")).toBeNull();
    // Read-only for this member: the no-entry mark and the name dimmed (fg-2 keeps 4.5:1), still a link.
    const news = row(container, "news");
    const ro = within(news).getByTestId("channel-restricted");
    expect(ro).toHaveAccessibleName("Für dich nur lesbar");
    expect(ro).toHaveAttribute("title", "Für dich nur lesbar");
    expect(within(news).getByText("news")).toHaveClass("text-fg-2");
    expect(within(news).getByRole("link")).toHaveAccessibleName(/news.*Für dich nur lesbar/);
    expect(within(row(container, "open")).getByText("offen")).not.toHaveClass("text-fg-2");
    // Voice: joining only for certain roles and not for this member; both marks, private first, named on the link.
    const stage = row(container, "stage");
    const marks = [...stage.querySelectorAll("[data-access]")].map((e) => e.getAttribute("data-access"));
    expect(marks).toEqual(["join_private", "restricted_join"]);
    expect(within(stage).getByTestId("channel-private")).toHaveAccessibleName("Beitreten nur für bestimmte Rollen");
    expect(within(stage).getByTestId("channel-restricted")).toHaveAccessibleName("Du siehst diesen Channel, kannst ihm aber nicht beitreten");
    expect(within(stage).getByRole("link")).toHaveAccessibleName("Sprachkanal Bühne, Beitreten nur für bestimmte Rollen, Du siehst diesen Channel, kannst ihm aber nicht beitreten");
    expect(within(stage).getByText("Bühne")).toHaveClass("text-fg-2");
    // The lock glyph is never reused for access.
    for (const mark of container.querySelectorAll("[data-access]")) expect(mark.getAttribute("aria-label")).not.toMatch(/verschlüsselt/i);
  });

  it("the owner (all rights) sees only the private marks", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: marked(true, []) }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    await screen.findByText("Bühne");
    expect(screen.queryAllByTestId("channel-restricted")).toHaveLength(0);
    expect(within(row(container, "staff")).getByTestId("channel-private")).toBeInTheDocument();
    expect(within(row(container, "stage")).getByTestId("channel-private")).toHaveAccessibleName("Beitreten nur für bestimmte Rollen");
    expect(within(row(container, "news")).queryByTestId("channel-private")).toBeNull();
    expect(within(row(container, "stage")).getByRole("link")).toHaveAccessibleName("Sprachkanal Bühne, Beitreten nur für bestimmte Rollen");
  });
});

describe("row metrics (tavrn-web#185)", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  const kinds = (): RoomDetail => ({
    ...room(perms(Permission.MANAGE_CHANNELS)),
    categories: [{ id: "cat", room_id: "r1", name: "Gilde", position: 0, no_bots: false }],
    channels: [
      { ...channel("w", "system", "welcome", -1), system_name: "welcome" },
      { ...channel("t", "text", "allgemein", 0), category_id: "cat" },
      { ...channel("a", "announcement", "news", 1), category_id: "cat" },
      { ...channel("f", "forum", "fragen", 2), category_id: "cat" },
      { ...channel("d", "files", "dateien", 3), category_id: "cat" },
      { ...channel("v", "voice", "Sprache", 4), category_id: "cat" },
    ],
  });

  it("every row kind shows its kind as an SVG icon of the one shared sidebar size, no emoji glyphs", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: kinds() }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    await screen.findAllByTestId("channel-row");
    const nav = container.querySelector("nav")!;
    const icons = [...nav.querySelectorAll("[data-testid='channel-kind-icon']")];
    expect(icons.map((i) => i.getAttribute("data-icon"))).toEqual(["system", "text", "announcement", "forum", "files", "voice", "create"]);
    for (const icon of icons) {
      expect(icon.tagName.toLowerCase()).toBe("svg");
      expect(icon).toHaveClass("sidebar-icon");
    }
    expect(nav.textContent ?? "").not.toMatch(/[\u{1F44B}\u{1F4E3}\u{1F5C2}\u{1F4C1}\u{1F50A}#]/u);
  });

  it("rows have 16 px medium text, 34 px desktop height and 44 px touch targets; categories 12 px uppercase", async () => {
    mockFetch({ "/rooms/r1/reports": { body: { open: 0, reports: [] } }, "/rooms/r1": { body: kinds() }, "/node": { body: { capabilities: [] } } });
    const { container } = renderSidebar();
    await screen.findAllByTestId("channel-row");
    const links = [...container.querySelectorAll("nav a"), screen.getByRole("button", { name: "Channel erstellen" })];
    expect(links).toHaveLength(7);
    for (const link of links) expect(link).toHaveClass("text-base", "leading-5", "font-medium", "min-h-[34px]", "pointer-coarse:min-h-11", "gap-2", "px-2");
    expect(screen.getByText("Gilde")).toHaveClass("text-xs", "font-semibold", "uppercase", "tracking-wide");
    expect(screen.getByTestId("room-name")).toHaveClass("text-base", "font-semibold");
  });
});
