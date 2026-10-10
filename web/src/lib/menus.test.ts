// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS, Permission } from "@tavrn/sdk";
import { findEntry, staysOpen, type MenuEntry } from "../components/ContextMenu";
import { channelMenu, dmMenu, inviteRoomChoices, inviteToRoomEntry, memberMenu, messageMenu, notifyEntries, roomMenu, voiceParticipantMenu, type InviteRoomCandidate, type MemberMenuActions, type MemberMenuContext, type VoiceParticipantMenuActions } from "./menus";

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key);
const ids = (entries: MenuEntry[]) => entries.filter((e) => e.kind !== "separator").map((e) => e.id);

const memberActions = (): MemberMenuActions => ({
  profile: vi.fn(),
  message: vi.fn(),
  call: vi.fn(),
  addFriend: vi.fn(),
  mention: vi.fn(),
  copyAddress: vi.fn(),
  kick: vi.fn(),
  ban: vi.fn(),
  timeout: vi.fn(),
  clearTimeout: vi.fn(),
  serverMute: vi.fn(),
  disconnect: vi.fn(),
  moveTo: vi.fn(),
  toggleRole: vi.fn(),
  volume: (v) => ({ kind: "custom", id: "volume", render: () => String(v) }),
  block: vi.fn(),
});

const roles = [
  { id: "everyone", name: "@everyone", position: 0, is_everyone: true },
  { id: "admin", name: "Admin", position: 10, is_everyone: false },
  { id: "mod", name: "Mod", position: 5, is_everyone: false },
  { id: "member", name: "Member", position: 1, is_everyone: false },
];

const ctx = (over: Partial<MemberMenuContext> = {}): MemberMenuContext => ({
  self: false,
  target: { address: "bob@x", name: "Bob", isOwner: false, top: 1, roles: ["member"], timedOut: false, bot: false },
  room: { perms: Permission.KICK_MEMBERS | Permission.BAN_MEMBERS | Permission.MODERATE_MEMBERS | Permission.MANAGE_ROLES, isOwner: false, myTop: 5, roles },
  friend: false,
  friendPending: false,
  callsAvailable: false,
  canMention: true,
  ...over,
});

