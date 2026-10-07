// SPDX-License-Identifier: Apache-2.0
/**
 * The context menu models (design note 4.11): which entries members, messages, channels, rooms and DMs offer
 * and which are disabled (with the reason), from permissions and the role hierarchy. Pure functions over a
 * context and the actions, so the gating is unit-tested; the components in `components/menus` gather the
 * context and run the actions.
 */
import { Permission, hasPermission } from "@tavrn/sdk";
import { menuItem, normalizeMenu, separator, submenu, type MenuEntry } from "../components/ContextMenu";
import type { NotificationMode } from "@tavrn/sdk";

type T = (key: string, params?: Record<string, string | number>) => string;

/** Timeout choices in minutes (the node takes 1 … 40320). */
export const TIMEOUT_CHOICES = [1, 5, 10, 60, 1440, 10080] as const;
/** Mute choices: hours, `0` = until turned off. */
export const MUTE_CHOICES = [1, 8, 24, 0] as const;
/** Quick reactions of the message menu. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"] as const;

// ---- Members --------------------------------------------------------------------------------

export interface MemberMenuContext {
  self: boolean;
  target: { address: string; name: string; isOwner: boolean; top: number; roles: string[]; timedOut: boolean; bot: boolean };
  /** Absent outside rooms (DM member lists, friends). */
  room?: {
    perms: bigint;
    isOwner: boolean;
    myTop: number;
    roles: { id: string; name: string; position: number; is_everyone: boolean; color?: string | null }[];
  };
  /** The voice channel the target is in (this room), with the other voice channels. */
  voice?: { channelId: string; serverMuted: boolean; channels: { id: string; name: string }[]; inMyCall: boolean; volume: number };
  friend: boolean;
  friendPending: boolean;
  /** DM/group calls exist (phase 4E track V); until then the item is disabled. */
  callsAvailable: boolean;
  /** Mentions only make sense where a composer is open. */
  canMention: boolean;
  /** The node takes reports (`reports.v1`, MODERATION.md). */
  canReport?: boolean;
}

export interface MemberMenuActions {
  profile: () => void;
  message: () => void;
  call: () => void;
  addFriend: () => void;
  mention: () => void;
  copyAddress: () => void;
  kick: () => void;
  ban: () => void;
  timeout: (minutes: number) => void;
  clearTimeout: () => void;
  serverMute: (muted: boolean) => void;
  disconnect: () => void;
  moveTo: (channelId: string) => void;
  toggleRole: (roleId: string, on: boolean) => void;
  volume: (percent: number) => MenuEntry;
  block: () => void;
  /** Copy the user id (voice participant menus only; the member list keeps "copy address"). */
  copyId?: () => void;
  report?: () => void;
}

