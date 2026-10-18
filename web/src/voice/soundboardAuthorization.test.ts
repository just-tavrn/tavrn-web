// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { Permission, type Member } from "@tavrn/sdk";
import type { RoomPermissionData } from "../lib/memberPermissions";
import { dispatchSoundboard, setSoundboardVerifier, soundboardAllowed } from "./soundboardAuthorization";

const bits = (...values: bigint[]) => values.reduce((a, b) => a | b, 0n).toString();
const member = (roles: string[] = []): Member => ({ user: { id: "alice", address: "alice@n", kind: "user" }, roles } as Member);
const target = { domain: "n", roomId: "room", channelId: "voice" };
const room = (): RoomPermissionData => ({
  owner_id: "owner",
  roles: [
    { id: "everyone", is_everyone: true, permissions: bits(Permission.VIEW_CHANNEL, Permission.CONNECT, Permission.SPEAK) },
    { id: "dj", is_everyone: false, permissions: bits(Permission.USE_SOUNDBOARD) },
  ],
  channels: [{ id: "voice", category_id: "category" }],
  overrides: [],
});
const allowed = (r: RoomPermissionData | undefined = room(), members: Member[] | undefined = [member(["dj"])], channel = "voice", address = "alice@n") => soundboardAllowed(r, members, channel, address);
afterEach(() => setSoundboardVerifier(null));

describe("soundboard receiver authorization", () => {
  it("requires SPEAK and USE_SOUNDBOARD together", () => {
    expect(allowed()).toBe(true);
    expect(allowed(room(), [member()])).toBe(false);
    const r = room();
    r.roles[0]!.permissions = bits(Permission.VIEW_CHANNEL, Permission.CONNECT);
    expect(allowed(r)).toBe(false);
  });

  it("rejects unknown rooms, members and channels", () => {
    expect(soundboardAllowed(undefined, [member(["dj"])], "voice", "alice@n")).toBe(false);
    expect(soundboardAllowed(room(), undefined, "voice", "alice@n")).toBe(false);
    expect(allowed(room(), [], "voice")).toBe(false);
    expect(allowed(room(), [member(["dj"])], "missing")).toBe(false);
    expect(allowed(room(), [member(["dj"])], "voice", "unknown@n")).toBe(false);
  });

  it("honors category and channel role overrides and member overrides", () => {
    const r = room();
    r.overrides.push({ target_type: "category", target_id: "category", subject_type: "role", subject_id: "dj", allow: "0", deny: bits(Permission.USE_SOUNDBOARD) });
    expect(allowed(r)).toBe(false);
    r.overrides.push({ target_type: "channel", target_id: "voice", subject_type: "role", subject_id: "dj", allow: bits(Permission.USE_SOUNDBOARD), deny: "0" });
    expect(allowed(r)).toBe(true);
    r.overrides.push({ target_type: "channel", target_id: "voice", subject_type: "member", subject_id: "alice", allow: "0", deny: bits(Permission.SPEAK) });
    expect(allowed(r)).toBe(false);
  });

  it("recomputes permissions after revocation or timeout", () => {
    const r = room();
    const m = member(["dj"]);
    expect(allowed(r, [m])).toBe(true);
    m.roles = [];
    expect(allowed(r, [m])).toBe(false);
    m.roles = ["dj"];
    m.timeout_until = new Date(Date.now() + 60_000).toISOString();
    expect(allowed(r, [m])).toBe(false);
  });

  it("never shows an overlay for a speaker without soundboard permission or after revocation", () => {
    const show = vi.fn();
    const r = room();
    const m = member();
    let members = [m];
    setSoundboardVerifier((t, identity) => soundboardAllowed(r, members, t.channelId, identity.split("/")[0]!));
    const receive = () => dispatchSoundboard(target, "alice@n/device", () => true, show);
    receive();
    expect(show).not.toHaveBeenCalled();
    m.roles = ["dj"];
    receive();
    expect(show).toHaveBeenCalledOnce();
    m.roles = [];
    receive();
    members = [];
    receive();
    expect(show).toHaveBeenCalledOnce();
  });

  it("dispatches only verified signals of the current connected participant", () => {
    const show = vi.fn();
    const verify = vi.fn(() => true);
    dispatchSoundboard(target, "alice@n/device", () => true, show);
    expect(show).not.toHaveBeenCalled();
    setSoundboardVerifier(verify);
    // Model the exact lifetime predicate used by session.ts, including replacement with the same identity.
    const session = {};
    const participant = { identity: "alice@n/device" };
    let current: object = session;
    let connected = true;
    const participants = new Map([[participant.identity, participant]]);
    const isCurrent = () => current === session && connected && participants.get(participant.identity) === participant;
    current = {};
    dispatchSoundboard(target, participant.identity, isCurrent, show);
    current = session;
    connected = false;
    dispatchSoundboard(target, participant.identity, isCurrent, show);
    connected = true;
    participants.delete(participant.identity);
    dispatchSoundboard(target, participant.identity, isCurrent, show);
    participants.set(participant.identity, { identity: participant.identity });
    dispatchSoundboard(target, participant.identity, isCurrent, show);
    expect(verify).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    dispatchSoundboard({ ...target, call: true }, "alice@n/device", () => true, show);
    expect(show).not.toHaveBeenCalled();
    dispatchSoundboard(target, "alice@n/device", () => true, show);
    expect(show).toHaveBeenCalledOnce();
  });

  it("drops denied, failing and invalidated checks", () => {
    const show = vi.fn();
    for (const verify of [() => false, () => { throw new Error("cache unavailable"); }]) {
      setSoundboardVerifier(verify);
      dispatchSoundboard(target, "alice@n/device", () => true, show);
    }
    let current = true;
    setSoundboardVerifier(() => { current = false; return true; });
    dispatchSoundboard(target, "alice@n/device", () => current, show);
    expect(show).not.toHaveBeenCalled();
  });
});