describe("memberMenu", () => {
  it("offers the everyday items and, for a moderator above the target, moderation", () => {
    const entries = memberMenu(ctx(), memberActions(), t);
    expect(ids(entries)).toEqual(["profile", "message", "call", "add-friend", "mention", "copy-address", "roles", "timeout", "kick", "ban", "block"]);
    expect(findEntry(entries, "call")).toMatchObject({ disabled: true, reason: "menu.reason.calls_soon" });
    expect(findEntry(entries, "kick")?.disabled).toBeFalsy();
  });

  it("hides moderation without the permission and disables it (with the reason) against higher members", () => {
    expect(ids(memberMenu(ctx({ room: { perms: 0n, isOwner: false, myTop: 5, roles } }), memberActions(), t))).not.toContain("kick");
    const above = memberMenu(ctx({ target: { address: "a@x", name: "A", isOwner: false, top: 10, roles: ["admin"], timedOut: false, bot: false } }), memberActions(), t);
    expect(findEntry(above, "kick")).toMatchObject({ disabled: true, reason: "menu.reason.hierarchy" });
    expect(findEntry(above, "ban")).toMatchObject({ disabled: true });
    const owner = memberMenu(ctx({ target: { address: "o@x", name: "O", isOwner: true, top: 0, roles: [], timedOut: false, bot: false } }), memberActions(), t);
    expect(findEntry(owner, "kick")).toMatchObject({ disabled: true, reason: "menu.reason.owner" });
  });

  it("never offers moderation, friend or block items on oneself", () => {
    const entries = memberMenu(ctx({ self: true }), memberActions(), t);
    expect(ids(entries)).toEqual(["profile", "mention", "copy-address", "roles"]);
  });

  it("checks the roles of the target and locks roles at or above the own one", () => {
    const toggle = vi.fn();
    const actions = { ...memberActions(), toggleRole: toggle };
    const entries = memberMenu(ctx(), actions, t);
    expect(findEntry(entries, "role-member")).toMatchObject({ checked: true, keepOpen: true });
    expect(findEntry(entries, "role-admin")).toMatchObject({ checked: false, disabled: true, reason: "menu.reason.role_above" });
    expect(findEntry(entries, "role-mod")).toMatchObject({ disabled: true });
    const member = findEntry(entries, "role-member");
    if (member?.kind === "item") member.onSelect?.();
    expect(toggle).toHaveBeenCalledWith("member", false);
    // The owner may assign every role.
    const owner = memberMenu(ctx({ room: { perms: ALL_PERMISSIONS, isOwner: true, myTop: Number.MAX_SAFE_INTEGER, roles } }), memberActions(), t);
    expect(findEntry(owner, "role-admin")?.disabled).toBeFalsy();
  });

  it("offers timeouts with durations, or removing a running one", () => {
    const entries = memberMenu(ctx(), memberActions(), t);
    const timeout = findEntry(entries, "timeout");
    expect(timeout?.kind === "submenu" && timeout.items.map((e) => e.id)).toEqual(["timeout-1", "timeout-5", "timeout-10", "timeout-60", "timeout-1440", "timeout-10080"]);
    const running = memberMenu(ctx({ target: { address: "b@x", name: "B", isOwner: false, top: 1, roles: [], timedOut: true, bot: false } }), memberActions(), t);
    expect(ids(running)).toContain("timeout-clear");
  });

  it("adds voice moderation and the volume slider for members in voice", () => {
    const voice = { channelId: "v1", serverMuted: false, channels: [{ id: "v2", name: "Raid" }], inMyCall: true, volume: 150 };
    const mod = memberMenu(ctx({ voice, room: { perms: Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS, isOwner: false, myTop: 5, roles } }), memberActions(), t);
    expect(ids(mod)).toEqual(expect.arrayContaining(["volume", "server-mute", "server-deafen", "disconnect", "move"]));
    expect(findEntry(mod, "server-deafen")).toMatchObject({ disabled: true, reason: "menu.reason.not_supported" });
    const move = findEntry(mod, "move");
    expect(move?.kind === "submenu" && move.items.map((e) => e.id)).toEqual(["move-v2"]);
    const plain = memberMenu(ctx({ voice: { ...voice, inMyCall: false }, room: { perms: 0n, isOwner: false, myTop: 0, roles } }), memberActions(), t);
    expect(ids(plain)).not.toContain("volume");
    expect(ids(plain)).not.toContain("disconnect");
  });

  it("adds the stream volume next to the voice volume while the member streams (issue #20)", () => {
    const voice = { channelId: "v1", serverMuted: false, channels: [], inMyCall: true, volume: 100, streaming: true, streamVolume: 60 };
    const a = { ...memberActions(), streamVolume: (v: number): MenuEntry => ({ kind: "custom", id: "stream-volume", render: () => String(v) }) };
    const entries = memberMenu(ctx({ voice }), a, t);
    const order = ids(entries);
    expect(order.indexOf("stream-volume")).toBe(order.indexOf("volume") + 1);
    expect(ids(memberMenu(ctx({ voice: { ...voice, streaming: false } }), a, t))).not.toContain("stream-volume");
    expect(ids(memberMenu(ctx({ voice: { ...voice, inMyCall: false } }), a, t))).not.toContain("stream-volume");
    expect(ids(memberMenu(ctx({ self: true, voice }), a, t))).not.toContain("stream-volume");
  });
});

