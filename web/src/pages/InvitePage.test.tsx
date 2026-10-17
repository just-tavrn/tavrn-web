// SPDX-License-Identifier: Apache-2.0
// The invite page before and after signing in: a signed-out visitor sees the invite's preview (room, rules read-only,
// the room's documents) with "Sign in to join" and, where the node takes new accounts, "Create an account"; both
// come back to the invite, which then shows the join block with the rules checkbox and never joins by itself.
import { describe, expect, it, beforeEach } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import type { UserPrivate } from "@tavrn/sdk";
import { mockFetch, renderWithProviders } from "../test/render";
import { useAuth } from "../stores/auth";
import { InvitePage } from "./InvitePage";
import { afterSignIn } from "./ConnectPages";

const ROOM = "01J0000000000000000000000R";
const room = { id: ROOM, name: "Lounge", description: "A quiet place for tea.", icon_animated: false, member_count: 3, age_gate: "none" };
const preview = { code: "code1", room, rules: "Be **kind**.", privacy_notice: "# Privacy\n\nWe keep messages.", privacy_notice_updated_at: "2026-10-01T10:00:00Z", legal_notice: "Run by Alice", legal_notice_updated_at: "2026-10-02T10:00:00Z" };
const detail = { ...room, channels: [], categories: [], roles: [], overrides: [], my_roles: [], my_permissions: "0", is_owner: false, read_states: [] };
const wellKnown = { domain: "t.local", api: "/api/v1", protocol: 1 };

function signedOut() {
  useAuth.setState({ token: null, refresh: null, user: null, home: null } as never);
}

function signIn() {
  useAuth.setState({ token: "t", user: { id: "u0", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } as UserPrivate, home: null });
}

/** The node's public routes; `registration` as in `GET /node`. */
function node({ registration = "open", invite = { body: preview } as { status?: number; body: unknown } } = {}) {
  const joins: string[] = [];
  const calls = mockFetch({
    "/invites/code1/join": (_init, url) => {
      joins.push(url);
      return { body: detail };
    },
    "/invites/code1": invite,
    "/.well-known/tavrn": { body: wellKnown },
    "/api/v1/node": { body: { name: "Test node", domain: "t.local", registration, sso: null } },
    "/users/me": { body: { id: "u0", username: "bob", domain: "t.local", age_status: "adult" } },
  });
  return { calls, joins };
}

/** The invite page plus a stand-in sign-in page that shows where it was sent to. */
function LoginProbe() {
  const location = useLocation();
  return <p data-testid="login-probe">{location.pathname + location.search}</p>;
}

function renderInvite(route = "/invite/code1") {
  return renderWithProviders(
    <Routes>
      <Route path="/invite/:code" element={<InvitePage />} />
      <Route path="/login" element={<LoginProbe />} />
    </Routes>,
    { route },
  );
}

function authorization(init: RequestInit): string | null {
  return new Headers(init.headers).get("Authorization");
}

beforeEach(() => {
  signedOut();
});

