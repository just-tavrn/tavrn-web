// SPDX-License-Identifier: Apache-2.0
// Opening the profile card from a message: the avatar or the author's name, found by their own attributes (a styling
// change of the header must not break it).
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { MessageList } from "./MessageList";
import { AuthorProfiles } from "./AuthorProfiles";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";

const message: Message = { id: "m1", conversation_id: "c1", author: "alice@t.local", author_id: "u1", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: "Hallo" }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };
const profile = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, created_at: "", avatar: null, avatar_still: null, links: [], bio: "", profile_version: 1 };

describe("AuthorProfiles", () => {
  it("a click on the author's name opens the card; the message text does not", async () => {
    useAuth.setState({ token: "t", user: { id: "u9", username: "me", domain: "t.local", address: "me@t.local", display_name: "Me", kind: "user", is_node_admin: false, created_at: "", email: null, email_verified: false, has_identity_key: true } });
    mockFetch({ "/users/alice%40t.local/profile": { body: profile } });
    renderWithProviders(
      <AuthorProfiles messages={[message]}>
        <MessageList messages={[message]} currentUserId="u9" canManage={false} hasMore={false} />
      </AuthorProfiles>,
    );
    const u = userEvent.setup();
    await u.click(await screen.findByText("Hallo"));
    expect(screen.queryByTestId("profile-popover")).toBeNull();
    const name = screen.getByTestId("message-author");
    expect(name).toHaveAttribute("data-author-name");
    await u.click(name);
    expect(await screen.findByTestId("profile-popover")).toBeInTheDocument();
  });

  it("finds the name by its attribute, whatever classes the header uses", async () => {
    mockFetch({ "/users/alice%40t.local/profile": { body: profile } });
    renderWithProviders(
      <AuthorProfiles messages={[message]}>
        <div data-message-id="m1">
          <div className="grid">
            <span className="font-bold" data-author-name>
              Alice
            </span>
            <span className="font-semibold">not the name</span>
          </div>
        </div>
      </AuthorProfiles>,
    );
    const u = userEvent.setup();
    await u.click(screen.getByText("not the name"));
    expect(screen.queryByTestId("profile-popover")).toBeNull();
    await u.click(screen.getByText("Alice"));
    expect(await screen.findByTestId("profile-popover")).toBeInTheDocument();
  });
});