describe("voice participant menus (design note 4.13 item 3)", () => {
  it("the member menu of a voice participant adds 'copy id'; the member list keeps its entries", () => {
    const copyId = vi.fn();
    const entries = memberMenu(ctx(), { ...memberActions(), copyId }, t);
    expect(ids(entries).slice(0, 7)).toEqual(["profile", "message", "call", "add-friend", "mention", "copy-address", "copy-id"]);
    const item = findEntry(entries, "copy-id");
    if (item?.kind === "item") item.onSelect?.();
    expect(copyId).toHaveBeenCalled();
    expect(ids(memberMenu(ctx(), memberActions(), t))).not.toContain("copy-id");
  });

  const actions = (): VoiceParticipantMenuActions => ({
    volume: (v) => ({ kind: "custom", id: "volume", render: () => String(v) }),
    serverMute: vi.fn(),
    disconnect: vi.fn(),
    moveTo: vi.fn(),
    copyAddress: vi.fn(),
    copyId: vi.fn(),
  });
  const base = { self: false, perms: 0n, serverMuted: false, inMyCall: true, volume: 100, channels: [{ id: "v2", name: "Raid" }] };

  it("reduced menu for participants without a loaded member: volume, mute, disconnect, move, copy", () => {
    const mod = voiceParticipantMenu({ ...base, perms: Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS }, actions(), t);
    expect(ids(mod)).toEqual(["volume", "server-mute", "server-deafen", "disconnect", "move", "copy-address", "copy-id"]);
    expect(findEntry(mod, "server-deafen")).toMatchObject({ disabled: true });
    const a = actions();
    const muted = voiceParticipantMenu({ ...base, perms: Permission.MUTE_MEMBERS, serverMuted: true }, a, t);
    const unmute = findEntry(muted, "server-mute");
    expect(unmute?.label).toBe("menu.member.server_unmute");
    if (unmute?.kind === "item") unmute.onSelect?.();
    expect(a.serverMute).toHaveBeenCalledWith(false);
  });

  it("without permissions only volume and copy; never moderation or volume on oneself", () => {
    expect(ids(voiceParticipantMenu(base, actions(), t))).toEqual(["volume", "copy-address", "copy-id"]);
    expect(ids(voiceParticipantMenu({ ...base, inMyCall: false }, actions(), t))).toEqual(["copy-address", "copy-id"]);
    expect(ids(voiceParticipantMenu({ ...base, self: true, perms: ALL_PERMISSIONS }, actions(), t))).toEqual(["copy-address", "copy-id"]);
    // No other voice channel: no move submenu.
    expect(ids(voiceParticipantMenu({ ...base, perms: Permission.MOVE_MEMBERS, channels: [] }, actions(), t))).not.toContain("move");
  });

  it("the reduced menu also offers the stream volume while the participant streams (issue #20)", () => {
    const a = { ...actions(), streamVolume: (v: number): MenuEntry => ({ kind: "custom", id: "stream-volume", render: () => String(v) }) };
    expect(ids(voiceParticipantMenu({ ...base, streaming: true, streamVolume: 80 }, a, t))).toEqual(["volume", "stream-volume", "copy-address", "copy-id"]);
    expect(ids(voiceParticipantMenu({ ...base, streaming: false, streamVolume: 80 }, a, t))).toEqual(["volume", "copy-address", "copy-id"]);
    expect(ids(voiceParticipantMenu({ ...base, self: true, streaming: true, streamVolume: 80 }, a, t))).toEqual(["copy-address", "copy-id"]);
  });
});

describe("messageMenu", () => {
  const actions = { reply: vi.fn(), react: vi.fn(), copyText: vi.fn(), copyLink: vi.fn(), copyId: vi.fn(), pin: vi.fn(), edit: vi.fn(), remove: vi.fn(), markUnread: vi.fn() };
  const base = { own: false, text: "hi", pinned: false, canPin: true, canReact: true, canManage: false, canReply: true, canEdit: true, canDelete: true };

  it("lets authors edit and delete, moderators delete others' messages", () => {
    expect(ids(messageMenu({ ...base, own: true }, actions, t))).toEqual(["reply", "react", "copy-text", "copy-link", "copy-id", "mark-unread", "pin", "edit", "delete"]);
    expect(ids(messageMenu(base, actions, t))).not.toContain("delete");
    const mod = messageMenu({ ...base, canManage: true }, actions, t);
    expect(findEntry(mod, "delete")?.label).toBe("menu.message.delete_mod");
    expect(ids(mod)).not.toContain("edit");
  });

  it("offers threads (PROTOCOL.md §7e): create and reply in thread, or only reply once the message has one", () => {
    const thread = { ...actions, createThread: vi.fn(), replyInThread: vi.fn() };
    expect(ids(messageMenu({ ...base, canThread: true }, thread, t)).slice(0, 3)).toEqual(["reply", "create-thread", "reply-in-thread"]);
    expect(ids(messageMenu({ ...base, canThread: true, hasThread: true }, thread, t))).not.toContain("create-thread");
    expect(ids(messageMenu({ ...base, canThread: false, hasThread: true }, thread, t))).toContain("reply-in-thread");
    expect(ids(messageMenu({ ...base, canThread: false }, thread, t))).not.toContain("reply-in-thread");
    expect(ids(messageMenu({ ...base, canThread: true }, actions, t))).not.toContain("create-thread");
    const entry = findEntry(messageMenu({ ...base, canThread: true }, thread, t), "create-thread");
    if (entry?.kind === "item") entry.onSelect?.();
    expect(thread.createThread).toHaveBeenCalled();
  });

  it("toggles pin/unpin and hides text items for undecryptable messages", () => {
    const pinned = messageMenu({ ...base, pinned: true }, actions, t);
    expect(findEntry(pinned, "pin")?.label).toBe("menu.message.unpin");
    const p = findEntry(pinned, "pin");
    if (p?.kind === "item") p.onSelect?.();
    expect(actions.pin).toHaveBeenCalledWith(false);
    expect(ids(messageMenu({ ...base, text: null, canPin: false, canReact: false }, actions, t))).toEqual(["reply", "copy-link", "copy-id", "mark-unread"]);
  });
});

