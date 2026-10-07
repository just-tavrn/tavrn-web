// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { FriendsPage } from "./FriendsPage";

const user = (id: string, username: string, kind = "user") => ({ id, username, domain: "t.local", address: `${username}@t.local`, display_name: username.toUpperCase(), kind, is_node_admin: false, avatar_blob_id: null, created_at: "" });

describe("FriendsPage", () => {
  it("lists friends, requests with their messages and blocks with notes, and calls the routes", async () => {
    useAuth.setState({ token: "t", user: { ...user("u0", "me"), email: null, email_verified: false, has_identity_key: true } });
    const calls = mockFetch({
      "/users/me/friends/requests/r1/accept": { body: { user: user("u1", "anna"), since: "" } },
      "/users/me/friends/requests": { status: 201, body: { status: "pending", user: user("u9", "zoe"), request_id: "r9" } },
      "/users/me/blocks": (init) => (init.method === "POST" ? { status: 204, body: null } : { body: [{ user: user("u4", "eve"), reason: "Spam", created_at: "2026-10-01T00:00:00Z" }] }),
      "/users/me/friends": {
        body: {
          friends: [{ user: user("u2", "botty", "bot"), since: "" }],
          incoming: [{ id: "r1", direction: "incoming", user: user("u1", "anna"), created_at: "", message: "Anna aus der Gilde" }],
          outgoing: [{ id: "r2", direction: "outgoing", user: user("u3", "ben"), created_at: "", message: null }],
          blocked: [user("u4", "eve")],
        },
      },
    });
    renderWithProviders(<FriendsPage />);
    const incoming = await screen.findByTestId("friends-incoming");
    expect(incoming).toHaveTextContent("anna@t.local");
    expect(within(incoming).getByTestId("friend-request-message")).toHaveTextContent("Anna aus der Gilde");
    expect(screen.getByTestId("friends-outgoing")).toHaveTextContent("ben@t.local");
    const blocked = screen.getByTestId("friends-blocked");
    await waitFor(() => expect(blocked).toHaveTextContent("eve@t.local"));
    expect(within(blocked).getByTestId("blocked-reason")).toHaveTextContent("Spam");
    expect(within(screen.getByTestId("friends-list")).getByTestId("bot-badge")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(within(incoming).getByRole("button", { name: "Annehmen" }));
    expect(calls.some((c) => c.url.endsWith("/users/me/friends/requests/r1/accept") && c.init.method === "POST")).toBe(true);

    // A request with a message.
    await u.type(screen.getByLabelText("Benutzername oder Adresse"), "zoe");
    await u.type(screen.getByLabelText("Nachricht (optional)"), "Hallo Zoe");
    await u.click(screen.getByRole("button", { name: "Anfrage senden" }));
    const sent = calls.find((c) => c.url.endsWith("/users/me/friends/requests") && c.init.method === "POST");
    expect(JSON.parse(String(sent!.init.body))).toEqual({ user: "zoe", message: "Hallo Zoe" });

    // Blocking asks for a private note.
    await u.click(within(screen.getByTestId("friends-list")).getByRole("button", { name: "Blockieren" }));
    await u.type(screen.getByLabelText("Private Notiz (optional)"), "nervt");
    await u.click(screen.getByTestId("block-confirm"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/users/me/blocks") && c.init.method === "POST")).toBe(true));
    const block = calls.find((c) => c.url.endsWith("/users/me/blocks") && c.init.method === "POST");
    expect(JSON.parse(String(block!.init.body))).toEqual({ user: "botty@t.local", reason: "nervt" });
  });
});
