// SPDX-License-Identifier: Apache-2.0
// The member list moves a member between its sections as presence arrives (Offline → Online). A profile card opened
// from a row must stay open across that move: the row is a new element in another section (web #171).
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemberList } from "./MemberList";
import { useAuth } from "../stores/auth";
import { usePresence } from "../stores/presence";
import { mockFetch, renderWithProviders } from "../test/render";

const user = (id: string, username: string) => ({ id, username, domain: "t.local", address: `${username}@t.local`, display_name: username, kind: "user", avatar_blob_id: null });
const member = (u: ReturnType<typeof user>) => ({ user: u, nickname: null, roles: [], joined_at: "2026-01-01T00:00:00Z", timeout_until: null });
const alice = user("01J9ZK3G5M8Q2W4E6R8T0Y2VA1", "alice");
const bob = user("01J9ZK3G5M8Q2W4E6R8T0Y2VB1", "bob");

describe("member list", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", user: { ...alice, email: null } as never, home: null });
    usePresence.getState().clear();
    mockFetch({
      "/members": { body: [member(alice), member(bob)] },
      "/rooms/R1": { body: { id: "R1", name: "Treffpunkt", roles: [], channels: [], my_roles: [], my_permissions: "0", is_owner: false, read_states: [] } },
      "/profile": { body: { id: bob.id, address: bob.address, username: "bob", domain: "t.local", display_name: "bob", kind: "user", is_node_admin: false, bio: "", links: [], profile_version: 1, created_at: "2026-01-01T00:00:00Z" } },
    });
  });

  it("keeps a profile card open while its member moves to another section", async () => {
    renderWithProviders(<MemberList roomId="R1" />);
    const offline = await screen.findByText((_, el) => el?.getAttribute("data-section") === "offline");
    expect(offline).toHaveTextContent("bob");
    await userEvent.setup().click(screen.getByRole("button", { name: "Profil von bob anzeigen" }));
    expect(await screen.findByTestId("profile-popover")).toBeInTheDocument();
    // Bob's presence arrives: his row now belongs to the online section.
    act(() => usePresence.getState().apply({ user: bob.address, status: "online" } as never));
    await waitFor(() => expect(document.querySelector('[data-section="offline"]')).toBeNull());
    expect(screen.getByTestId("profile-popover")).toBeInTheDocument();
  });
});
