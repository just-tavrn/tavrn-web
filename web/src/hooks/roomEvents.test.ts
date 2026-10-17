// SPDX-License-Identifier: Apache-2.0
// Realtime events of a room's metadata patch the cached room detail from their payloads; only events that can change
// the viewer's own permissions refetch the room, once per burst (250 ms), and the room list and the command palettes
// are refreshed only by the events that change them.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomDetail, TavrnSocket } from "@tavrn/sdk";
import { roomEventHandlers } from "./roomEvents";

const detail = (): RoomDetail =>
  ({
    id: "r1", name: "Raum", owner_id: "o", member_count: 3, my_permissions: "1", my_roles: [], is_owner: false, read_states: [],
    roles: [{ id: "e", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: "1", hoist: false, mentionable: false, is_everyone: true }],
    categories: [],
    channels: [{ id: "c1", room_id: "r1", category_id: null, kind: "text", name: "allgemein", topic: "", position: 0, encrypted: false }],
    overrides: [],
  }) as unknown as RoomDetail;

function setup() {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const socket = {
    on: (type: string, h: (data: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
      return () => undefined;
    },
  } as unknown as TavrnSocket;
  const emit = (type: string, data: unknown) => (handlers.get(type) ?? []).forEach((h) => h(data));
  const client = new QueryClient();
  client.setQueryData(["room", "r1"], detail());
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  const offs = roomEventHandlers(socket, client, () => ({ id: "me", address: "me@localhost" }));
  const keys = () => invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
  const room = () => client.getQueryData<RoomDetail>(["room", "r1"])!;
  return { emit, client, invalidate, keys, room, offs };
}

describe("roomEventHandlers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("channel and category events patch the room without any refetch", async () => {
    const { emit, keys, room } = setup();
    emit("category.create", { id: "k1", room_id: "r1", name: "Team", position: 0, no_bots: false });
    emit("channel.create", { id: "c2", room_id: "r1", category_id: "k1", kind: "voice", name: "Sprache", topic: "", position: 1, encrypted: false });
    emit("channel.update", { id: "c1", room_id: "r1", category_id: null, kind: "text", name: "neu", topic: "", position: 0, encrypted: false });
    expect(room().categories.map((c) => c.id)).toEqual(["k1"]);
    expect(room().channels.map((c) => [c.id, c.name])).toEqual([["c1", "neu"], ["c2", "Sprache"]]);
    emit("channel.delete", { room_id: "r1", id: "c2", hidden: true });
    emit("category.delete", { room_id: "r1", id: "k1" });
    expect(room().channels.map((c) => c.id)).toEqual(["c1"]);
    expect(room().categories).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(keys()).toEqual([]);
  });

  it("a reorder by another client: channel.update and category.update move entries, the cache keeps the node's order", () => {
    const { emit, room } = setup();
    emit("category.create", { id: "k1", room_id: "r1", name: "Team", position: 0, no_bots: false });
    emit("category.create", { id: "k2", room_id: "r1", name: "Play", position: 1, no_bots: false });
    emit("channel.create", { id: "c2", room_id: "r1", category_id: "k1", kind: "text", name: "zwei", topic: "", position: 1, encrypted: false });
    emit("channel.update", { id: "c1", room_id: "r1", category_id: "k1", kind: "text", name: "allgemein", topic: "", position: 2, encrypted: false });
    expect(room().channels.map((c) => [c.id, c.category_id])).toEqual([["c2", "k1"], ["c1", "k1"]]);
    emit("channel.update", { id: "c1", room_id: "r1", category_id: "k2", kind: "text", name: "allgemein", topic: "", position: 0, encrypted: false });
    expect(room().channels.map((c) => [c.id, c.category_id])).toEqual([["c1", "k2"], ["c2", "k1"]]);
    emit("category.update", { id: "k2", room_id: "r1", name: "Play", position: 0, no_bots: false });
    emit("category.update", { id: "k1", room_id: "r1", name: "Team", position: 1, no_bots: false });
    expect(room().categories.map((c) => c.id)).toEqual(["k2", "k1"]);
  });

  it("room.update with a changed privacy notice or legal notice reloads the open document views of the room only", async () => {
    const { emit, invalidate, room } = setup();
    emit("room.update", { id: "r1", name: "Raum", owner_id: "o", privacy_notice_updated_at: null, legal_notice_updated_at: null });
    expect(invalidate.mock.calls.filter(([f]) => f?.predicate)).toEqual([]);
    emit("room.update", { id: "r1", name: "Raum", owner_id: "o", privacy_notice_updated_at: "2026-10-17T10:00:00Z", legal_notice_updated_at: null });
    expect(room().privacy_notice_updated_at).toBe("2026-10-17T10:00:00Z");
    const preds = invalidate.mock.calls.map(([f]) => f?.predicate).filter(Boolean);
    expect(preds).toHaveLength(1);
    const query = (key: unknown[]) => ({ queryKey: key }) as never;
    expect(preds[0]!(query(["room-preview", "", "r1"]))).toBe(true);
    expect(preds[0]!(query(["room-preview", "", "r2"]))).toBe(false);
    expect(preds[0]!(query(["room", "r1"]))).toBe(false);
  });

  it("override.update replaces the target's overrides and refreshes only the command palettes", async () => {
    const { emit, keys, room } = setup();
    const o = { id: "o1", target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "e", allow: "0", deny: "1" };
    emit("override.update", { room_id: "r1", target_type: "channel", target_id: "c1", overrides: [o] });
    expect(room().overrides).toEqual([o]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(keys()).toEqual(['["commands"]']);
  });

  it("an override.update without its list refetches the room once", async () => {
    const { emit, keys } = setup();
    emit("override.update", { room_id: "r1" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["commands"]', '["room","r1"]']);
  });

  it("role events patch the room at once and refetch it once per burst when they can change the viewer's permissions", async () => {
    const { emit, invalidate, keys, room } = setup();
    for (let i = 1; i <= 4; i++) emit("role.update", { id: "e", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: String(i), hoist: false, mentionable: false, is_everyone: true });
    emit("role.create", { id: "a", room_id: "r1", name: "A", color: null, position: 1, permissions: "0", hoist: false, mentionable: false, is_everyone: false });
    expect(room().roles.map((r) => [r.id, r.permissions])).toEqual([["a", "0"], ["e", "4"]]);
    expect(keys().filter((k) => k.startsWith('["room"'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(keys().filter((k) => k.startsWith('["room"'))).toEqual(['["room","r1"]']);
    expect(keys()).not.toContain('["rooms"]');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["room", "r1"] }, { cancelRefetch: false });
    emit("role.delete", { room_id: "r1", id: "a" });
    expect(room().roles.map((r) => r.id)).toEqual(["e"]);
  });

  it("roles the viewer does not hold, and any role of the owner, do not refetch; deleting a held role does", async () => {
    const { client, emit, keys, room } = setup();
    client.setQueryData(["room", "r1"], { ...room(), my_roles: ["held"] });
    emit("role.create", { id: "other", room_id: "r1", name: "B", color: null, position: 2, permissions: "8", hoist: false, mentionable: false, is_everyone: false });
    emit("role.update", { id: "other", room_id: "r1", name: "B", color: null, position: 2, permissions: "9", hoist: false, mentionable: false, is_everyone: false });
    emit("role.delete", { room_id: "r1", id: "other" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys().filter((k) => k.startsWith('["room"'))).toEqual([]);
    emit("role.delete", { room_id: "r1", id: "held" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys().filter((k) => k.startsWith('["room"'))).toEqual(['["room","r1"]']);
    expect(room().my_roles).toEqual([]);
    client.setQueryData(["room", "r1"], { ...room(), is_owner: true });
    emit("role.update", { id: "e", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: "0", hoist: false, mentionable: false, is_everyone: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys().filter((k) => k.startsWith('["room"'))).toEqual(['["room","r1"]']);
  });

  it("room.update patches the room and refreshes the room list; room.delete refreshes the list", async () => {
    const { emit, keys, room } = setup();
    emit("room.update", { id: "r1", name: "Neu", owner_id: "o" });
    expect(room().name).toBe("Neu");
    emit("room.delete", { id: "r1" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(keys()).toEqual(['["rooms"]', '["rooms"]']);
  });

  it("a new owner refetches the room (the viewer's permissions follow the ownership)", async () => {
    const { emit, keys } = setup();
    emit("room.update", { id: "r1", name: "Raum", owner_id: "me" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["rooms"]', '["room","r1"]']);
  });

  it("member.update refetches the room only for the viewer's own membership", async () => {
    const { emit, keys } = setup();
    emit("member.update", { room_id: "r1", member: { user: { id: "other" }, roles: ["a"] } });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["commands"]']);
    emit("member.update", { room_id: "r1", member: { user: { id: "me" }, roles: ["a"] } });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["commands"]', '["commands"]', '["room","r1"]']);
  });

  it("another member's join or leave patches the member list and the member count without any refetch", async () => {
    const { client, emit, keys, room } = setup();
    const user = (id: string) => ({ id, address: `${id}@localhost`, display_name: id, username: id, domain: "localhost", kind: "user" });
    const member = (id: string, roles: string[] = []) => ({ user: user(id), roles, joined_at: "2026-01-01T00:00:00Z", room_avatar_animated: false });
    client.setQueryData(["members", "r1"], [member("a"), member("c", ["mod"])]);
    // Observed like the member list does: an invalidation would fetch it again.
    const fetches = vi.fn(async () => [] as unknown[]);
    const observer = client.getQueryCache().build(client, { queryKey: ["members", "r1"], queryFn: fetches });
    emit("member.join", { room_id: "r1", user: user("b") });
    expect(client.getQueryData<{ user: { id: string } }[]>(["members", "r1"])!.map((m) => m.user.id)).toEqual(["a", "b", "c"]);
    expect(room().member_count).toBe(4);
    // A repeated join keeps the listed member (roles, room profile) and the count.
    emit("member.join", { room_id: "r1", user: user("c") });
    expect(client.getQueryData<{ roles: string[] }[]>(["members", "r1"])![2]!.roles).toEqual(["mod"]);
    expect(room().member_count).toBe(4);
    emit("member.update", { room_id: "r1", member: member("b", ["vip"]) });
    expect(client.getQueryData<{ roles: string[] }[]>(["members", "r1"])![1]!.roles).toEqual(["vip"]);
    emit("member.leave", { room_id: "r1", user_id: "a" });
    expect(client.getQueryData<{ user: { id: string } }[]>(["members", "r1"])!.map((m) => m.user.id)).toEqual(["b", "c"]);
    expect(room().member_count).toBe(3);
    // Unknown leaver: not listed, the count stays.
    emit("member.leave", { room_id: "r1", user_id: "zz" });
    expect(room().member_count).toBe(3);
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["commands"]']);
    expect(fetches).not.toHaveBeenCalled();
    expect(observer.state.data).toHaveLength(2);
  });

  it("a join or leave without a cached member list still moves the count", async () => {
    const { emit, keys, room } = setup();
    emit("member.join", { room_id: "r1", user: { id: "x", address: "x@localhost" } });
    emit("member.join", { room_id: "r1", user: { id: "y", address: "y@localhost" } });
    emit("member.leave", { room_id: "r1", user_id: "x" });
    expect(room().member_count).toBe(4);
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual([]);
  });

  it("a member list being fetched is fetched again instead of patched (the answer may predate the event)", () => {
    const { client, emit, invalidate } = setup();
    client.setQueryData(["members", "r1"], []);
    const query = client.getQueryCache().find({ queryKey: ["members", "r1"] })!;
    query.setState({ fetchStatus: "fetching" });
    emit("member.join", { room_id: "r1", user: { id: "x", address: "x@localhost" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["members", "r1"], exact: true });
  });

  it("the viewer's own joins and leaves refetch the room and refresh the room list", async () => {
    const { emit, keys } = setup();
    emit("member.join", { room_id: "r1", user: { id: "me", address: "me@localhost" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["rooms"]', '["room","r1"]']);
    emit("member.leave", { room_id: "r1", user_id: "me", kicked: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["rooms"]', '["room","r1"]', '["rooms"]', '["room","r1"]']);
  });

  it("commands.update refreshes the command palettes; unsubscribing drops pending refetches", async () => {
    const { emit, keys, offs } = setup();
    emit("commands.update", {});
    emit("role.update", { id: "e", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: "9", hoist: false, mentionable: false, is_everyone: true });
    offs.forEach((off) => off());
    await vi.advanceTimersByTimeAsync(1000);
    expect(keys()).toEqual(['["commands"]', '["commands"]']);
  });
});
