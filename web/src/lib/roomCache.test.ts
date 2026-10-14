// SPDX-License-Identifier: Apache-2.0
// The room detail in the query cache follows mutation answers and realtime payloads without a refetch; only changes
// that can move the viewer's own permissions refetch, coalesced and debounced per room.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Channel, PermissionOverride, Role, RoomDetail } from "@tavrn/sdk";
import { patchRoom, roomRefetcher, withCategory, withChannel, withOverrides, withRole, withRoom, withoutCategory, withoutChannel, withoutOverrides, withoutRole } from "./roomCache";

const ch = (id: string, position: number, category_id: string | null = null): Channel =>
  ({ id, room_id: "r1", category_id, kind: "text", name: id, topic: "", position, encrypted: false, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0 }) as unknown as Channel;
const cat = (id: string, position: number): Category => ({ id, room_id: "r1", name: id, position, no_bots: false });
const role = (id: string, position: number, permissions = "0"): Role => ({ id, room_id: "r1", name: id, color: null, position, permissions, hoist: false, mentionable: false, is_everyone: position === 0 });
const ov = (id: string, target_type: string, target_id: string, subject_id: string): PermissionOverride => ({ id, target_type, target_id, subject_type: "role", subject_id, allow: "0", deny: "1" });

const detail = (): RoomDetail =>
  ({
    id: "r1", name: "Raum", owner_id: "o", member_count: 3, my_permissions: "1", my_roles: ["a"], is_owner: false, read_states: [],
    roles: [role("b", 2), role("a", 1), role("e", 0)],
    categories: [cat("k1", 0), cat("k2", 1)],
    channels: [ch("c1", 0), ch("c2", 1, "k1"), ch("c3", 2, "k2")],
    overrides: [ov("o1", "channel", "c2", "a"), ov("o2", "category", "k2", "e"), ov("o3", "channel", "c3", "b")],
  }) as unknown as RoomDetail;

describe("room detail patches", () => {
  it("inserts and replaces channels in the node's order (position, then id)", () => {
    const d = withChannel(ch("c0", 1))(detail());
    expect(d.channels.map((c) => c.id)).toEqual(["c1", "c0", "c2", "c3"]);
    const moved = withChannel({ ...ch("c1", 5), name: "neu" })(d);
    expect(moved.channels.map((c) => c.id)).toEqual(["c0", "c2", "c3", "c1"]);
    expect(moved.channels.at(-1)!.name).toBe("neu");
  });

  it("removes a channel with its own overrides", () => {
    const d = withoutChannel("c2")(detail());
    expect(d.channels.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(d.overrides.map((o) => o.id)).toEqual(["o2", "o3"]);
  });

  it("inserts, replaces and removes categories; the channels of a removed one lose it", () => {
    const d = withCategory(cat("k0", 0))(detail());
    expect(d.categories.map((c) => c.id)).toEqual(["k0", "k1", "k2"]);
    const gone = withoutCategory("k2")(d);
    expect(gone.categories.map((c) => c.id)).toEqual(["k0", "k1"]);
    expect(gone.channels.find((c) => c.id === "c3")!.category_id).toBeNull();
    expect(gone.overrides.map((o) => o.id)).toEqual(["o1", "o3"]);
  });

  it("keeps roles highest first; a removed role leaves the own roles and the overrides", () => {
    const d = withRole(role("c", 3))(detail());
    expect(d.roles.map((r) => r.id)).toEqual(["c", "b", "a", "e"]);
    expect(withRole(role("a", 1, "8"))(d).roles.find((r) => r.id === "a")!.permissions).toBe("8");
    const gone = withoutRole("a")(d);
    expect(gone.roles.map((r) => r.id)).toEqual(["c", "b", "e"]);
    expect(gone.my_roles).toEqual([]);
    expect(gone.overrides.map((o) => o.id)).toEqual(["o2", "o3"]);
  });

  it("replaces the overrides of one target and removes cleared ones", () => {
    const d = withOverrides("channel", "c2", [ov("o9", "channel", "c2", "b"), ov("o1", "channel", "c2", "a")])(detail());
    expect(d.overrides.map((o) => o.id)).toEqual(["o1", "o2", "o3", "o9"]);
    expect(withOverrides("channel", "c2", [])(d).overrides.map((o) => o.id)).toEqual(["o2", "o3"]);
    expect(withoutOverrides([{ target_type: "channel", target_id: "c3", subject_type: "role", subject_id: "b" }])(d).overrides.map((o) => o.id)).toEqual(["o1", "o2", "o9"]);
  });

  it("ignores answers without an id or a list (the next refetch decides)", () => {
    const d = detail();
    expect(withChannel({} as Channel)(d).channels).toEqual(d.channels);
    expect(withRole({} as Role)(d).roles).toEqual(d.roles);
    expect(withOverrides("channel", "c2", {} as never)(d).overrides).toEqual(d.overrides);
  });

  it("merges a room update into the detail and keeps the viewer's fields", () => {
    const d = withRoom({ id: "r1", name: "Neu", owner_id: "o" } as never)(detail());
    expect(d.name).toBe("Neu");
    expect(d.my_permissions).toBe("1");
    expect(d.channels).toHaveLength(3);
  });

  it("changes only the room's cache entries (with the per-node keys) and nothing when none is cached", () => {
    const client = new QueryClient();
    client.setQueryData(["room", "r1"], detail());
    client.setQueryData(["room", "r1", "other.example"], detail());
    client.setQueryData(["room", "r2"], { ...detail(), id: "r2" });
    patchRoom(client, "r1", withoutChannel("c1"));
    expect(client.getQueryData<RoomDetail>(["room", "r1"])!.channels).toHaveLength(2);
    expect(client.getQueryData<RoomDetail>(["room", "r1", "other.example"])!.channels).toHaveLength(2);
    expect(client.getQueryData<RoomDetail>(["room", "r2"])!.channels).toHaveLength(3);
    patchRoom(client, "r3", withoutChannel("c1"));
    expect(client.getQueryData(["room", "r3"])).toBeUndefined();
  });
});

describe("roomRefetcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const client = new QueryClient();
    client.setQueryData(["room", "r1"], detail());
    client.setQueryData(["room", "r2"], detail());
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    return { client, invalidate, refetcher: roomRefetcher(client, 250) };
  }

  it("coalesces a burst of changes into one refetch per room after the quiet period", async () => {
    const { invalidate, refetcher } = setup();
    refetcher.schedule("r1");
    await vi.advanceTimersByTimeAsync(200);
    refetcher.schedule("r1");
    refetcher.schedule("r2");
    refetcher.schedule("r1");
    await vi.advanceTimersByTimeAsync(249);
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["room", "r1"] }, { cancelRefetch: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["room", "r2"] }, { cancelRefetch: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("does not cancel a fetch in flight: it waits for it and refetches afterwards", async () => {
    const { client, invalidate, refetcher } = setup();
    let fetching = true;
    vi.spyOn(client, "isFetching").mockImplementation(() => (fetching ? 1 : 0));
    refetcher.schedule("r1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).not.toHaveBeenCalled();
    fetching = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("stop() drops pending refetches", async () => {
    const { invalidate, refetcher } = setup();
    refetcher.schedule("r1");
    refetcher.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