export function memberMenu(c: MemberMenuContext, a: MemberMenuActions, t: T): MenuEntry[] {
  const room = c.room;
  const has = (bit: bigint) => !!room && hasPermission(room.perms, bit);
  const ranked = !!room && !c.self && !c.target.isOwner && (room.isOwner || room.myTop > c.target.top);
  const hierarchyReason = c.target.isOwner ? t("menu.reason.owner") : t("menu.reason.hierarchy");
  /** Moderation item: hidden without the permission, disabled (with the reason) below the target. */
  const mod = (bit: bigint, entry: MenuEntry): MenuEntry | null => {
    if (c.self || !has(bit)) return null;
    if (ranked) return entry;
    if (entry.kind === "item" || entry.kind === "submenu") return { ...entry, disabled: true, reason: hierarchyReason };
    return entry;
  };
  const voice = c.voice;
  const roleItems =
    room && has(Permission.MANAGE_ROLES)
      ? room.roles
          .filter((r) => !r.is_everyone)
          .sort((x, y) => y.position - x.position || x.name.localeCompare(y.name))
          .map((r) => {
            const on = c.target.roles.includes(r.id);
            const allowed = room.isOwner || r.position < room.myTop;
            return menuItem(`role-${r.id}`, r.name, () => a.toggleRole(r.id, !on), { checked: on, keepOpen: true, disabled: !allowed, reason: allowed ? undefined : t("menu.reason.role_above") });
          })
      : [];
  return normalizeMenu([
    menuItem("profile", t("menu.member.profile"), a.profile, { icon: "👤" }),
    !c.self && menuItem("message", t("menu.member.message"), a.message, { icon: "✉" }),
    !c.self && menuItem("call", t("menu.member.call"), a.call, { icon: "📞", disabled: !c.callsAvailable, reason: c.callsAvailable ? undefined : t("menu.reason.calls_soon") }),
    !c.self && !c.friend && menuItem("add-friend", c.friendPending ? t("menu.member.friend_pending") : t("menu.member.add_friend"), a.addFriend, { icon: "＋", disabled: c.friendPending, reason: c.friendPending ? t("menu.member.friend_pending") : undefined }),
    c.canMention && menuItem("mention", t("menu.member.mention"), a.mention, { icon: "@" }),
    menuItem("copy-address", t("menu.copy_address"), a.copyAddress, { icon: "⧉" }),
    a.copyId && menuItem("copy-id", t("menu.copy_id"), a.copyId, { icon: "#" }),
    voice && voice.inMyCall && !c.self && separator("sep-volume"),
    voice && voice.inMyCall && !c.self && a.volume(voice.volume),
    separator("sep-roles"),
    roleItems.length > 0 && submenu("roles", t("menu.member.roles"), roleItems, { icon: "🏷", ...(c.self || ranked ? {} : { disabled: true, reason: hierarchyReason }) }),
    voice && separator("sep-voice"),
    voice && mod(Permission.MUTE_MEMBERS, menuItem("server-mute", voice.serverMuted ? t("menu.member.server_unmute") : t("menu.member.server_mute"), () => a.serverMute(!voice.serverMuted), { icon: "🎙" })),
    voice && !c.self && has(Permission.MUTE_MEMBERS) && menuItem("server-deafen", t("menu.member.server_deafen"), undefined, { icon: "🎧", disabled: true, reason: t("menu.reason.not_supported") }),
    voice && mod(Permission.MOVE_MEMBERS, menuItem("disconnect", t("menu.member.disconnect"), a.disconnect, { icon: "⏏", danger: true })),
    voice && voice.channels.length > 0 && mod(Permission.MOVE_MEMBERS, submenu("move", t("menu.member.move_to"), voice.channels.map((ch) => menuItem(`move-${ch.id}`, ch.name, () => a.moveTo(ch.id), { icon: "🔊" })), { icon: "↪" })),
    separator("sep-mod"),
    mod(
      Permission.MODERATE_MEMBERS,
      c.target.timedOut
        ? menuItem("timeout-clear", t("menu.member.timeout_clear"), a.clearTimeout, { icon: "⏳" })
        : submenu("timeout", t("menu.member.timeout"), TIMEOUT_CHOICES.map((m) => menuItem(`timeout-${m}`, t(`menu.duration.${m}m`), () => a.timeout(m))), { icon: "⏳" }),
    ),
    mod(Permission.KICK_MEMBERS, menuItem("kick", t("menu.member.kick"), a.kick, { icon: "🚪", danger: true })),
    mod(Permission.BAN_MEMBERS, menuItem("ban", t("menu.member.ban"), a.ban, { icon: "⛔", danger: true })),
    !c.self && separator("sep-block"),
    !c.self && c.canReport && a.report && menuItem("report", t("menu.member.report"), a.report, { icon: "⚑" }),
    !c.self && menuItem("block", t("menu.member.block"), a.block, { icon: "🚫", danger: true }),
  ]);
}

// ---- Voice participants without a loaded member ---------------------------------------------

export interface VoiceParticipantMenuContext {
  self: boolean;
  /** Permissions of the viewer in the participant's voice channel. */
  perms: bigint;
  serverMuted: boolean;
  /** The participant is in the viewer's own call (per-user volume). */
  inMyCall: boolean;
  volume: number;
  /** The room's other voice channels. */
  channels: { id: string; name: string }[];
}

export interface VoiceParticipantMenuActions {
  volume: (percent: number) => MenuEntry;
  serverMute: (muted: boolean) => void;
  disconnect: () => void;
  moveTo: (channelId: string) => void;
  copyAddress: () => void;
  copyId: () => void;
}

/**
 * The reduced participant menu (design note 4.13 item 3) for participants whose member entry is not loaded or
 * who belong to another node: volume, server mute, disconnect, move and copy. Without the member there is
 * no role hierarchy to grey out moderation; the node still refuses what the viewer may not do.
 */