describe("the invite page signed out", () => {
  it("shows the room, its rules read-only and documents, and both actions; no request carries credentials", async () => {
    const user = userEvent.setup();
    const { calls, joins } = node();
    renderInvite();
    expect(await screen.findByTestId("invite-room-name")).toHaveTextContent("Lounge");
    expect(screen.getByText("A quiet place for tea.")).toBeInTheDocument();
    expect(screen.getByText(/3 Mitglieder/)).toBeInTheDocument();
    expect(await screen.findByText(/auf t\.local/)).toBeInTheDocument();
    // The rules, read-only: no checkbox and no join button before signing in.
    const rules = screen.getByRole("region", { name: "Regeln" });
    expect(within(rules).getByText("kind")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Beitreten" })).toBeNull();
    // The documents as in the join dialog.
    await user.click(screen.getByRole("button", { name: /Datenschutzhinweise/ }));
    expect(screen.getByRole("region", { name: "Datenschutzhinweise" })).toHaveTextContent("We keep messages.");
    expect(screen.getByRole("button", { name: /Impressum/ })).toBeInTheDocument();
    // Both actions come back to the invite (same-origin path only).
    expect(screen.getByRole("link", { name: "Zum Beitreten anmelden" })).toHaveAttribute("href", "/login?next=%2Finvite%2Fcode1");
    expect(await screen.findByRole("link", { name: "Konto erstellen" })).toHaveAttribute("href", "/login?mode=register&next=%2Finvite%2Fcode1");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(authorization(c.init), c.url).toBeNull();
    expect(calls.some((c) => c.url.includes("/users/me"))).toBe(false);
    expect(joins).toEqual([]);
  });

  it("offers only the sign-in when the node takes no new accounts", async () => {
    node({ registration: "closed" });
    renderInvite();
    expect(await screen.findByRole("link", { name: "Zum Beitreten anmelden" })).toBeInTheDocument();
    // The node's answer is in: still no registration.
    await screen.findByText(/auf t\.local/);
    await act(async () => {});
    expect(screen.queryByRole("link", { name: "Konto erstellen" })).toBeNull();
  });

  it("names the account invite a node in invite mode asks for", async () => {
    node({ registration: "invite" });
    renderInvite();
    expect(await screen.findByRole("link", { name: "Konto erstellen" })).toBeInTheDocument();
    expect(screen.getByText("Dieser Knoten verlangt einen Einladungscode für neue Konten.")).toBeInTheDocument();
  });

  it("explains an invalid or expired invite and still offers the sign-in", async () => {
    node({ invite: { status: 404, body: { code: "invite.invalid", status: 404, title: "Not found", detail: "Invite not found", type: "about:blank" } } });
    renderInvite();
    expect(await screen.findByText("Diese Einladung ist ungültig oder abgelaufen")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-room-name")).toBeNull();
    expect(screen.getByRole("link", { name: "Zur Anmeldung" })).toHaveAttribute("href", "/login");
  });

  it("explains a rate limit", async () => {
    node({ invite: { status: 429, body: { code: "rate_limited", status: 429, title: "Too many requests", detail: "", type: "about:blank" } } });
    renderInvite();
    expect(await screen.findByText(/Zu viele Anfragen/)).toBeInTheDocument();
  });

  it("an invite of another node keeps the sign-in first (nothing is fetched from that node)", async () => {
    const { calls } = node();
    renderInvite("/invite/code1?node=b.test");
    expect(await screen.findByTestId("login-probe")).toHaveTextContent("/login?next=%2Finvite%2Fcode1%3Fnode%3Db.test");
    expect(calls.some((c) => c.url.includes("b.test"))).toBe(false);
  });

  it("after signing in the invite shows the join block with the checkbox and never joins by itself", async () => {
    const user = userEvent.setup();
    const { joins } = node();
    renderInvite();
    const signin = await screen.findByRole("link", { name: "Zum Beitreten anmelden" });
    const next = new URL(signin.getAttribute("href")!, "http://localhost").searchParams.get("next")!;
    expect(next).toBe("/invite/code1");
    // The sign-in leads through the encryption step to `next`.
    expect(afterSignIn(next)).toBe("/encryption?next=%2Finvite%2Fcode1");
    await user.click(signin);
    expect(await screen.findByTestId("login-probe")).toHaveTextContent("/login?next=%2Finvite%2Fcode1");

    signIn();
    renderInvite(next);
    const block = await screen.findByTestId("join-block");
    expect(within(block).getByRole("region", { name: "Regeln" })).toBeInTheDocument();
    const join = screen.getByRole("button", { name: "Beitreten" });
    expect(join).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Zum Beitreten anmelden" })).toBeNull();
    await act(async () => {});
    expect(joins).toEqual([]);
    await user.click(within(block).getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    expect(join).toBeEnabled();
    expect(joins).toEqual([]);
  });
});
