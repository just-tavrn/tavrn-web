// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Permission, type Member } from "@tavrn/sdk";
import { DUCK_GAIN, PriorityTracker, claimsPriority, duckGain, priorityAllowed, rampTo } from "./priority";
import { memberChannelPermissions, type RoomPermissionData } from "../lib/memberPermissions";

const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();
const BASE = bits(Permission.VIEW_CHANNEL, Permission.CONNECT, Permission.SPEAK);

const room: RoomPermissionData = {
  owner_id: "owner",
  roles: [
    { id: "everyone", is_everyone: true, permissions: BASE },
    { id: "lead", is_everyone: false, permissions: bits(Permission.PRIORITY_SPEAKER) },
  ],
  overrides: [
    // In the "quiet" channel the lead role loses the bit again.
    { target_type: "channel", target_id: "quiet", subject_type: "role", subject_id: "lead", allow: "0", deny: bits(Permission.PRIORITY_SPEAKER) },
  ],
  channels: [
    { id: "voice", category_id: null },
    { id: "quiet", category_id: null },
  ],
};

const member = (address: string, roles: string[], extra: Partial<Member> = {}): Member =>
  ({ user: { id: address.split("@")[0], address, kind: "user" }, roles, joined_at: "", room_avatar_animated: false, ...extra }) as unknown as Member;

const members = [member("lea@n", ["lead"]), member("bob@n", []), member("owner@n", []), member("tim@n", ["lead"], { timeout_until: new Date(Date.now() + 60_000).toISOString() })];

describe("priority speaker (design note 4.13 item 3)", () => {
  it("reads the claim from the LiveKit attributes", () => {
    expect(claimsPriority({ priority: "1" })).toBe(true);
    expect(claimsPriority({ priority: "" })).toBe(false);
    expect(claimsPriority({ priority: "true" })).toBe(false);
    expect(claimsPriority(undefined)).toBe(false);
  });

  it("computes the permissions of other members like the node (roles, overrides, owner, timeout)", () => {
    const perms = (m: Member, channel = "voice") => memberChannelPermissions(room, channel, m);
    expect(perms(members[0]!) & Permission.PRIORITY_SPEAKER).toBe(Permission.PRIORITY_SPEAKER);
    expect(perms(members[0]!, "quiet") & Permission.PRIORITY_SPEAKER).toBe(0n);
    expect(perms(members[1]!) & Permission.PRIORITY_SPEAKER).toBe(0n);
    expect(perms({ ...members[2]!, user: { ...members[2]!.user, id: "owner" } }) & Permission.PRIORITY_SPEAKER).toBe(Permission.PRIORITY_SPEAKER);
    // Timed out: only view_channel is left.
    expect(perms(members[3]!)).toBe(Permission.VIEW_CHANNEL);
    expect(memberChannelPermissions(room, "missing", members[0]!)).toBe(0n);
  });

  it("allows only members whose channel permissions contain the bit", () => {
    expect(priorityAllowed(room, members, "voice", "lea@n")).toBe(true);
    expect(priorityAllowed(room, members, "quiet", "lea@n")).toBe(false);
    expect(priorityAllowed(room, members, "voice", "bob@n")).toBe(false);
    expect(priorityAllowed(room, members, "voice", "stranger@other")).toBe(false);
    expect(priorityAllowed(undefined, members, "voice", "lea@n")).toBe(false);
    expect(priorityAllowed(room, undefined, "voice", "lea@n")).toBe(false);
  });

  it("ducks everybody but the verified speakers to 25 %", () => {
    expect(duckGain("a", new Set())).toBe(1);
    expect(duckGain("a", new Set(["a"]))).toBe(1);
    expect(duckGain("b", new Set(["a"]))).toBe(DUCK_GAIN);
    expect(duckGain("b", new Set(["a", "b"]))).toBe(1);
  });

  it("security: a hostile client setting priority=1 without the bit ducks nobody", async () => {
    const changes: string[][] = [];
    const tracker = new PriorityTracker(
      async (identity) => priorityAllowed(room, members, "voice", identity.split("/")[0]!),
      (active) => changes.push([...active]),
    );
    await tracker.update("bob@n/DEV", true);
    expect(tracker.active.size).toBe(0);
    expect(changes).toEqual([]);
    for (const id of ["lea@n/1", "owner@n/1", "bob@n/DEV"]) expect(duckGain(id, tracker.active)).toBe(1);
    // A real priority speaker ducks the others, also the hostile one; the release restores everybody.
    await tracker.update("lea@n/1", true);
    expect([...tracker.active]).toEqual(["lea@n/1"]);
    expect(duckGain("bob@n/DEV", tracker.active)).toBe(DUCK_GAIN);
    expect(duckGain("lea@n/1", tracker.active)).toBe(1);
    await tracker.update("lea@n/1", false);
    expect(tracker.active.size).toBe(0);
    expect(changes).toEqual([["lea@n/1"], []]);
  });

  it("ignores a check that finished after the claim was withdrawn, and failing checks", async () => {
    let resolve!: (ok: boolean) => void;
    const tracker = new PriorityTracker(
      () => new Promise<boolean>((r) => (resolve = r)),
      () => undefined,
    );
    const pending = tracker.update("lea@n/1", true);
    tracker.remove("lea@n/1");
    resolve(true);
    await pending;
    expect(tracker.active.size).toBe(0);
    const failing = new PriorityTracker(
      () => Promise.reject(new Error("offline")),
      () => undefined,
    );
    await failing.update("lea@n/1", true);
    expect(failing.active.size).toBe(0);
  });

  it("ramps the gain linearly in 80 ms from the current value", () => {
    const param = { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
    rampTo(param as unknown as AudioParam, 0.25, 10);
    expect(param.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(param.setValueAtTime).toHaveBeenCalledWith(1, 10);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 10.08);
  });
});
