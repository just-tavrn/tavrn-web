// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { PendingInvite } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useToasts } from "../stores/toasts";
import { mockFetch } from "../test/render";
import { onInvite } from "../hooks/useRealtime";
import { InviteList } from "./InviteList";

describe("InviteList", () => {
  it("shows a direct room invite live on `room.invite`, with accept and decline", async () => {
    useAuth.setState({ token: "t", user: { id: "u0", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } });
    useToasts.setState({ toasts: [] });
    const invite = { id: "I1", kind: "room", node: "t.local", inviter: "alice@t.local", code: "c1", room: { id: "R1", name: "Gildenhalle" }, conversation: null, created_at: "", expires_at: null } as unknown as PendingInvite;
    let items: PendingInvite[] = [];
    mockFetch({ "/users/me/invites": () => ({ body: { items } }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InviteList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.getQueryState(["pending-invites"])?.status).toBe("success"));
    expect(screen.queryByTestId("invite-list")).toBeNull();

    // The event: the list is refetched without a reload, and a toast names the room and the inviter.
    items = [invite];
    await act(() => onInvite(invite, client));
    const row = await screen.findByTestId("invite");
    expect(row).toHaveTextContent("Gildenhalle");
    expect(row).toHaveTextContent("alice@t.local");
    expect(within(row).getByRole("button", { name: "Annehmen" })).toBeEnabled();
    expect(within(row).getByRole("button", { name: "Verwerfen" })).toBeEnabled();
    expect(useToasts.getState().toasts.map((x) => x.title).join(" ")).toContain("Gildenhalle");
  });
});