describe("notification and list menus", () => {
  const notify = { mode: null, inherited: "mentions" as const, mutedUntil: null };
  const notifyActions = { setMode: vi.fn(), mute: vi.fn(), unmute: vi.fn() };

  it("offers modes with the inherited default and mute durations, or unmute while muted", () => {
    const entries = notifyEntries("channel", notify, notifyActions, t);
    const modes = findEntry(entries, "channel-notify");
    expect(modes?.kind === "submenu" && modes.items.map((e) => e.id)).toEqual(["channel-mode-default", "channel-mode-all", "channel-mode-mentions", "channel-mode-nothing"]);
    expect(findEntry(entries, "channel-mode-default")).toMatchObject({ checked: true });
    const mute = findEntry(entries, "channel-mute");
    expect(mute?.kind === "submenu" && mute.items.map((e) => e.id)).toEqual(["channel-mute-1", "channel-mute-8", "channel-mute-24", "channel-mute-0"]);
    const muted = notifyEntries("channel", { ...notify, mutedUntil: new Date(Date.now() + 3_600_000).toISOString() }, notifyActions, t);
    expect(ids(muted)).toContain("channel-unmute");
  });

  it("offers \"keep the full history on this device\" only where it applies (encrypted, unlocked)", () => {
    const toggleFullHistory = vi.fn();
    const actions = { ...notifyActions, markRead: vi.fn(), edit: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), copyLink: vi.fn(), copyId: vi.fn(), moveEveryoneHere: vi.fn(), moveEveryoneTo: vi.fn(), toggleFullHistory };
    const off = channelMenu({ kind: "text", unread: false, canManage: false, system: false, notify, fullHistory: false }, actions, t);
    expect(ids(off)).toEqual(["mark-read", "channel-notify", "channel-mute", "full-history", "copy-link", "copy-id"]);
    expect(findEntry(off, "full-history")).toMatchObject({ checked: false, label: "menu.full_history" });
    const entry = findEntry(off, "full-history");
    if (entry?.kind === "item") entry.onSelect?.();
    expect(toggleFullHistory).toHaveBeenCalled();
    expect(findEntry(channelMenu({ kind: "text", unread: false, canManage: false, system: false, notify, fullHistory: true }, actions, t), "full-history")).toMatchObject({ checked: true });
    expect(ids(channelMenu({ kind: "text", unread: false, canManage: false, system: false, notify, fullHistory: null }, actions, t))).not.toContain("full-history");
    const dmActions = { ...notifyActions, markRead: vi.fn(), profile: vi.fn(), close: vi.fn(), block: vi.fn(), copyAddress: vi.fn(), toggleFullHistory };
    expect(ids(dmMenu({ unread: false, kind: "dm", peer: null, notify, fullHistory: true }, dmActions, t))).toContain("full-history");
    expect(ids(dmMenu({ unread: false, kind: "dm", peer: null, notify }, dmActions, t))).not.toContain("full-history");
    // While on, the label shows how much the conversation takes on this device (#4).
    expect(findEntry(channelMenu({ kind: "text", unread: false, canManage: false, system: false, notify, fullHistory: true, fullHistoryUsage: "3.2 MB / 50.0 MB" }, actions, t), "full-history")).toMatchObject({ checked: true, label: 'menu.full_history_usage:{"usage":"3.2 MB / 50.0 MB"}' });
    expect(findEntry(dmMenu({ unread: false, kind: "dm", peer: null, notify, fullHistory: true, fullHistoryUsage: "1.0 KB / 50.0 MB" }, dmActions, t), "full-history")).toMatchObject({ label: 'menu.full_history_usage:{"usage":"1.0 KB / 50.0 MB"}' });
  });

  it("gates channel management and voice moving", () => {
    const actions = { ...notifyActions, markRead: vi.fn(), edit: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), copyLink: vi.fn(), copyId: vi.fn(), moveEveryoneHere: vi.fn(), moveEveryoneTo: vi.fn() };
    const member = channelMenu({ kind: "text", unread: false, canManage: false, system: false, notify }, actions, t);
    expect(ids(member)).toEqual(["mark-read", "channel-notify", "channel-mute", "copy-link", "copy-id"]);
    expect(findEntry(member, "mark-read")).toMatchObject({ disabled: true });
    const admin = channelMenu({ kind: "text", unread: true, canManage: true, system: false, notify }, actions, t);
    expect(ids(admin)).toEqual(expect.arrayContaining(["edit", "duplicate", "delete"]));
    const welcome = channelMenu({ kind: "system", unread: false, canManage: true, system: true, notify }, actions, t);
    expect(ids(welcome)).not.toContain("delete");
  });

  it("gives voice channels the text channel menu plus the mass moves (move_members)", () => {
    const actions = { ...notifyActions, markRead: vi.fn(), edit: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), copyLink: vi.fn(), copyId: vi.fn(), moveEveryoneHere: vi.fn(), moveEveryoneTo: vi.fn() };
    // Without move_members: exactly the entries of a text channel.
    const plain = channelMenu({ kind: "voice", unread: false, canManage: false, system: false, notify }, actions, t);
    expect(ids(plain)).toEqual(["mark-read", "channel-notify", "channel-mute", "copy-link", "copy-id"]);
    const voiceMove = { elsewhere: 3, here: 2, targets: [{ id: "v2", name: "Raid" }, { id: "v3", name: "AFK" }] };
    const mod = channelMenu({ kind: "voice", unread: false, canManage: true, system: false, voiceMove, notify }, actions, t);
    expect(ids(mod)).toEqual(["mark-read", "channel-notify", "channel-mute", "move-here", "move-from", "edit", "duplicate", "copy-link", "copy-id", "delete"]);
    expect(findEntry(mod, "move-here")).toMatchObject({ label: `menu.channel.move_here_count:{"count":3}`, disabled: false });
    const from = findEntry(mod, "move-from");
    expect(from?.kind === "submenu" && from.items.map((e) => e.id)).toEqual(["move-to-v2", "move-to-v3"]);
    const target = from?.kind === "submenu" ? from.items[1] : undefined;
    if (target?.kind === "item") target.onSelect?.();
    expect(actions.moveEveryoneTo).toHaveBeenCalledWith("v3");
    // Nobody to move: disabled with the reason; no other voice channel: no submenu.
    const empty = channelMenu({ kind: "voice", unread: false, canManage: false, system: false, voiceMove: { elsewhere: 0, here: 0, targets: [] }, notify }, actions, t);
    expect(findEntry(empty, "move-here")).toMatchObject({ disabled: true, reason: "menu.reason.nobody_elsewhere" });
    expect(ids(empty)).not.toContain("move-from");
    const nobodyHere = channelMenu({ kind: "voice", unread: false, canManage: false, system: false, voiceMove: { ...voiceMove, here: 0 }, notify }, actions, t);
    expect(findEntry(nobodyHere, "move-from")).toMatchObject({ disabled: true, reason: "menu.reason.nobody_here" });
    // The voice entries never show up on text channels.
    expect(ids(channelMenu({ kind: "text", unread: false, canManage: false, system: false, voiceMove, notify }, actions, t))).not.toContain("move-here");
  });

  it("puts invite and settings first; open reports show on the settings entry", () => {
    const actions = { ...notifyActions, setSuppressEveryone: vi.fn(), markRead: vi.fn(), invite: vi.fn(), settings: vi.fn(), leave: vi.fn(), copyId: vi.fn() };
    const plain = roomMenu({ unread: false, canInvite: true, isOwner: false, notify }, actions, t);
    expect(ids(plain).slice(0, 3)).toEqual(["invite", "settings", "mark-read"]);
    const settings = findEntry(plain, "settings");
    expect(settings).toMatchObject({ testId: "room-settings-button" });
    expect(settings?.hint).toBeUndefined();
    expect(settings?.kind === "item" && settings.ariaLabel).toBeFalsy();
    expect(ids(roomMenu({ unread: false, canInvite: false, isOwner: false, notify }, actions, t))[0]).toBe("settings");
    const many = roomMenu({ unread: false, canInvite: true, isOwner: false, notify, openReports: "3" }, actions, t);
    expect(findEntry(many, "settings")).toMatchObject({ hint: "3", hintBadge: true, ariaLabel: 'menu.room.settings · reports.open_reports_many:{"count":"3"}' });
    const one = roomMenu({ unread: false, canInvite: true, isOwner: false, notify, openReports: "1" }, actions, t);
    expect(findEntry(one, "settings")).toMatchObject({ ariaLabel: 'menu.room.settings · reports.open_reports_one:{"count":"1"}' });
  });

  it("does not let owners leave their room; DMs can be closed and blocked", () => {
    const actions = { ...notifyActions, setSuppressEveryone: vi.fn(), markRead: vi.fn(), invite: vi.fn(), settings: vi.fn(), leave: vi.fn(), copyId: vi.fn() };
    const owner = roomMenu({ unread: true, canInvite: true, isOwner: true, notify: { ...notify, suppressEveryone: false } }, actions, t);
    expect(findEntry(owner, "leave")).toMatchObject({ disabled: true, reason: "menu.reason.owner_leave" });
    expect(findEntry(owner, "room-suppress-everyone")).toMatchObject({ checked: false });
    const dm = dmMenu({ unread: true, kind: "dm", peer: { address: "b@x", name: "B" }, notify }, { ...notifyActions, markRead: vi.fn(), profile: vi.fn(), close: vi.fn(), block: vi.fn(), copyAddress: vi.fn() }, t);
    expect(ids(dm)).toEqual(["mark-read", "profile", "copy-address", "dm-notify", "dm-mute", "close", "block"]);
    const group = dmMenu({ unread: false, kind: "group", peer: null, notify }, { ...notifyActions, markRead: vi.fn(), profile: vi.fn(), close: vi.fn(), block: vi.fn(), copyAddress: vi.fn() }, t);
    expect(ids(group)).not.toContain("block");
  });
});

