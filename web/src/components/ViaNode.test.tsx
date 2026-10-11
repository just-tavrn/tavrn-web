// SPDX-License-Identifier: Apache-2.0
// Invitations and call rings that name a person through a node that is not that person's home node carry `via`
// (FEDERATION.md §5.2): the client shows "via <node>" with the explanation; without `via` nothing changes.
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { PendingInvite } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch } from "../test/render";
import { onRingEvent } from "../voice/calls/actions";
import { useCalls } from "../voice/calls/state";
import { InviteList } from "./InviteList";
import { mergeRequests } from "./MessageRequests";
import { viaOf } from "./ViaNode";

const me = { id: "u0", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const roomInvite = (extra: Record<string, unknown>) => ({ id: "I1", kind: "room", node: "far.test", inviter: "mallory@third.test", room: { id: "R1", name: "Halle" }, conversation: null, received_at: "", expires_at: null, ...extra }) as unknown as PendingInvite;

describe("via: inviters and callers a node named without their home node", () => {
  it("accepts only a node domain", () => {
    expect(viaOf({ via: "Far.Test" })).toBe("far.test");
    for (const bad of [{}, { via: "" }, { via: "<b>x</b>" }, { via: 7 }, null]) expect(viaOf(bad)).toBeNull();
  });

  it("the invite list shows 'via <node>' with the explanation, and nothing without it", async () => {
    useAuth.setState({ token: "t", user: me as never });
    mockFetch({ "/users/me/invites": { body: { items: [roomInvite({ via: "far.test" }), roomInvite({ id: "I2", inviter: "alice@far.test" })] } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InviteList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("invite")).toHaveLength(2));
    const [named, plain] = screen.getAllByTestId("invite");
    const via = within(named!).getByTestId("via-node");
    expect(via).toHaveTextContent("über far.test");
    expect(via).toHaveAttribute("title", expect.stringContaining("Heimatknoten hat das aber nicht bestätigt"));
    expect(within(plain!).queryByTestId("via-node")).toBeNull();
  });

  it("message requests and rings keep it", () => {
    const conversation = { id: "C1", kind: "dm", requested: true, shared_rooms: [] };
    const [item] = mergeRequests([], [{ ...roomInvite({ via: "far.test" }), kind: "conversation", room: null, conversation } as unknown as PendingInvite]);
    expect(item?.via).toBe("far.test");
    const [none] = mergeRequests([], [{ ...roomInvite({}), kind: "conversation", room: null, conversation } as unknown as PendingInvite]);
    expect(none?.via).toBeUndefined();
    onRingEvent("far.test", { conversation_id: "C9", from: "mallory@third.test", started_at: new Date().toISOString(), via: "far.test" });
    expect(Object.values(useCalls.getState().ringing).find((r) => r.conversationId === "C9")?.via).toBe("far.test");
  });
});
