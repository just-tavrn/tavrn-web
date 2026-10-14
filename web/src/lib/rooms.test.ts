// SPDX-License-Identifier: Apache-2.0
// Who may remove departed members' MLS leaves in a room (ENCRYPTION.md §4.7): the own check and every member's.
import { describe, expect, it } from "vitest";
import { Permission, type Member, type RoomDetail } from "@tavrn/sdk";
import { mayManageRoom, roomManagers } from "./rooms";

const everyone = { id: "r-every", is_everyone: true, permissions: String(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES) };
const mods = { id: "r-mod", is_everyone: false, permissions: String(Permission.KICK_MEMBERS) };
const admins = { id: "r-admin", is_everyone: false, permissions: String(Permission.ADMINISTRATOR) };
const room = { owner_id: "u-owner", roles: [everyone, mods, admins], my_permissions: "0", is_owner: false } as unknown as RoomDetail;

function member(id: string, roles: string[] = [], kind = "user"): Member {
  return { roles, user: { id, address: `${id}@t.local`, kind } } as unknown as Member;
}

describe("roomManagers", () => {
  it("lists the owner and members whose roles allow kicking, banning, managing channels or everything", () => {
    const list = [member("u-owner"), member("u-plain"), member("u-mod", ["r-mod"]), member("u-admin", ["r-admin"]), member("u-bot", ["r-admin"], "bot")];
    expect(roomManagers(room, list)).toEqual(["u-owner@t.local", "u-mod@t.local", "u-admin@t.local"]);
  });

  it("is unknown without a member list", () => {
    expect(roomManagers(room, undefined)).toBeNull();
  });

  it("agrees with the own check", () => {
    expect(mayManageRoom({ ...room, my_permissions: String(Permission.MANAGE_CHANNELS) })).toBe(true);
    expect(mayManageRoom({ ...room, my_permissions: String(Permission.SEND_MESSAGES) })).toBe(false);
  });
});
