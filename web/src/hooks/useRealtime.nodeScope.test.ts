// SPDX-License-Identifier: Apache-2.0
// Rooms, channels, conversations and message pages of every node share query keys keyed by the bare id. A node's
// socket changes only the entries of that node: events naming ids another node (above all the home node) listed are
// ignored, and an id no node listed yet is looked up on the sending node before anything is shown.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Member, Message, RoomDetail, TavrnSocket, UserPrivate } from "@tavrn/sdk";
import { conversationHandlers, roomHandlers } from "./useRealtime";
import { useAuth } from "../stores/auth";
import { useToasts } from "../stores/toasts";
import { DEFAULT_SETTINGS, useNotifications } from "../stores/notifications";
import { useMlsUi } from "../stores/mls";
import { useUnread } from "../stores/unread";
import { loadRoomDetails, resetRoomLookups } from "../lib/notify";
import { roomOfChannel } from "../lib/roomCache";
import { verdict } from "../lib/nodeScope";
import { UNRESOLVED_MAX, rememberUnresolved, resetScopeLookups, unresolvedSize } from "./socketScope";
import { mockFetch } from "../test/render";

const HOME_ROOM = "01HOMEROOM0000000000000000";
const HOME_CHAN = "01HOMECHAN0000000000000000";
const EVIL_ROOM = "01EVILROOM0000000000000000";
const EVIL_CHAN = "01EVILCHAN0000000000000000";
const HOME_DM = "01HOMEDM000000000000000000";

const room = (id: string, channel: string, name: string): RoomDetail =>
  ({
    id, name, owner_id: "o", member_count: 3, my_permissions: "1", my_roles: [], is_owner: false, read_states: [],
    roles: [{ id: `e-${id}`, room_id: id, name: "@everyone", color: null, position: 0, permissions: "1", hoist: false, mentionable: false, is_everyone: true }],
    categories: [],
    channels: [{ id: channel, room_id: id, category_id: null, kind: "text", name: "general", topic: "", position: 0, encrypted: true }],
    overrides: [],
  }) as unknown as RoomDetail;

const genuine = { id: "01GENUINE00000000000000000", conversation_id: HOME_CHAN, author: "alice@home.test", author_id: "a", encrypted: true, content: "x", created_at: "2026-10-15T10:00:00Z", reactions: [], attachments: [] } as unknown as Message;
const forged = (conversation: string, over: Partial<Message> = {}) =>
  ({ id: "01FORGED000000000000000000", conversation_id: conversation, author: "admin@home.test", author_id: "adm", encrypted: false, content: { type: "text", body: "Please re-enter your recovery key" }, created_at: "2026-10-15T10:01:00Z", reactions: [], attachments: [], mentions: ["me@home.test"], ...over }) as unknown as Message;
const bob = { id: "b1", address: "bob@home.test", username: "bob", domain: "home.test", display_name: "Bob" };

