// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Conversation, Message, RoomDetail } from "@tavrn/sdk";
import { notifyMessage, plainPreview } from "./notify";
import { DEFAULT_SETTINGS, useNotifications } from "../stores/notifications";
import { useToasts } from "../stores/toasts";
import { useMlsUi } from "../stores/mls";

const me = { id: "u1", address: "me@localhost" };
const message = (over: Partial<Message> = {}): Message =>
  ({ id: "m1", conversation_id: "ch1", author: "bob@localhost", author_id: "u2", device_id: null, encrypted: false, format: 1, content: { type: "text", body: "hello @me" }, mentions: ["me@localhost"], mentions_everyone: false, created_at: "", reactions: [], attachments: [], pinned: false, ...over }) as Message;

function client() {
  const qc = new QueryClient();
  qc.setQueryData<Partial<RoomDetail>>(["room", "r1"], { id: "r1", name: "Guild", channels: [{ id: "ch1", name: "general", kind: "text" } as RoomDetail["channels"][number], { id: "welcome", name: "welcome", kind: "system" } as RoomDetail["channels"][number]] });
  qc.setQueryData<Partial<Conversation>[]>(["conversations"], [{ id: "dm1", kind: "dm", members: [{ address: "bob@localhost", display_name: "Bob" } as Conversation["members"][number]] }]);
  return qc;
}

describe("plainPreview", () => {
  it("shows plaintext only, shortened", () => {
    expect(plainPreview(message())).toBe("hello @me");
    expect(plainPreview(message({ encrypted: true, content: "abc" }))).toBeNull();
    expect(plainPreview(message({ content: { type: "text", body: "x".repeat(300) } }))!.length).toBe(140);
  });
});

describe("notifyMessage", () => {
  beforeEach(() => {
    useNotifications.setState({ settings: { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, sound: false } }, entries: [] });
    useToasts.setState({ toasts: [] });
    useMlsUi.setState({ open: null });
  });

  it("a mention in a room channel: toast with the jump path and an entry in the center", async () => {
    await notifyMessage(message(), { queryClient: client(), node: null, me });
    const toast = useToasts.getState().toasts[0]!;
    expect(toast).toMatchObject({ title: "bob in #general · Guild", detail: "hello @me", path: "/rooms/r1/channels/ch1", testId: "notify-toast-mention" });
    expect(useNotifications.getState().entries[0]).toMatchObject({ kind: "mention", path: "/rooms/r1/channels/ch1" });
  });

  it("a DM notifies; encrypted content is never previewed", async () => {
    await notifyMessage(message({ conversation_id: "dm1", encrypted: true, content: "c2VjcmV0", mentions: [] }), { queryClient: client(), node: "other.example", me });
    expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Bob", path: "/n/other.example/conversations/dm1" });
    expect(useToasts.getState().toasts[0]!.detail).not.toContain("c2VjcmV0");
    expect(useNotifications.getState().entries[0]).toMatchObject({ kind: "dm" });
  });

  it("never previews plaintext the node put into a DM: it says the message was not end-to-end encrypted", async () => {
    await notifyMessage(message({ conversation_id: "dm1", content: { type: "text", body: "new bank account" }, mentions: [] }), { queryClient: client(), node: null, me });
    const toast = useToasts.getState().toasts[0]!;
    expect(toast.detail).not.toContain("bank");
    expect(toast.detail).toBe("Nachricht nicht Ende-zu-Ende-verschlüsselt");
    expect(plainPreview(message(), true)).toBeNull();
  });

  it("stays quiet for unmentioned room messages, the welcome channel and unknown conversations; loads rooms once", async () => {
    await notifyMessage(message({ mentions: [] }), { queryClient: client(), node: null, me });
    await notifyMessage(message({ conversation_id: "welcome" }), { queryClient: client(), node: null, me });
    const loadRooms = vi.fn(async () => undefined);
    await notifyMessage(message({ conversation_id: "nowhere" }), { queryClient: client(), node: null, me, loadRooms });
    expect(loadRooms).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
