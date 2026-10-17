// SPDX-License-Identifier: Apache-2.0
// Security notices in a channel (APPLICATIONS.md §3.6): the node writes a bot's entry about a channel @everyone cannot
// view into that channel. It is shown, but never counts as unread and never notifies; ordinary messages still do.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, RoomDetail, TavrnSocket, UserPrivate } from "@tavrn/sdk";
import { roomHandlers } from "./useRealtime";
import { useAuth } from "../stores/auth";
import { useToasts } from "../stores/toasts";
import { DEFAULT_SETTINGS, useNotifications } from "../stores/notifications";
import { useMlsUi } from "../stores/mls";
import { useUnread } from "../stores/unread";
import { resetRoomLookups } from "../lib/notify";

const ROOM = "01ROOM00000000000000000000";
const CHAN = "01CHAN00000000000000000000";

const room = {
  id: ROOM, name: "Room", owner_id: "o", member_count: 3, my_permissions: "1", my_roles: [], is_owner: false, read_states: [],
  roles: [{ id: "e", room_id: ROOM, name: "@everyone", color: null, position: 0, permissions: "1", hoist: false, mentionable: false, is_everyone: true }],
  categories: [],
  channels: [{ id: CHAN, room_id: ROOM, category_id: null, kind: "text", name: "council", topic: "", position: 0, encrypted: false }],
  overrides: [],
} as unknown as RoomDetail;

const message = (id: string, content: unknown, over: Partial<Message> = {}) =>
  ({ id, conversation_id: CHAN, author: "echo@home.test", author_id: "bot", device_id: null, encrypted: false, content, created_at: "2026-10-17T10:00:00Z", reactions: [], attachments: [], mentions: [], mentions_everyone: false, ...over }) as unknown as Message;

function setup() {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const socket = {
    on: (type: string, h: (data: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
      return () => undefined;
    },
  } as unknown as TavrnSocket;
  const client = new QueryClient();
  client.setQueryData(["rooms"], [{ id: ROOM }]);
  client.setQueryData(["room", ROOM], room);
  roomHandlers(socket, client, () => ({ id: "me", address: "me@home.test" }), null);
  return (type: string, data: unknown) => (handlers.get(type) ?? []).forEach((h) => h(data));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("security notices in a channel", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", refresh: "r", user: { id: "me", address: "me@home.test", username: "me", domain: "home.test" } as unknown as UserPrivate, deviceId: "d", home: null });
    useNotifications.setState({ settings: { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, sound: false } }, entries: [] });
    useToasts.setState({ toasts: [] });
    useMlsUi.setState({ open: null });
    useUnread.setState({ states: {}, held: {} });
    resetRoomLookups();
  });
  afterEach(() => useAuth.setState({ token: null, refresh: null, user: null, deviceId: null }));

  it("move the newest message but count nothing and notify nobody", async () => {
    const emit = setup();
    // Even a (forged) mention list on a notice changes nothing.
    emit("message.create", message("01NOTICE000000000000000000", { type: "system.bot_added", bot: "echo@home.test", channel: CHAN, channel_name: "council", by: "carol@home.test" }, { mentions: ["me@home.test"] }));
    await flush();
    expect(useUnread.getState().states[CHAN]).toMatchObject({ last: "01NOTICE000000000000000000", unread: 0, mentions: 0 });
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(useNotifications.getState().entries).toHaveLength(0);
  });

  it("leave ordinary messages counted and notified", async () => {
    const emit = setup();
    emit("message.create", message("01TEXT00000000000000000000", { type: "text", body: "hello" }, { author: "bob@home.test", author_id: "bob", device_id: "d2", mentions: ["me@home.test"] }));
    await flush();
    await flush();
    expect(useUnread.getState().states[CHAN]).toMatchObject({ unread: 1, mentions: 1 });
    expect(useToasts.getState().toasts.length).toBeGreaterThan(0);
  });
});
