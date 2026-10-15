// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Member, Message } from "@tavrn/sdk";
import { MessageList } from "./MessageList";
import { AuthorProfiles } from "./AuthorProfiles";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";

const msg = (id: string, author: string, authorId: string): Message =>
  ({ id, conversation_id: "c1", author, author_id: authorId, device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: id }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false }) as Message;

const user = (n: number, avatar: string | null) => ({ id: `u${n}`, username: `user${n}`, domain: "t.local", address: `user${n}@t.local`, display_name: `User ${n}`, kind: "user", is_node_admin: false, created_at: "", avatar, avatar_still: avatar });

describe("AuthorProfiles: avatars of room members", () => {
  it("takes members' avatars from the member list and asks the node only for other authors", async () => {
    useAuth.setState({ token: "t", user: { id: "u99", username: "me", domain: "t.local", address: "me@t.local", display_name: "Me", kind: "user", is_node_admin: false, created_at: "", email: null, email_verified: false, has_identity_key: true } });
    const members = Array.from({ length: 20 }, (_, i) => ({ joined_at: "", roles: [], room_avatar_animated: false, user: user(i, i === 0 ? "/api/v1/media/M0" : null) }) as unknown as Member);
    const departed = { ...user(50, "/api/v1/media/D"), links: [], bio: "", profile_version: 1 };
    const calls = mockFetch({ "/users/user50%40t.local/profile": { body: departed } });
    const messages = [...members.map((m, i) => msg(`m${String(i).padStart(2, "0")}`, m.user.address, m.user.id)), msg("m99", "user50@t.local", "u50")];
    renderWithProviders(
      <AuthorProfiles messages={messages} members={members}>
        <MessageList messages={messages} currentUserId="u99" canManage={false} hasMore={false} />
      </AuthorProfiles>,
    );
    const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
    await waitFor(() => expect(within(rowOf("m99")).getByTestId("avatar-image")).toHaveAttribute("src", expect.stringMatching(/\/api\/v1\/media\/D$/)));
    expect(within(rowOf("m00")).getByTestId("avatar-image")).toHaveAttribute("src", expect.stringMatching(/\/api\/v1\/media\/M0$/));
    const profileCalls = calls.filter((c) => c.url.includes("/profile"));
    expect(profileCalls.map((c) => c.url)).toEqual([expect.stringContaining("/users/user50%40t.local/profile")]);
    expect(screen.getAllByTestId("message-avatar").length).toBeGreaterThan(0);
  });
});
