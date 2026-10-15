// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Conversation, Message, RoomDetail } from "@tavrn/sdk";
import { loadRoomDetails, locate, notifyMessage, plainPreview, resetRoomLookups } from "./notify";
import { mockFetch } from "../test/render";
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

  it("a plaintext poll reads as its question", () => {
    expect(plainPreview(message({ content: { type: "poll", kind: "choice", question: "Wohin\ngehen wir?" } }))).toBe("📊 Wohin gehen wir?");
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

describe("loadRoomDetails (rooms not opened yet)", () => {
  const rooms = Array.from({ length: 60 }, (_, i) => ({ id: `R${String(i).padStart(2, "0")}`, name: `Room ${i}` }));
  function setupFetch() {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = mockFetch({
      "/rooms/": (_init, url) => {
        const id = url.split("/rooms/")[1]!.split(/[/?]/)[0]!;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        queueMicrotask(() => inFlight--);
        return { body: { id, name: id, channels: [{ id: `C-${id}`, name: "general", kind: "text" }], read_states: [], roles: [], categories: [], overrides: [], my_roles: [] } };
      },
      "/rooms": { body: rooms },
    });
    return { calls, gets: () => calls.filter((c) => /\/rooms\/R\d+/.test(c.url)).length, lists: () => calls.filter((c) => /\/rooms(\?|$)/.test(c.url)).length, maxInFlight: () => maxInFlight };
  }
  beforeEach(() => resetRoomLookups());

  it("finds the room of a channel beyond the first 50, once, and stops there", async () => {
    const f = setupFetch();
    const qc = new QueryClient();
    await loadRoomDetails(qc, null, "C-R55");
    expect(locate(qc, "C-R55").room?.id).toBe("R55");
    expect(f.lists()).toBe(1);
    // Four at a time until found: R00..R55 plus at most the three in flight.
    expect(f.gets()).toBeGreaterThanOrEqual(56);
    expect(f.gets()).toBeLessThanOrEqual(59);
    const before = f.calls.length;
    // The next message of that channel needs no request at all.
    await loadRoomDetails(qc, null, "C-R55");
    expect(f.calls.length).toBe(before);
  });

  it("a conversation in no room is not looked up again for a minute; lookups of one node queue", async () => {
    const f = setupFetch();
    const qc = new QueryClient();
    await Promise.all([loadRoomDetails(qc, null, "DM-1"), loadRoomDetails(qc, null, "DM-1"), loadRoomDetails(qc, null, "DM-1")]);
    expect(f.gets()).toBe(60);
    expect(f.lists()).toBe(1);
    await loadRoomDetails(qc, null, "DM-1");
    expect(f.gets()).toBe(60);
  });
});