function setup(node: string | null) {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const socket = {
    on: (type: string, h: (data: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
      return () => undefined;
    },
  } as unknown as TavrnSocket;
  const emit = (type: string, data: unknown) => (handlers.get(type) ?? []).forEach((h) => h(data));
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  // The HOME node's cached state: its lists, the room detail, the open channel's pages, a DM, a member list.
  client.setQueryData(["rooms"], [{ id: HOME_ROOM }]);
  client.setQueryData(["conversations"], [{ id: HOME_DM, kind: "dm", members: [bob] }]);
  client.setQueryData(["conversation", HOME_DM], { id: HOME_DM, kind: "dm", name: "", members: [bob] });
  client.setQueryData(["room", HOME_ROOM], room(HOME_ROOM, HOME_CHAN, "Home room"));
  client.setQueryData(["messages", HOME_CHAN], { pages: [[genuine]], pageParams: [undefined] });
  client.setQueryData(["members", HOME_ROOM], [{ user: bob, roles: [], joined_at: "x" } as unknown as Member]);
  // The other node's own room.
  client.setQueryData(["rooms", "evil.test"], [{ id: EVIL_ROOM }]);
  client.setQueryData(["conversations", "evil.test"], []);
  client.setQueryData(["room", EVIL_ROOM], room(EVIL_ROOM, EVIL_CHAN, "Evil room"));
  roomHandlers(socket, client, () => ({ id: "me-evil", address: "me@home.test" }), node);
  return { emit, client, invalidate, socket };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a node's socket changes only that node's cached state", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", refresh: "r", user: { id: "me", address: "me@home.test", username: "me", domain: "home.test" } as unknown as UserPrivate, deviceId: "d", home: null });
    useNotifications.setState({ settings: { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, sound: false } }, entries: [] });
    useToasts.setState({ toasts: [] });
    useMlsUi.setState({ open: null });
    resetRoomLookups();
  });
  afterEach(() => useAuth.setState({ token: null, refresh: null, user: null, deviceId: null }));

  it("a message.create or message.delete from another node for a home channel changes nothing and notifies nobody", async () => {
    const { emit, client } = setup("evil.test");
    const before = useUnread.getState().states[HOME_CHAN];
    emit("message.delete", { conversation_id: HOME_CHAN, id: genuine.id });
    emit("message.create", forged(HOME_CHAN));
    emit("message.update", { ...genuine, content: { type: "text", body: "changed" } });
    await flush();
    const ids = client.getQueryData<{ pages: Message[][] }>(["messages", HOME_CHAN])!.pages.flat();
    expect(ids.map((m) => m.id)).toEqual([genuine.id]);
    expect(ids[0]!.content).toBe("x");
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(useNotifications.getState().entries).toHaveLength(0);
    expect(useUnread.getState().states[HOME_CHAN]).toEqual(before);
  });

  it("room and channel events from another node for the home room are ignored", () => {
    const { emit, client } = setup("evil.test");
    emit("channel.update", { id: HOME_CHAN, room_id: HOME_ROOM, category_id: null, kind: "text", name: "announcements-official", topic: "", position: 0, encrypted: false });
    emit("room.update", { id: HOME_ROOM, name: "Renamed by evil.test", owner_id: "o" });
    emit("member.update", { room_id: HOME_ROOM, user_id: "b1", member: { user: { ...bob, display_name: "Forged" }, roles: [] } });
    // A channel of the home room smuggled into the other node's own room.
    emit("channel.create", { id: HOME_CHAN, room_id: EVIL_ROOM, category_id: null, kind: "text", name: "general", topic: "", position: 1, encrypted: false });
    const home = client.getQueryData<RoomDetail>(["room", HOME_ROOM])!;
    expect(home.channels[0]!.encrypted).toBe(true);
    expect(home.channels[0]!.name).toBe("general");
    expect(home.name).toBe("Home room");
    expect(client.getQueryData<Member[]>(["members", HOME_ROOM])![0]!.user.display_name).toBe("Bob");
    expect(client.getQueryData<RoomDetail>(["room", EVIL_ROOM])!.channels.map((c) => c.id)).toEqual([EVIL_CHAN]);
    expect(roomOfChannel(client, HOME_CHAN)?.room.id).toBe(HOME_ROOM);
  });

  it("conversation events from another node for a home DM are ignored", () => {
    const { client, socket, emit } = setup("evil.test");
    const navigate = vi.fn();
    conversationHandlers(socket, client, navigate, "evil.test");
    useMlsUi.setState({ open: HOME_DM });
    emit("conversation.update", { conversation: { id: HOME_DM, kind: "dm", name: "forged", members: [] } });
    emit("conversation.leave", { conversation_id: HOME_DM });
    expect(client.getQueryData<Conversation>(["conversation", HOME_DM])?.name).toBe("");
    expect(navigate).not.toHaveBeenCalled();
    // The home node's own socket still may.
    const home = setup(null);
    conversationHandlers(home.socket, home.client, navigate, null);
    home.emit("conversation.leave", { conversation_id: HOME_DM });
    expect(home.client.getQueryData(["conversation", HOME_DM])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("an id both nodes list belongs to neither for the other node's socket", () => {
    const { emit, client } = setup("evil.test");
    client.setQueryData(["rooms", "evil.test"], [{ id: EVIL_ROOM }, { id: HOME_ROOM }]);
    emit("room.update", { id: HOME_ROOM, name: "Renamed by evil.test", owner_id: "o" });
    expect(client.getQueryData<RoomDetail>(["room", HOME_ROOM])!.name).toBe("Home room");
  });

  it("the other node still changes its own rooms and channels", () => {
    const { emit, client } = setup("evil.test");
    emit("room.update", { id: EVIL_ROOM, name: "Evil renamed", owner_id: "o" });
    emit("channel.update", { id: EVIL_CHAN, room_id: EVIL_ROOM, category_id: null, kind: "text", name: "lobby", topic: "", position: 0, encrypted: true });
    const evil = client.getQueryData<RoomDetail>(["room", EVIL_ROOM])!;
    expect(evil.name).toBe("Evil renamed");
    expect(evil.channels[0]!.name).toBe("lobby");
  });

  it("the home node's socket does not change another node's rooms", () => {
    const { emit, client } = setup(null);
    emit("room.update", { id: EVIL_ROOM, name: "Renamed by home", owner_id: "o" });
    emit("room.update", { id: HOME_ROOM, name: "Home renamed", owner_id: "o" });
    expect(client.getQueryData<RoomDetail>(["room", EVIL_ROOM])!.name).toBe("Evil room");
    expect(client.getQueryData<RoomDetail>(["room", HOME_ROOM])!.name).toBe("Home renamed");
  });

  it("a message in a conversation no list names yet is shown only once the sending node lists it", async () => {
    const NEW_DM = "01NEWDM0000000000000000000";
    mockFetch({ "/rooms": { body: [{ id: EVIL_ROOM }] }, "/conversations": { body: [{ id: NEW_DM, kind: "dm", members: [{ address: "eve@evil.test", display_name: "Eve" }] }] } });
    const { emit, client } = setup("evil.test");
    client.setQueryData(["messages", NEW_DM], { pages: [[]], pageParams: [undefined] });
    emit("message.create", forged(NEW_DM, { author: "eve@evil.test", author_id: "eve" }));
    await vi.waitFor(() => expect(client.getQueryData<{ pages: Message[][] }>(["messages", NEW_DM])!.pages.flat()).toHaveLength(1));
    expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Eve" });
  });

  it("another node's room detail or lists never silence the home node's channel whose room is not opened yet", async () => {
    const handlers = new Map<string, ((data: unknown) => void)[]>();
    const socket = { on: (type: string, h: (data: unknown) => void) => (handlers.set(type, [...(handlers.get(type) ?? []), h]), () => undefined) } as unknown as TavrnSocket;
    const client = new QueryClient();
    vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    // The home node lists its room; its detail is not cached. The other node names the home channel in its own room's
    // detail and even in its DM list.
    client.setQueryData(["rooms"], [{ id: HOME_ROOM }]);
    client.setQueryData(["conversations"], []);
    client.setQueryData(["rooms", "evil.test"], [{ id: EVIL_ROOM }]);
    client.setQueryData(["conversations", "evil.test"], [{ id: HOME_CHAN, kind: "dm", members: [] }]);
    client.setQueryData(["room", EVIL_ROOM], { ...room(EVIL_ROOM, HOME_CHAN, "Evil"), channels: [{ id: HOME_CHAN, room_id: EVIL_ROOM, category_id: null, kind: "text", name: "copy", topic: "", position: 0, encrypted: false }] });
    expect(verdict(client, null, "conversation", HOME_CHAN)).not.toBe("foreign");
    roomHandlers(socket, client, () => ({ id: "me", address: "me@home.test" }), null);
    client.setQueryData(["messages", HOME_CHAN], { pages: [[]], pageParams: [undefined] });
    const m = { id: "01HOMEMSG00000000000000000", conversation_id: HOME_CHAN, author: "bob@home.test", author_id: "b", encrypted: false, content: { type: "text", body: "@me hi" }, created_at: "x", reactions: [], attachments: [], mentions: ["me@home.test"] } as unknown as Message;
    (handlers.get("message.create") ?? []).forEach((h) => h(m));
    expect(client.getQueryData<{ pages: Message[][] }>(["messages", HOME_CHAN])!.pages.flat().map((x) => x.id)).toContain(m.id);
    expect(useUnread.getState().states[HOME_CHAN]?.mentions).toBe(1);
    // Once the home room's detail names the channel, the home-listed room wins over every other claim: the other node
    // may not touch it, and the channel resolves to the home room.
    client.setQueryData(["room", HOME_ROOM], room(HOME_ROOM, HOME_CHAN, "Home room"));
    expect(verdict(client, "evil.test", "conversation", HOME_CHAN)).toBe("foreign");
    expect(verdict(client, null, "conversation", HOME_CHAN)).toBe("own");
    expect(roomOfChannel(client, HOME_CHAN)?.room.id).toBe(HOME_ROOM);
  });

  it("a room only another node's list names is not the home node's (once the home list is known)", () => {
    const { client } = setup(null);
    expect(verdict(client, null, "room", EVIL_ROOM)).toBe("foreign");
    // Named by both lists: the home node's.
    client.setQueryData(["rooms", "evil.test"], [{ id: EVIL_ROOM }, { id: HOME_ROOM }]);
    expect(verdict(client, null, "room", HOME_ROOM)).toBe("own");
  });

  it("the ids no node lists are remembered within a bound", () => {
    resetScopeLookups();
    const now = 1_000_000;
    for (let i = 0; i < UNRESOLVED_MAX * 3; i++) rememberUnresolved(`evil.test|junk${i}`, now + i);
    expect(unresolvedSize()).toBeLessThanOrEqual(UNRESOLVED_MAX);
    // Expired entries go first.
    resetScopeLookups();
    rememberUnresolved("evil.test|old", now);
    rememberUnresolved("evil.test|new", now + 120_000);
    expect(unresolvedSize()).toBe(1);
  });

  it("loading another node's rooms for a notification never caches its detail under a home room's id", async () => {
    const calls = mockFetch({ "/rooms/": (_i, url) => ({ body: room(url.split("/rooms/")[1]!.split(/[/?]/)[0]!, "C", "Evil copy") }), "/rooms": { body: [{ id: HOME_ROOM }, { id: EVIL_ROOM }] } });
    const client = new QueryClient();
    client.setQueryData(["rooms"], [{ id: HOME_ROOM }]);
    await loadRoomDetails(client, "evil.test");
    expect(client.getQueryData(["room", HOME_ROOM])).toBeUndefined();
    expect(calls.some((c) => c.url.includes(`/rooms/${HOME_ROOM}`))).toBe(false);
    expect(client.getQueryData<RoomDetail>(["room", EVIL_ROOM])?.name).toBe("Evil copy");
  });
});