describe("which entries keep the menu open (state changes, like the voice quick menus)", () => {
  /** Ids of all items (submenus included) whose choice keeps the menu open, and of those that close it. */
  const split = (entries: MenuEntry[]) => {
    const open: string[] = [];
    const close: string[] = [];
    const walk = (list: MenuEntry[]) =>
      list.forEach((e) => {
        if (e.kind === "submenu") walk(e.items);
        else if (e.kind === "item") (staysOpen(e) ? open : close).push(e.id);
      });
    walk(entries);
    return { open, close };
  };
  const notify = { mode: null, inherited: "mentions" as const, mutedUntil: null, suppressEveryone: false };
  const notifyActions = { setMode: vi.fn(), mute: vi.fn(), unmute: vi.fn(), setSuppressEveryone: vi.fn() };

  it("notification modes, @everyone, the mute durations and unmute stay open; navigation and leave close", () => {
    const actions = { ...notifyActions, markRead: vi.fn(), invite: vi.fn(), settings: vi.fn(), leave: vi.fn(), copyId: vi.fn(), report: vi.fn() };
    const room = split(roomMenu({ unread: true, canInvite: true, isOwner: false, notify, canReport: true }, actions, t));
    expect(room.open).toEqual(["room-mode-default", "room-mode-all", "room-mode-mentions", "room-mode-nothing", "room-suppress-everyone", "room-mute-1", "room-mute-8", "room-mute-24", "room-mute-0"]);
    expect(room.close).toEqual(["invite", "settings", "mark-read", "copy-id", "report", "leave"]);
    const muted = split(roomMenu({ unread: false, canInvite: false, isOwner: false, notify: { ...notify, mutedUntil: new Date(Date.now() + 3_600_000).toISOString() } }, actions, t));
    expect(muted.open).toContain("room-unmute");
  });

  it("channels and DMs: the notification entries and the full-history toggle stay open, the rest closes", () => {
    // @everyone is a room setting only.
    const notify = { mode: "all" as const, inherited: "mentions" as const, mutedUntil: null };
    const actions = { ...notifyActions, markRead: vi.fn(), edit: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), copyLink: vi.fn(), copyId: vi.fn(), moveEveryoneHere: vi.fn(), moveEveryoneTo: vi.fn(), toggleFullHistory: vi.fn() };
    const voiceMove = { elsewhere: 1, here: 1, targets: [{ id: "v2", name: "Raid" }] };
    const channel = split(channelMenu({ kind: "voice", unread: true, canManage: true, system: false, voiceMove, notify, fullHistory: false }, actions, t));
    expect(channel.open).toEqual(["channel-mode-default", "channel-mode-all", "channel-mode-mentions", "channel-mode-nothing", "channel-mute-1", "channel-mute-8", "channel-mute-24", "channel-mute-0", "full-history"]);
    expect(channel.close).toEqual(["mark-read", "move-here", "move-to-v2", "edit", "duplicate", "copy-link", "copy-id", "delete"]);
    const dm = split(dmMenu({ unread: true, kind: "dm", peer: { address: "b@x", name: "B" }, notify, fullHistory: true }, { ...notifyActions, markRead: vi.fn(), profile: vi.fn(), close: vi.fn(), block: vi.fn(), copyAddress: vi.fn(), toggleFullHistory: vi.fn() }, t));
    expect(dm.open).toEqual(["dm-mode-default", "dm-mode-all", "dm-mode-mentions", "dm-mode-nothing", "dm-mute-1", "dm-mute-8", "dm-mute-24", "dm-mute-0", "full-history"]);
    expect(dm.close).toEqual(["mark-read", "profile", "copy-address", "close", "block"]);
  });

  it("members: role toggles and server mute stay open; profile, messages, moderation and block close", () => {
    const voice = { channelId: "v1", serverMuted: false, channels: [{ id: "v2", name: "Raid" }], inMyCall: false, volume: 100 };
    const perms = Permission.MANAGE_ROLES | Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS | Permission.MODERATE_MEMBERS | Permission.KICK_MEMBERS | Permission.BAN_MEMBERS;
    const member = split(memberMenu(ctx({ voice, canReport: true, room: { perms, isOwner: true, myTop: 100, roles } }), { ...memberActions(), report: vi.fn() }, t));
    expect(member.open).toEqual(["role-admin", "role-mod", "role-member", "server-mute"]);
    expect(member.close).toEqual(["profile", "message", "call", "add-friend", "mention", "copy-address", "server-deafen", "disconnect", "move-v2", "timeout-1", "timeout-5", "timeout-10", "timeout-60", "timeout-1440", "timeout-10080", "kick", "ban", "report", "block"]);
    const participant = split(voiceParticipantMenu({ self: false, perms: Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS, serverMuted: true, inMyCall: true, volume: 100, channels: [] }, { volume: (v) => ({ kind: "custom", id: "volume", render: () => String(v) }), serverMute: vi.fn(), disconnect: vi.fn(), moveTo: vi.fn(), copyAddress: vi.fn(), copyId: vi.fn() }, t));
    expect(participant.open).toEqual(["server-mute"]);
  });

  it("messages: every entry closes (replies, reactions, copies, pin, edit and delete act on the message)", () => {
    const actions = { reply: vi.fn(), react: vi.fn(), copyText: vi.fn(), copyLink: vi.fn(), copyId: vi.fn(), pin: vi.fn(), edit: vi.fn(), remove: vi.fn(), markUnread: vi.fn() };
    const message = split(messageMenu({ own: true, text: "hi", pinned: false, canPin: true, canReact: true, canManage: false, canReply: true, canEdit: true, canDelete: true }, actions, t));
    expect(message.open).toEqual([]);
  });
});

