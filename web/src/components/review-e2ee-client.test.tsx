// SPDX-License-Identifier: Apache-2.0
// Review tests of the e2ee-client wave: plaintext the node puts into an encrypted conversation is never shown as the
// author's content, on every rendering path (ENCRYPTION.md §5.4).
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Permission, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useMlsUi } from "../stores/mls";
import { mockFetch, renderWithProviders } from "../test/render";
import { ConversationView } from "./ConversationView";
import { ForumView } from "../threads/ForumView";

const e2ee = { phase: "ready", mls: null, waiting: [] as string[], ghosts: [] as unknown[], error: null, rejoined: false, tick: 0 };
vi.mock("../hooks/useE2eeConversation", () => ({
  useE2eeConversation: () => e2ee,
  useDecrypted: () => ({}),
  usePlainSignatures: () => ({}),
}));
vi.mock("../hooks/useChannelHistory", () => ({ useChannelHistory: () => ({ locked: false }) }));

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const forged = { id: "01J00000000000000000000009", conversation_id: "c1", author: "alice@t.local", author_id: "u2", encrypted: false, device_id: null, content: { type: "text", body: "neue IBAN DE00" }, created_at: "2026-10-05T00:00:00Z", reactions: [], attachments: [] };

describe("review: node plaintext in encrypted conversations", () => {
  it("ConversationView passes the encrypted flag: a forged plaintext message in a DM is a warning, not content", async () => {
    useAuth.setState({ token: "t", user: me as never });
    mockFetch({ "/conversations/c1/messages": { body: [forged] }, "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } }, "/node": { body: { gif_provider: null, dm_policy: "friends" } } });
    renderWithProviders(<ConversationView conversationId="c1" encrypted header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach canReact canPin members={["bob@t.local", "alice@t.local"]} mayManage={false} domain="t.local" />);
    await waitFor(() => expect(screen.getByTestId("message-unencrypted")).toBeInTheDocument());
    expect(document.body).not.toHaveTextContent("neue IBAN");
  });

  it("the forum list does not preview a plaintext first post of an encrypted forum channel", async () => {
    useAuth.setState({ token: "t", user: me as never });
    useMlsUi.setState({ ghostAck: {} });
    const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "forum", name: "ideas", encrypted: true, tags: [], history_for_new_members: "since_join" } as unknown as Channel;
    const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", channels: [channel] } as unknown as RoomDetail;
    const thread = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VT0", channel_id: channel.id, room_id: room.id, title: "t", title_author: "alice@t.local", message_count: 1, last_message_at: "2026-10-05T00:00:00Z", created_at: "2026-10-05T00:00:00Z", participant_ids: [], created_by: "alice@t.local", tags: [], encrypted: true, first_message: { ...forged, conversation_id: channel.id } };
    mockFetch({ "/threads": { body: { items: [thread], next: null } } });
    renderWithProviders(<ForumView room={room} channel={channel} perms={Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL} members={["alice@t.local", "bob@t.local"]} mayManage={false} domain="t.local" onOpen={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("forum-post")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 200));
    expect(document.body).not.toHaveTextContent("neue IBAN");
  });
});