export function voiceParticipantMenu(c: VoiceParticipantMenuContext, a: VoiceParticipantMenuActions, t: T): MenuEntry[] {
  const mod = (bit: bigint) => !c.self && hasPermission(c.perms, bit);
  return normalizeMenu([
    c.inMyCall && !c.self && a.volume(c.volume),
    separator("sep-voice"),
    mod(Permission.MUTE_MEMBERS) && menuItem("server-mute", c.serverMuted ? t("menu.member.server_unmute") : t("menu.member.server_mute"), () => a.serverMute(!c.serverMuted), { icon: "🎙" }),
    mod(Permission.MUTE_MEMBERS) && menuItem("server-deafen", t("menu.member.server_deafen"), undefined, { icon: "🎧", disabled: true, reason: t("menu.reason.not_supported") }),
    mod(Permission.MOVE_MEMBERS) && menuItem("disconnect", t("menu.member.disconnect"), a.disconnect, { icon: "⏏", danger: true }),
    mod(Permission.MOVE_MEMBERS) &&
      c.channels.length > 0 &&
      submenu(
        "move",
        t("menu.member.move_to"),
        c.channels.map((ch) => menuItem(`move-${ch.id}`, ch.name, () => a.moveTo(ch.id), { icon: "🔊" })),
        { icon: "↪" },
      ),
    separator("sep-copy"),
    menuItem("copy-address", t("menu.copy_address"), a.copyAddress, { icon: "⧉" }),
    menuItem("copy-id", t("menu.copy_id"), a.copyId, { icon: "#" }),
  ]);
}

// ---- Messages -------------------------------------------------------------------------------

export interface MessageMenuContext {
  own: boolean;
  /** Text content that can be copied/edited (decrypted or plaintext). */
  text: string | null;
  pinned: boolean;
  canPin: boolean;
  canReact: boolean;
  /** `manage_messages`: delete messages of others. */
  canManage: boolean;
  canReply: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Others' messages on nodes that take reports (MODERATION.md). */
  canReport?: boolean;
  /** Threads (PROTOCOL.md §7e): the message may start a thread here (absent: no thread entries). */
  canThread?: boolean;
  /** The message already started a thread. */
  hasThread?: boolean;
}

export interface MessageMenuActions {
  reply: () => void;
  react: (emoji: string) => void;
  copyText: () => void;
  copyLink: () => void;
  copyId: () => void;
  pin: (pinned: boolean) => void;
  edit: () => void;
  remove: () => void;
  markUnread: () => void;
  report?: () => void;
  createThread?: () => void;
  replyInThread?: () => void;
}

export function messageMenu(c: MessageMenuContext, a: MessageMenuActions, t: T): MenuEntry[] {
  return normalizeMenu([
    c.canReply && menuItem("reply", t("menu.message.reply"), a.reply, { icon: "↩" }),
    c.canThread && !c.hasThread && a.createThread && menuItem("create-thread", t("menu.message.create_thread"), a.createThread, { icon: "🧵" }),
    (c.hasThread || c.canThread) && a.replyInThread && menuItem("reply-in-thread", t("menu.message.reply_in_thread"), a.replyInThread, { icon: "💬" }),
    c.canReact && submenu("react", t("menu.message.react"), QUICK_REACTIONS.map((e) => menuItem(`react-${e}`, e, () => a.react(e))), { icon: "☺" }),
    c.text !== null && menuItem("copy-text", t("menu.message.copy_text"), a.copyText, { icon: "⧉" }),
    menuItem("copy-link", t("menu.message.copy_link"), a.copyLink, { icon: "🔗" }),
    menuItem("copy-id", t("menu.message.copy_id"), a.copyId, { icon: "#" }),
    menuItem("mark-unread", t("menu.message.mark_unread"), a.markUnread, { icon: "●" }),
    separator("sep-manage"),
    c.canPin && menuItem("pin", c.pinned ? t("menu.message.unpin") : t("menu.message.pin"), () => a.pin(!c.pinned), { icon: "📌" }),
    c.own && c.canEdit && c.text !== null && menuItem("edit", t("menu.message.edit"), a.edit, { icon: "✎" }),
    c.canDelete && (c.own || c.canManage) && menuItem("delete", c.own ? t("menu.message.delete") : t("menu.message.delete_mod"), a.remove, { icon: "🗑", danger: true }),
    !c.own && c.canReport && a.report && separator("sep-report"),
    !c.own && c.canReport && a.report && menuItem("report", t("menu.message.report"), a.report, { icon: "⚑" }),
  ]);
}

// ---- Notification submenus --------------------------------------------------------------------

export interface NotifyMenuState {
  /** The own setting at this level (null = inherited). */
  mode: NotificationMode | null;
  /** The effective inherited value (shown as "default (…)"). */
  inherited: NotificationMode;
  mutedUntil: string | null;
  /** Rooms only. */
  suppressEveryone?: boolean;
}

export interface NotifyMenuActions {
  setMode: (mode: NotificationMode | null) => void;
  mute: (hours: number) => void;
  unmute: () => void;
  setSuppressEveryone?: (on: boolean) => void;
}