describe("invite to room (direct invites, FEDERATION.md §3.4)", () => {
  const room = (id: string, name: string, over: Partial<InviteRoomCandidate> = {}): InviteRoomCandidate => ({ id, name, node: null, perms: Permission.CREATE_INVITES, isOwner: false, ...over });
  const rooms = [
    room("R1", "Gilde"),
    room("R2", "Ohne Einladen", { perms: Permission.SEND_MESSAGES }),
    room("R3", "Eigener Raum", { perms: 0n, isOwner: true }),
    room("R4", "Admins", { perms: Permission.ADMINISTRATOR }),
    room("R5", "Noch nicht geladen", { perms: null }),
    room("R6", "Bob ist schon da", { members: ["bob@x"] }),
    room("R7", "Anderer Knoten", { node: "other.example" }),
  ];

  it("lists the rooms where the user may create invites, without those the target is known to be in, sorted by name", () => {
    expect(inviteRoomChoices(rooms, "bob@x").map((r) => r.id)).toEqual(["R4", "R7", "R3", "R1"]);
    // Rooms named by the caller (the current room of a member menu) are left out too.
    expect(inviteRoomChoices(rooms, "bob@x", ["R1", "R4"]).map((r) => r.id)).toEqual(["R7", "R3"]);
    // Another target is not a member of R6.
    expect(inviteRoomChoices(rooms, "carl@x").map((r) => r.id)).toContain("R6");
  });

  it("builds a submenu whose items invite into the room and close the menu; remote rooms show their node", () => {
    const invite = vi.fn();
    const entry = inviteToRoomEntry(rooms, "bob@x", invite, t);
    expect(entry).toMatchObject({ kind: "submenu", id: "invite-room", label: "menu.invite_room" });
    expect(entry?.kind === "submenu" && entry.items.map((i) => i.id)).toEqual(["invite-room-R4", "invite-room-R7", "invite-room-R3", "invite-room-R1"]);
    const remote = findEntry([entry!], "invite-room-R7");
    expect(remote).toMatchObject({ label: "Anderer Knoten", hint: "other.example" });
    if (remote?.kind === "item") {
      expect(staysOpen(remote)).toBe(false);
      remote.onSelect?.();
    }
    expect(invite).toHaveBeenCalledWith(expect.objectContaining({ id: "R7", node: "other.example" }));
  });

  it("has no submenu when no room qualifies", () => {
    expect(inviteToRoomEntry([room("R2", "x", { perms: 0n })], "bob@x", vi.fn(), t)).toBeNull();
    expect(inviteToRoomEntry([], "bob@x", vi.fn(), t)).toBeNull();
  });

  it("the member menu offers it for others (not oneself, not bots) when rooms qualify", () => {
    const inviteToRoom = vi.fn();
    const actions = { ...memberActions(), inviteToRoom };
    const entries = memberMenu(ctx({ inviteRooms: rooms }), actions, t);
    expect(ids(entries)).toEqual(["profile", "message", "call", "add-friend", "invite-room", "mention", "copy-address", "roles", "timeout", "kick", "ban", "block"]);
    const item = findEntry(entries, "invite-room-R1");
    if (item?.kind === "item") item.onSelect?.();
    expect(inviteToRoom).toHaveBeenCalledWith(expect.objectContaining({ id: "R1" }));
    expect(ids(memberMenu(ctx({ self: true, inviteRooms: rooms }), actions, t))).not.toContain("invite-room");
    expect(ids(memberMenu(ctx({ inviteRooms: rooms, target: { address: "bot@x", name: "Bot", isOwner: false, top: 0, roles: [], timedOut: false, bot: true } }), actions, t))).not.toContain("invite-room");
    expect(ids(memberMenu(ctx({ inviteRooms: [room("R2", "x", { perms: 0n })] }), actions, t))).not.toContain("invite-room");
    expect(ids(memberMenu(ctx(), actions, t))).not.toContain("invite-room");
  });
});
