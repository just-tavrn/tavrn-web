// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { useAuth } from "../../stores/auth";
import { useToasts } from "../../stores/toasts";
import { mockFetch } from "../../test/render";
import { sendRoomInvite } from "./inviteToRoom";

const problem = (status: number, code: string, detail: string) => ({ status, body: { type: "x", title: "Problem", status, code, detail } });

describe("sendRoomInvite", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", user: { id: "u0", username: "me", domain: "t.local", address: "me@t.local", display_name: "Me", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } });
    useToasts.setState({ toasts: [] });
  });

  it("posts the direct invite for the address and confirms with the name and the room", async () => {
    const calls = mockFetch({ "/rooms/R1/invites/direct": { status: 202, body: { invite: { code: "c" } } } });
    expect(await sendRoomInvite({ id: "R1", name: "Gilde", node: null }, "anna@t.local", "Anna")).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ user: "anna@t.local" });
    expect(useToasts.getState().toasts[0]).toMatchObject({ kind: "info", title: "Einladung in Gilde an Anna gesendet" });
  });

  it("speaks of the invitee when the node says banned, and shows the rate limit and unknown refusals in the node's words", async () => {
    mockFetch({ "/rooms/R1/invites/direct": problem(403, "room.banned", "This person is banned from the room") });
    expect(await sendRoomInvite({ id: "R1", name: "Gilde", node: null }, "anna@t.local", "Anna")).toBe(false);
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ kind: "error", title: "Einladung nicht gesendet", detail: "Diese Person ist aus dem Raum verbannt" });
    mockFetch({ "/rooms/R1/invites/direct": problem(429, "rate_limited", "Too many requests") });
    await sendRoomInvite({ id: "R1", name: "Gilde", node: null }, "anna@t.local", "Anna");
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ kind: "error", detail: "Zu viele Anfragen, bitte später erneut versuchen" });
    mockFetch({ "/rooms/R1/invites/direct": problem(403, "some.new_refusal", "Not possible here") });
    await sendRoomInvite({ id: "R1", name: "Gilde", node: null }, "anna@t.local", "Anna");
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ kind: "error", detail: "Not possible here" });
  });
});
