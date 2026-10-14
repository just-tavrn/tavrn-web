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

  it("role events patch the room at once and refetch it once per burst (own permissions may change)", async () => {
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

  it("member joins and leaves refetch the room (its member count); the own ones refresh the room list too", async () => {
    const { emit, keys } = setup();
    emit("member.join", { room_id: "r1", user: { id: "other" } });
    emit("member.leave", { room_id: "r1", user_id: "other2" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["room","r1"]']);
    emit("member.leave", { room_id: "r1", user_id: "me", kicked: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual(['["room","r1"]', '["rooms"]', '["room","r1"]']);
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
