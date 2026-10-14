// SPDX-License-Identifier: Apache-2.0
// The settings navigation: node admins of the home node get the node administration at its top.
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { UserSettingsPage } from "./UserSettingsPage";
import { renderWithProviders } from "../test/render";
import { useAuth } from "../stores/auth";

const user = (isAdmin: boolean) => ({ id: "u1", username: "root", domain: "t.local", address: "root@t.local", display_name: "Root", kind: "user", is_node_admin: isAdmin, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true });

function renderSettings() {
  return renderWithProviders(
    <Routes>
      <Route path="/settings/:tab" element={<UserSettingsPage />} />
    </Routes>,
    { route: "/settings/language" },
  );
}

describe("settings navigation", () => {
  beforeEach(() => useAuth.setState({ token: null, user: user(false), home: null }));

  it("node admins find the node administration first", () => {
    useAuth.setState({ user: user(true) });
    renderSettings();
    const nav = screen.getByRole("navigation", { name: "Einstellungsbereiche" });
    const link = within(nav).getByRole("link", { name: /Knotenverwaltung/ });
    expect(link).toHaveAttribute("href", "/admin");
    expect(within(nav).getAllByRole("link")[0]).toBe(link);
  });

  it("other users and accounts of another node do not see it", () => {
    renderSettings();
    expect(screen.queryByRole("link", { name: /Knotenverwaltung/ })).toBeNull();
    useAuth.setState({ user: user(true), home: { domain: "other.example", base: "https://other.example", ws: "wss://other.example/ws" } });
    expect(screen.queryByRole("link", { name: /Knotenverwaltung/ })).toBeNull();
  });

  it("the tab content is the scroll container and the containing block of its positioned descendants (tavrn-web#116)", () => {
    // `sr-only` legends and other absolutely positioned helpers inside a tab are placed relative to the nearest
    // positioned ancestor; a static scroll container let them escape to the app shell, which then grew and scrolled.
    renderSettings();
    const content = screen.getByRole("navigation", { name: "Einstellungsbereiche" }).parentElement!.querySelector('[tabindex="0"]')!;
    expect(content.className).toMatch(/\brelative\b/);
    expect(content.className).toMatch(/\boverflow-y-auto\b/);
    expect(content.className).toMatch(/\bmin-h-0\b/);
  });
});
