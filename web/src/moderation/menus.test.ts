// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Permission } from "@tavrn/sdk";
import type { MenuEntry } from "../components/ContextMenu";
import { memberMenu, messageMenu, roomMenu, type MemberMenuContext, type MessageMenuContext, type RoomMenuContext } from "../lib/menus";

const t = (key: string) => key;
const ids = (entries: MenuEntry[]) => entries.filter((e) => e.kind !== "separator").map((e) => e.id);
const fn = () => vi.fn();

describe("report entries of the context menus (MODERATION.md)", () => {
  const message = (over: Partial<MessageMenuContext> = {}): MessageMenuContext => ({ own: false, text: "hi", pinned: false, canPin: false, canReact: false, canManage: false, canReply: false, canEdit: false, canDelete: false, canReport: true, ...over });
  const messageActions = { reply: fn(), react: fn(), copyText: fn(), copyLink: fn(), copyId: fn(), pin: fn(), edit: fn(), remove: fn(), markUnread: fn(), report: fn() };

  it("offers reporting others' messages on nodes that take reports", () => {
    expect(ids(messageMenu(message(), messageActions, t)).at(-1)).toBe("report");
    expect(ids(messageMenu(message({ own: true }), messageActions, t))).not.toContain("report");
    expect(ids(messageMenu(message({ canReport: false }), messageActions, t))).not.toContain("report");
    expect(ids(messageMenu(message(), { ...messageActions, report: undefined }, t))).not.toContain("report");
  });

  it("hides deleting where it is not allowed (welcome entries are passed without canDelete)", () => {
    expect(ids(messageMenu(message({ canDelete: false, canManage: true }), messageActions, t))).not.toContain("delete");
    expect(ids(messageMenu(message({ canDelete: true, canManage: true }), messageActions, t))).toContain("delete");
  });

  it("offers reporting members but not oneself", () => {
    const ctx = (over: Partial<MemberMenuContext>): MemberMenuContext => ({
      self: false,
      target: { address: "bob@x", name: "Bob", isOwner: false, top: 0, roles: [], timedOut: false, bot: false },
      room: { perms: Permission.VIEW_CHANNEL, isOwner: false, myTop: 0, roles: [] },
      friend: false,
      friendPending: false,
      callsAvailable: false,
      canMention: false,
      canReport: true,
      ...over,
    });
    const actions = { profile: fn(), message: fn(), call: fn(), addFriend: fn(), mention: fn(), copyAddress: fn(), kick: fn(), ban: fn(), timeout: fn(), clearTimeout: fn(), serverMute: fn(), disconnect: fn(), moveTo: fn(), toggleRole: fn(), volume: () => ({ kind: "separator", id: "v" }) as MenuEntry, block: fn(), report: fn() };
    const entries = ids(memberMenu(ctx({}), actions, t));
    expect(entries.slice(-2)).toEqual(["report", "block"]);
    expect(ids(memberMenu(ctx({ self: true }), actions, t))).not.toContain("report");
    expect(ids(memberMenu(ctx({ canReport: false }), actions, t))).not.toContain("report");
  });

  it("offers reporting a room to everybody but its owner", () => {
    const notify = { mode: null, inherited: "all" as const, mutedUntil: null };
    const ctx = (over: Partial<RoomMenuContext>): RoomMenuContext => ({ unread: false, canInvite: false, isOwner: false, notify, canReport: true, ...over });
    const actions = { markRead: fn(), invite: fn(), settings: fn(), leave: fn(), copyId: fn(), report: fn(), setMode: fn(), mute: fn(), unmute: fn() };
    expect(ids(roomMenu(ctx({}), actions, t))).toContain("report");
    expect(ids(roomMenu(ctx({ isOwner: true }), actions, t))).not.toContain("report");
    expect(ids(roomMenu(ctx({ canReport: false }), actions, t))).not.toContain("report");
  });
});