export function isMuted(mutedUntil: string | null | undefined, now = Date.now()): boolean {
  return !!mutedUntil && Date.parse(mutedUntil) > now;
}

export function notifyEntries(prefix: string, c: NotifyMenuState, a: NotifyMenuActions, t: T, now = Date.now()): MenuEntry[] {
  const muted = isMuted(c.mutedUntil, now);
  return normalizeMenu([
    submenu(
      `${prefix}-notify`,
      t("menu.notify.settings"),
      [
        menuItem(`${prefix}-mode-default`, t("menu.notify.default", { mode: t(`notify.mode.${c.inherited}`) }), () => a.setMode(null), { checked: c.mode === null }),
        ...(["all", "mentions", "nothing"] as const).map((m) => menuItem(`${prefix}-mode-${m}`, t(`notify.mode.${m}`), () => a.setMode(m), { checked: c.mode === m })),
        c.suppressEveryone !== undefined && a.setSuppressEveryone && separator(`${prefix}-sep-everyone`),
        c.suppressEveryone !== undefined && a.setSuppressEveryone && menuItem(`${prefix}-suppress-everyone`, t("menu.notify.suppress_everyone"), () => a.setSuppressEveryone!(!c.suppressEveryone), { checked: !!c.suppressEveryone, keepOpen: true }),
      ],
      { icon: "🔔" },
    ),
    muted
      ? menuItem(`${prefix}-unmute`, t("menu.notify.unmute"), a.unmute, { icon: "🔕", hint: mutedHint(c.mutedUntil!, t) })
      : submenu(`${prefix}-mute`, t("menu.notify.mute"), MUTE_CHOICES.map((h) => menuItem(`${prefix}-mute-${h}`, t(h === 0 ? "menu.duration.forever" : `menu.duration.${h}h`), () => a.mute(h))), { icon: "🔕" }),
  ]);
}

