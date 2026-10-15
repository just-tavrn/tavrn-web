// SPDX-License-Identifier: Apache-2.0
// `user.update` patches the cached lists of the node that sent it (no refetch of member, friend or conversation lists);
// the own account takes only name and avatar from the home node's socket, and the own presence only from there.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, FriendList, Member, TavrnSocket, User, UserPrivate } from "@tavrn/sdk";
import { roomHandlers } from "./useRealtime";
import { useAuth } from "../stores/auth";
import { usePresence } from "../stores/presence";

const user = (id: string, address: string, extra: Partial<User> = {}): User =>
  ({ id, address, username: address.split("@")[0], domain: address.split("@")[1], display_name: address, kind: "user", is_node_admin: false, created_at: "2026-01-01T00:00:00Z", ...extra }) as User;
const member = (u: User): Member => ({ user: u, roles: [], joined_at: "2026-01-01T00:00:00Z", room_avatar_animated: false });

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
  const offs = roomHandlers(socket, client, () => ({ id: "me", address: "me@home.test" }), node);
  return { emit, client, invalidate, offs, keys: () => invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey ?? "predicate")) };
}

const bob = user("b1", "bob@home.test");
const bobFar = user("far-b", "bob@home.test");
const me = { id: "me", username: "me", address: "me@home.test", domain: "home.test", display_name: "Me", is_node_admin: false } as unknown as UserPrivate;

describe("user.update", () => {
  beforeEach(() => useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "d", home: null }));
  afterEach(() => useAuth.setState({ token: null, refresh: null, user: null, deviceId: null }));

  it("patches the member lists, conversations and friends of the home node without refetching them", () => {
    const { client, emit, keys } = setup(null);
    client.setQueryData(["rooms"], [{ id: "r1" }]);
    client.setQueryData(["rooms", "far.test"], [{ id: "r9" }]);
    client.setQueryData(["members", "r1"], [member(bob), member(user("c1", "carol@home.test"))]);
    client.setQueryData(["members", "r9"], [member(bobFar)]);
    const dm = { id: "dm1", kind: "dm", members: [bob, user("me", "me@home.test")] } as unknown as Conversation;
    client.setQueryData(["conversations"], [dm]);
    client.setQueryData(["conversation", "dm1"], dm);
    client.setQueryData(["conversations", "far.test"], [{ id: "g9", kind: "group", members: [bobFar] }]);
    client.setQueryData<FriendList>(["friends"], { friends: [{ user: bob, since: "x" }], incoming: [], outgoing: [], blocked: [] });
    const untouched = client.getQueryData(["members", "r1"]) as Member[];
    const carol = untouched[1];

    emit("user.update", { user: { ...bob, display_name: "Bobby", avatar: "/api/v1/media/new" } });

    const list = client.getQueryData<Member[]>(["members", "r1"])!;
    expect(list[0]!.user.display_name).toBe("Bobby");
    expect(list[1]).toBe(carol);
    expect(client.getQueryData<Conversation[]>(["conversations"])![0]!.members[0]!.display_name).toBe("Bobby");
    expect(client.getQueryData<Conversation>(["conversation", "dm1"])!.members[0]!.avatar).toBe("/api/v1/media/new");
    expect(client.getQueryData<FriendList>(["friends"])!.friends[0]!.user.display_name).toBe("Bobby");
    // Another node's copies (own ids, own avatar paths) wait for that node's event.
    expect(client.getQueryData<Member[]>(["members", "r9"])![0]!.user.display_name).toBe("bob@home.test");
    expect(client.getQueryData<Conversation[]>(["conversations", "far.test"])![0]!.members[0]!.display_name).toBe("bob@home.test");
    expect(keys()).not.toContain('["members"]');
    expect(keys()).not.toContain('["friends"]');
    expect(keys()).not.toContain('["conversations"]');
  });

  it("an update of a user nobody shows changes no cached object", () => {
    const { client, emit } = setup(null);
    client.setQueryData(["rooms"], [{ id: "r1" }]);
    const list = [member(bob)];
    client.setQueryData(["members", "r1"], list);
    emit("user.update", { user: user("x", "x@home.test") });
    expect(client.getQueryData(["members", "r1"])).toBe(list);
  });

  it("a foreign node's socket patches only that node's lists and never the home node's", () => {
    const { client, emit } = setup("far.test");
    client.setQueryData(["rooms"], [{ id: "r1" }]);
    client.setQueryData(["rooms", "far.test"], [{ id: "r9" }]);
    client.setQueryData(["members", "r1"], [member(bob)]);
    client.setQueryData(["members", "r9"], [member(bobFar)]);
    client.setQueryData<FriendList>(["friends"], { friends: [{ user: bob, since: "x" }], incoming: [], outgoing: [], blocked: [] });
    // Even with the home node's id of the user: the event speaks only for the copies of its own node.
    emit("user.update", { user: { ...bob, display_name: "Forged" } });
    emit("user.update", { user: { ...bobFar, display_name: "Bob far" } });
    expect(client.getQueryData<Member[]>(["members", "r1"])![0]!.user.display_name).toBe("bob@home.test");
    expect(client.getQueryData<FriendList>(["friends"])!.friends[0]!.user.display_name).toBe("bob@home.test");
    expect(client.getQueryData<Member[]>(["members", "r9"])![0]!.user.display_name).toBe("Bob far");
  });

  it("ignores malformed payloads", () => {
    const { emit } = setup(null);
    expect(() => emit("user.update", { id: "b1", address: "bob@home.test" })).not.toThrow();
    expect(() => emit("user.update", null)).not.toThrow();
  });
});

describe("own account from events", () => {
  beforeEach(() => useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "d", home: null }));
  afterEach(() => useAuth.setState({ token: null, refresh: null, user: null, deviceId: null }));

  it("takes only name and avatar of the own user from the home node", () => {
    const { emit } = setup(null);
    emit("user.update", { user: { ...me, display_name: "New me", avatar: "/api/v1/media/a", domain: "evil.test", username: "mallory", is_node_admin: true } });
    const now = useAuth.getState().user!;
    expect(now.display_name).toBe("New me");
    expect(now.avatar).toBe("/api/v1/media/a");
    expect(now.domain).toBe("home.test");
    expect(now.username).toBe("me");
    expect(now.is_node_admin).toBe(false);
  });

  it("never merges a foreign node's user.update into the account, even with the home id", () => {
    const { emit } = setup("evil.test");
    emit("user.update", { user: { ...me, display_name: "Hijacked", domain: "evil.test" } });
    expect(useAuth.getState().user).toEqual(me);
  });

  it("the own presence follows only the home node's socket", () => {
    usePresence.getState().setMine({ effective: "online", status: "online", custom_status: null, activity: null } as never);
    setup("evil.test").emit("presence.update", { user: "me@home.test", user_id: "me", status: "dnd", custom_status: { text: "forged" }, activity: null });
    expect(usePresence.getState().mine?.effective).toBe("online");
    setup(null).emit("presence.update", { user: "me@home.test", user_id: "me", status: "idle", custom_status: null, activity: null });
    expect(usePresence.getState().mine?.effective).toBe("idle");
  });
});
