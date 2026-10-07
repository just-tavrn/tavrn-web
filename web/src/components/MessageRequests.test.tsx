// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PendingInvite } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { MessageRequestsPage } from "../pages/MessageRequestsPage";
import { mergeRequests } from "./MessageRequests";

const user = (username: string, domain = "t.local") => ({ id: `id-${username}`, username, domain, address: `${username}@${domain}`, display_name: username.toUpperCase(), kind: "user", is_node_admin: false, created_at: "" });
const local = { conversation: { id: "C1", kind: "dm", created_at: "2026-10-05T10:00:00Z", members: [], encrypted: true, pending: ["me@t.local"] }, from: user("alice"), shared_rooms: [{ id: "R1", name: "Gilde" }], first_message_id: "M1" };
const remote: PendingInvite = {
  id: "I1",
  kind: "conversation",
  node: "b.test",
  inviter: "bob@b.test",
  received_at: "2026-10-05T11:00:00Z",
  conversation: { id: "C2", kind: "dm", members: ["bob@b.test", "me@t.local"], requested: true, shared_rooms: [{ node: "b.test", id: "R9", name: "Treffpunkt" }] } as PendingInvite["conversation"],
};

describe("message requests", () => {
  it("merges home requests with requests of other nodes from the invite list, newest first", () => {
    const friendInvite: PendingInvite = { ...remote, id: "I2", conversation: { id: "C3", kind: "dm" } };
    const list = mergeRequests([local], [remote, friendInvite, { ...remote, id: "I3", kind: "room", room: { id: "R" } }]);
    expect(list.map((r) => [r.node, r.conversationId, r.from])).toEqual([
      ["b.test", "C2", "bob@b.test"],
      [null, "C1", "alice@t.local"],
    ]);
    expect(list[0]!.sharedRooms).toEqual(["Treffpunkt"]);
    expect(list[0]!.inviteId).toBe("I1");
    expect(mergeRequests([], null)).toEqual([]);
  });

  it("lists requests with sender, shared rooms and the actions", async () => {
    useAuth.setState({ token: "t", user: { ...user("me"), email: null, email_verified: false, has_identity_key: true } });
    const calls = mockFetch({
      "/conversations/C1/decline": { status: 204, body: null },
      "/conversations/requests": { body: [local] },
      "/users/me/invites": { body: { items: [remote] } },
    });
    renderWithProviders(<MessageRequestsPage />);
    const items = await screen.findAllByTestId("request");
    expect(items).toHaveLength(2);
    const alice = items.find((i) => i.getAttribute("data-from") === "alice@t.local")!;
    expect(within(alice).getByTestId("request-shared")).toHaveTextContent("Gilde");
    expect(within(items.find((i) => i.getAttribute("data-from") === "bob@b.test")!).getByTestId("request-from")).toHaveTextContent("über b.test");
    const u = userEvent.setup();
    await u.click(within(alice).getByTestId("request-block"));
    await u.type(screen.getByLabelText("Private Notiz (optional)"), "Spam");
    await u.click(screen.getByTestId("block-confirm"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/conversations/C1/decline"))).toBe(true));
    const decline = calls.find((c) => c.url.endsWith("/conversations/C1/decline"))!;
    expect(JSON.parse(String(decline.init.body))).toEqual({ block: true, reason: "Spam" });
  });
});
