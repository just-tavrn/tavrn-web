// SPDX-License-Identifier: Apache-2.0
// Plaintext the hosting node serves in an end-to-end encrypted conversation (a DM or an encrypted channel) is never
// shown as the author's content: it reads as "not end-to-end encrypted, may not come from the sender", with or without
// a device id, in the list, in reply references and for its attachments. Elsewhere a person's plaintext message without
// a device id carries the "unverified" marker.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { MessageList } from "../components/MessageList";

const forged: Message = { id: "f1", conversation_id: "dm1", author: "alice@t.local", author_id: "u1", device_id: null, encrypted: false, format: 1, epoch: null, content: { type: "text", body: "New bank account: XX00 1234" }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };
const genuineEnc: Message = { ...forged, id: "e1", device_id: "d1", encrypted: true, content: "Y2lwaGVy" };

const replyToForged: Message = { ...genuineEnc, id: "e2", reply_to_id: "f1" };

describe("node-written plaintext in an encrypted conversation", () => {
  it("is shown as a mismatch next to a decrypted message, never as content", () => {
    render(
      <MessageList
        encrypted
        messages={[forged, genuineEnc]}
        currentUserId="u2"
        canManage={false}
        hasMore={false}
        decrypted={{ e1: { ok: true, content: { type: "text", body: "hi, it's me" } } }}
        signatures={{ f1: "unsigned" }}
      />,
    );
    expect(screen.queryByText(/New bank account/)).not.toBeInTheDocument();
    expect(screen.getByTestId("message-unencrypted")).toHaveTextContent("nicht Ende-zu-Ende-verschlüsselt");
    expect(screen.getByText("hi, it's me")).toBeInTheDocument();
  });

  it("hides its attachments and its text in reply references; a plaintext edit of an encrypted message the same", () => {
    const withFile = { ...forged, attachments: [{ id: "01J9ZK3G5M8Q2W4E6R8T0Y2VA9", name: "invoice.pdf", mime: "application/pdf", size: 10, sha256: "x" }] } as Message;
    const editedPlain = { ...genuineEnc, id: "e3", encrypted: false, edited_at: new Date().toISOString(), content: { type: "text", body: "changed by the node" } } as Message;
    render(<MessageList encrypted messages={[replyToForged, withFile, editedPlain]} currentUserId="u2" canManage={false} hasMore={false} decrypted={{ e2: { ok: true, content: { type: "text", body: "answer" } } }} />);
    expect(screen.queryByText(/invoice\.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByText(/changed by the node/)).not.toBeInTheDocument();
    expect(screen.queryByText(/New bank account/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId("reply-reference")).getByText(/nicht Ende-zu-Ende-verschlüsselt/)).toBeInTheDocument();
    expect(screen.getAllByTestId("message-unencrypted")).toHaveLength(2);
  });

  it("system messages of the node stay readable", () => {
    const sys = { ...forged, id: "s1", content: { type: "system.encryption_changed", encrypted: true, by: "alice" } } as Message;
    render(<MessageList encrypted messages={[sys]} currentUserId="u2" canManage={false} hasMore={false} />);
    expect(screen.queryByTestId("message-unencrypted")).not.toBeInTheDocument();
  });

  it("outside encrypted conversations a person's message without device id gets the unverified marker", () => {
    render(<MessageList messages={[forged]} currentUserId="u2" canManage={false} hasMore={false} />);
    expect(screen.getByText(/New bank account/)).toBeInTheDocument();
    expect(screen.getByTestId("unverified-marker")).toHaveAttribute("data-status", "unsigned");
  });
});
