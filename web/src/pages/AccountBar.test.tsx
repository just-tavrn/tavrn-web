// SPDX-License-Identifier: Apache-2.0
// The account bar at the bottom of the sidebar: avatar menu, name, one bell, one gear; node administration in the menu.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountBar } from "./AccountBar";
import { renderWithProviders } from "../test/render";
import { useAuth } from "../stores/auth";

const user = (isAdmin: boolean) => ({ id: "u1", username: "babatonga", domain: "t.local", address: "babatonga@t.local", display_name: "babatonga der Lange", kind: "user", is_node_admin: isAdmin, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true });

function renderBar() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin" element={<p data-testid="admin-page">admin</p>} />
      <Route path="/settings" element={<p data-testid="settings-page">settings</p>} />
      <Route path="*" element={<AccountBar />} />
    </Routes>,
    { route: "/rooms/r" },
  );
}

/** Emoji pictographs (the old text icons ⚙ 🛠 🔔 are not allowed in the bar any more). */
const EMOJI = /[⚙\u{1F6E0}\u{1F514}]/u;

describe("account bar", () => {
  // No token: the presence sync and the idle detector stay off.
  beforeEach(() => useAuth.setState({ token: null, user: user(false), home: null }));

  it("shows the name with its full text, one bell and one gear as SVG icons, and no wrench button", () => {
    const { container } = renderBar();
    const name = screen.getByTestId("me-name");
    expect(name).toHaveTextContent("babatonga der Lange");
    expect(name).toHaveAttribute("title", "babatonga der Lange");
    const bar = screen.getByTestId("account-bar");
    expect(within(bar).getAllByTestId("notification-bell")).toHaveLength(1);
    // Phones show the bell in the header (AppShell headerExtra); the bar's own bell starts at the tablet width.
    expect(within(bar).getByTestId("notification-bell").className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(within(bar).getByTestId("notification-bell").className).toContain("md:inline-flex");
    const gear = within(bar).getByRole("button", { name: "Benutzereinstellungen" });
    expect(gear.querySelector("svg")).not.toBeNull();
    expect(within(bar).getByTestId("notification-bell").querySelector("svg")).not.toBeNull();
    expect(within(bar).queryByRole("button", { name: "Knotenverwaltung" })).toBeNull();
    expect(container.textContent ?? "").not.toMatch(EMOJI);
  });

  it("the gear opens the user settings", async () => {
    const u = userEvent.setup();
    renderBar();
    await u.click(screen.getByRole("button", { name: "Benutzereinstellungen" }));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("node admins find the node administration in the account menu", async () => {
    const u = userEvent.setup();
    useAuth.setState({ user: user(true) });
    renderBar();
    expect(screen.queryByRole("button", { name: "Knotenverwaltung" })).toBeNull();
    await u.click(screen.getByTestId("presence-menu-button"));
    const menu = screen.getByRole("menu", { name: "Status festlegen" });
    const entry = within(menu).getByRole("menuitem", { name: "Knotenverwaltung" });
    expect(entry).toHaveAttribute("data-testid", "presence-admin");
    await u.click(entry);
    expect(screen.getByTestId("admin-page")).toBeInTheDocument();
  });

  it("other users, and admins signed in from another node, do not get the entry", async () => {
    const u = userEvent.setup();
    renderBar();
    await u.click(screen.getByTestId("presence-menu-button"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Knotenverwaltung" })).toBeNull();
    await u.keyboard("{Escape}");
    useAuth.setState({ user: user(true), home: { domain: "other.example", base: "https://other.example", ws: "wss://other.example/ws" } });
    await u.click(screen.getByTestId("presence-menu-button"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Knotenverwaltung" })).toBeNull();
  });
});
