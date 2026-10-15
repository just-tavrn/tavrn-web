// SPDX-License-Identifier: Apache-2.0
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "../stores/auth";
import { useTyping } from "../stores/typing";
import { mockFetch, renderWithProviders } from "../test/render";
import { ConversationView } from "./ConversationView";

const renders = vi.hoisted(() => ({ list: 0 }));
vi.mock("./MessageList", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./MessageList")>()),
  MessageList: () => {
    renders.list++;
    return null;
  },
}));

vi.mock("../hooks/useE2eeConversation", () => ({
  useE2eeConversation: () => ({ phase: "plain", mls: null, waiting: [], ghosts: [], error: null, rejoined: false, tick: 0 }),
  useDecrypted: () => ({}),
  usePlainSignatures: () => ({}),
}));

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

describe("ConversationView: typing indicator", () => {
  it("shows who types without rendering the conversation again", async () => {
    useAuth.setState({ token: "t", user: me });
    useTyping.setState({ byChannel: {} });
    mockFetch({ "/conversations/c1/messages": { body: [] }, "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } }, "/node": { body: { gif_provider: null, dm_policy: "friends" } } });
    renderWithProviders(<ConversationView conversationId="c1" encrypted={false} header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach={false} canReact canPin={false} members={null} mayManage={false} domain="t.local" />);
    await screen.findByLabelText("Nachricht");
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const before = renders.list;
    act(() => useTyping.getState().mark("c1", "u2"));
    expect(screen.getByTestId("typing-indicator")).toHaveTextContent("Jemand schreibt…");
    act(() => useTyping.getState().mark("c1", "u3"));
    expect(screen.getByTestId("typing-indicator")).toHaveTextContent("2 Personen schreiben…");
    // The user's own typing and other conversations do not count; the periodic cleanup changes nothing here.
    act(() => useTyping.getState().mark("c1", "u1"));
    act(() => useTyping.getState().mark("c2", "u4"));
    act(() => useTyping.getState().prune());
    expect(screen.getByTestId("typing-indicator")).toHaveTextContent("2 Personen schreiben…");
    expect(renders.list).toBe(before);
  });
});