function mutedHint(until: string, t: T): string {
  return Date.parse(until) > Date.now() + 365 * 86_400_000 ? t("menu.duration.forever") : new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- Channels -------------------------------------------------------------------------------

export interface ChannelMenuContext {
  kind: string;
  unread: boolean;
  canManage: boolean;
  /** System channels (welcome) cannot be deleted or duplicated. */
  system: boolean;
  /**
   * Voice channels with `move_members` here: how many are in the room's other voice channels
   * (`elsewhere`), how many in this one (`here`) and where they can go (`targets`). Absent otherwise.
   */
  voiceMove?: { elsewhere: number; here: number; targets: { id: string; name: string }[] };
  notify: NotifyMenuState;
  /** "Keep the full history on this device" (encrypted conversations, unlocked device); absent = not offered. */
  fullHistory?: boolean | null;
}

export interface ChannelMenuActions extends NotifyMenuActions {
  markRead: () => void;
  toggleFullHistory?: () => void;
  edit: () => void;
  duplicate: () => void;
  remove: () => void;
  copyLink: () => void;
  copyId: () => void;
  /** Asks for a confirmation, then moves everyone in the room's other voice channels here. */
  moveEveryoneHere: () => void;
  /** Asks for a confirmation, then moves everyone in this channel to `channelId`. */
  moveEveryoneTo: (channelId: string) => void;
}

/** The device-local "keep the full history on this device" toggle (design note 4.4, local search index). */
function fullHistoryEntries(on: boolean | null | undefined, toggle: (() => void) | undefined, t: T): MenuEntry[] {
  if (on === null || on === undefined || !toggle) return [];
  return [separator("sep-history"), menuItem("full-history", t("menu.full_history"), toggle, { icon: "🗄", checked: on })];
}

export function channelMenu(c: ChannelMenuContext, a: ChannelMenuActions, t: T): MenuEntry[] {
  // Voice channels get the same menu as text channels plus the mass moves (design note 4.11, polish round 2).
  const move = c.kind === "voice" ? c.voiceMove : undefined;
  return normalizeMenu([
    menuItem("mark-read", t("menu.mark_read"), a.markRead, { icon: "✓", disabled: !c.unread, reason: c.unread ? undefined : t("menu.reason.nothing_unread") }),
    separator("sep-notify"),
    ...notifyEntries("channel", c.notify, a, t),
    ...fullHistoryEntries(c.fullHistory, a.toggleFullHistory, t),
    move && separator("sep-voice"),
    move &&
      menuItem("move-here", t("menu.channel.move_here_count", { count: move.elsewhere }), a.moveEveryoneHere, {
        icon: "⤵",
        disabled: move.elsewhere === 0,
        reason: move.elsewhere === 0 ? t("menu.reason.nobody_elsewhere") : undefined,
      }),
    move &&
      submenu(
        "move-from",
        t("menu.channel.move_from", { count: move.here }),
        move.targets.map((target) => menuItem(`move-to-${target.id}`, target.name, () => a.moveEveryoneTo(target.id), { icon: "🔊" })),
        {
          icon: "⤴",
          // Without other voice channels the (empty) submenu is left out.
          disabled: move.here === 0,
          reason: move.here === 0 ? t("menu.reason.nobody_here") : undefined,
        },
      ),
    separator("sep-manage"),
    c.canManage && menuItem("edit", t("menu.channel.edit"), a.edit, { icon: "⚙" }),
    c.canManage && !c.system && menuItem("duplicate", t("menu.channel.duplicate"), a.duplicate, { icon: "⧉" }),
    separator("sep-copy"),
    menuItem("copy-link", t("menu.channel.copy_link"), a.copyLink, { icon: "🔗" }),
    menuItem("copy-id", t("menu.copy_id"), a.copyId, { icon: "#" }),
    c.canManage && !c.system && separator("sep-delete"),
    c.canManage && !c.system && menuItem("delete", t("menu.channel.delete"), a.remove, { icon: "🗑", danger: true }),
  ]);
}

// ---- Rooms (rail) ---------------------------------------------------------------------------

export interface RoomMenuContext {
  unread: boolean;
  canInvite: boolean;
  isOwner: boolean;
  notify: NotifyMenuState;
  /** The room's node takes reports (MODERATION.md); owners do not report their own room. */
  canReport?: boolean;
}

export interface RoomMenuActions extends NotifyMenuActions {
  markRead: () => void;
  invite: () => void;
  settings: () => void;
  leave: () => void;
  copyId: () => void;
  report?: () => void;
}

export function roomMenu(c: RoomMenuContext, a: RoomMenuActions, t: T): MenuEntry[] {
  return normalizeMenu([
    menuItem("mark-read", t("menu.mark_read"), a.markRead, { icon: "✓", disabled: !c.unread, reason: c.unread ? undefined : t("menu.reason.nothing_unread") }),
    separator("sep-notify"),
    ...notifyEntries("room", c.notify, a, t),
    separator("sep-room"),
    c.canInvite && menuItem("invite", t("menu.room.invite"), a.invite, { icon: "✉" }),
    menuItem("settings", t("menu.room.settings"), a.settings, { icon: "⚙" }),
    menuItem("copy-id", t("menu.copy_id"), a.copyId, { icon: "#" }),
    !c.isOwner && c.canReport && a.report && menuItem("report", t("menu.room.report"), a.report, { icon: "⚑" }),
    separator("sep-leave"),
    menuItem("leave", t("menu.room.leave"), a.leave, { icon: "🚪", danger: true, disabled: c.isOwner, reason: c.isOwner ? t("menu.reason.owner_leave") : undefined }),
  ]);
}

// ---- DMs ------------------------------------------------------------------------------------

export interface DmMenuContext {
  unread: boolean;
  kind: "dm" | "group";
  /** The other person of a DM. */
  peer: { address: string; name: string } | null;
  notify: NotifyMenuState;
  /** "Keep the full history on this device"; absent = not offered (locked device). */
  fullHistory?: boolean | null;
}

export interface DmMenuActions extends NotifyMenuActions {
  markRead: () => void;
  toggleFullHistory?: () => void;
  profile: () => void;
  close: () => void;
  block: () => void;
  copyAddress: () => void;
}

export function dmMenu(c: DmMenuContext, a: DmMenuActions, t: T): MenuEntry[] {
  return normalizeMenu([
    menuItem("mark-read", t("menu.mark_read"), a.markRead, { icon: "✓", disabled: !c.unread, reason: c.unread ? undefined : t("menu.reason.nothing_unread") }),
    c.peer && menuItem("profile", t("menu.member.profile"), a.profile, { icon: "👤" }),
    c.peer && menuItem("copy-address", t("menu.copy_address"), a.copyAddress, { icon: "⧉" }),
    separator("sep-notify"),
    ...notifyEntries("dm", c.notify, a, t),
    ...fullHistoryEntries(c.fullHistory, a.toggleFullHistory, t),
    separator("sep-close"),
    menuItem("close", t("menu.dm.close"), a.close, { icon: "✕" }),
    c.peer && menuItem("block", t("menu.member.block"), a.block, { icon: "🚫", danger: true }),
  ]);
}
