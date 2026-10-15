// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";
import { MessageList } from "./MessageList";

const base: Message = { id: "m1", conversation_id: "c1", author: "alice@t.local", author_id: "u1", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: "alt" }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };

describe("MessageList: a failed edit", () => {
  it("keeps the editor open with the new text (the conversation reported the error)", async () => {
    const onEdit = vi.fn(async () => {
      throw new Error("refused");
    });
    render(<MessageList messages={[base]} currentUserId="u1" canManage hasMore={false} actions={{ onEdit }} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Nachricht bearbeiten" }));
    const box = screen.getByLabelText("Neuer Text");
    await u.clear(box);
    await u.type(box, "neu{Enter}");
    expect(onEdit).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId("message-editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Neuer Text")).toHaveValue("neu");
  });
});
