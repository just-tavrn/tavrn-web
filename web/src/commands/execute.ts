// SPDX-License-Identifier: Apache-2.0
import type { InvokeRequest, Member, RoomDetail, TavrnApi } from "@tavrn/sdk";
import { parseDuration, parsePurgeAmount } from "./parse";
import type { ArgValue, CommandDefinition } from "./types";

/** What a command can reach: the node of the conversation and a few composer actions. */
export interface CommandContext {
  api: TavrnApi;
  t: (key: string, vars?: Record<string, string | number>) => string;
  conversationId: string;
  /** Room channels only. */
  roomId?: string;
  room?: RoomDetail;
  /** Room members (for `@user` arguments). */
  members?: Member[];
  /** Sends a content object (`text` or `action`) to the conversation, encrypted where needed. */
  sendContent: (content: { type: "text" | "action"; body: string }) => Promise<void>;
  openWhiteboard: () => void;
  /** Opens the poll composer (PROTOCOL.md §7g), with the question when one was typed after `/poll`. */
  openPoll: (question: string) => void;
  confirm: (text: string) => boolean | Promise<boolean>;
  /** A short local notice (toast). */
  info: (text: string) => void;
  showHelp: () => void;
}

export class CommandError extends Error {}

/** Markdown source of ¯\_(ツ)_/¯ (backslash and underscores escaped). */
const SHRUG = "¯\\\\\\_(ツ)\\_/¯";

/** Finds a room member by address, username, display name or room nickname (case-insensitive). */
export function resolveMember(raw: string, members: Member[]): Member {
  const q = raw.trim().replace(/^@/, "").toLowerCase();
  const exact = members.filter((m) => m.user.address.toLowerCase() === q || m.user.username.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const named = members.filter((m) => m.user.display_name.toLowerCase() === q || (m.nick ?? m.nickname ?? "").toLowerCase() === q);
  if (named.length === 1) return named[0]!;
  throw new CommandError(named.length > 1 ? "cmd.error.user_ambiguous" : "cmd.error.user_unknown");
}

/** The invocation of an application command (APPLICATIONS.md §5.5), in the thread it is typed in (§7e). */
export function invokeRequest(command: string, sealed: Pick<InvokeRequest, "args" | "args_ciphertext" | "epoch">, threadId: string | null | undefined): InvokeRequest {
  return { command, ...sealed, ...(threadId ? { thread_id: threadId } : {}) };
}

/**
 * Arguments of an application command as the node expects them (APPLICATIONS.md §5.5): `user` → address,
 * `channel` → channel id, `role` → role id; other types unchanged. Unknown names: `CommandError`.
 */
export function resolveAppArgs(def: CommandDefinition, values: Record<string, ArgValue>, ctx: { members?: Member[]; room?: RoomDetail }): Record<string, ArgValue> {
  const out: Record<string, ArgValue> = {};
  for (const arg of def.args) {
    const v = values[arg.name];
    if (v === undefined) continue;
    const raw = String(v).trim();
    switch (arg.type) {
      case "user": {
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.replace(/^@/, "")) && !ctx.members?.some((m) => m.user.username.toLowerCase() === raw.replace(/^@/, "").toLowerCase())) {
          out[arg.name] = raw.replace(/^@/, "").toLowerCase();
        } else {
          out[arg.name] = resolveMember(raw, ctx.members ?? []).user.address;
        }
        break;
      }
      case "channel": {
        const q = raw.replace(/^#/, "").toLowerCase();
        const hits = (ctx.room?.channels ?? []).filter((c) => c.id === raw || c.name.toLowerCase() === q);
        if (hits.length !== 1) throw new CommandError("cmd.error.channel_unknown");
        out[arg.name] = hits[0]!.id;
        break;
      }
      case "role": {
        const q = raw.replace(/^@/, "").toLowerCase();
        const hits = (ctx.room?.roles ?? []).filter((r) => r.id === raw || r.name.toLowerCase() === q);
        if (hits.length !== 1) throw new CommandError("cmd.error.role_unknown");
        out[arg.name] = hits[0]!.id;
        break;
      }
      default:
        out[arg.name] = v;
    }
  }
  return out;
}

function voiceChannel(room: RoomDetail, raw: string) {
  const q = raw.replace(/^#/, "").toLowerCase();
  const hits = room.channels.filter((c) => c.kind === "voice" && (c.id === raw || c.name.toLowerCase() === q));
  if (hits.length !== 1) throw new CommandError("cmd.error.channel_unknown");
  return hits[0]!;
}

function need<T>(v: T | undefined | null, key = "cmd.error.room_only"): T {
  if (v === undefined || v === null) throw new CommandError(key);
  return v;
}

/** Runs a built-in command with parsed arguments. Errors: `CommandError` (an i18n key) or API errors. */
export async function executeBuiltin(def: CommandDefinition, values: Record<string, ArgValue>, ctx: CommandContext): Promise<void> {
  const { api, t } = ctx;
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : "");
  const member = () => resolveMember(str("user"), need(ctx.members));
  const roomId = () => need(ctx.roomId);
  switch (def.name) {
    case "help":
      ctx.showHelp();
      return;
    case "me":
      await ctx.sendContent({ type: "action", body: str("action") });
      return;
    case "shrug":
      await ctx.sendContent({ type: "text", body: str("message") ? `${str("message")} ${SHRUG}` : SHRUG });
      return;
    case "poll":
      ctx.openPoll(str("question"));
      return;
    case "whiteboard":
      ctx.openWhiteboard();
      return;
    case "nick": {
      const name = str("name");
      await api.members.setMyProfile(roomId(), { nickname: name || null });
      ctx.info(name ? t("cmd.nick.done", { name }) : t("cmd.nick.cleared"));
      return;
    }
    case "topic":
      await api.channels.update(roomId(), ctx.conversationId, { topic: str("text") });
      ctx.info(t("cmd.topic.done"));
      return;
    case "slowmode": {
      const secs = parseDuration(str("seconds"), "s");
      if (secs === null || secs > 6 * 3600) throw new CommandError("cmd.error.duration");
      await api.channels.update(roomId(), ctx.conversationId, { slowmode_secs: secs });
      ctx.info(secs ? t("cmd.slowmode.done", { seconds: secs }) : t("cmd.slowmode.off"));
      return;
    }
    case "kick": {
      const m = member();
      if (!(await ctx.confirm(t("cmd.kick.confirm", { user: m.user.address })))) return;
      await api.members.kick(roomId(), m.user.id, str("reason") || undefined);
      ctx.info(t("cmd.kick.done", { user: m.user.address }));
      return;
    }
    case "ban": {
      const m = member();
      if (!(await ctx.confirm(t("cmd.ban.confirm", { user: m.user.address })))) return;
      await api.members.ban(roomId(), { subject: m.user.address, reason: str("reason") });
      ctx.info(t("cmd.ban.done", { user: m.user.address }));
      return;
    }
    case "timeout": {
      const m = member();
      const secs = parseDuration(str("duration"));
      if (!secs || secs > 28 * 86400) throw new CommandError("cmd.error.duration");
      const minutes = Math.max(1, Math.ceil(secs / 60));
      await api.members.timeout(roomId(), m.user.id, { minutes, reason: str("reason") });
      ctx.info(t("cmd.timeout.done", { user: m.user.address, minutes }));
      return;
    }
    case "mute":
    case "unmute": {
      const m = member();
      const room = need(ctx.room);
      const states = await api.voice.roomStates(room.id);
      const current = states.items.find((s) => s.participants.some((p) => p.user === m.user.address))?.channel_id;
      const channel = current ?? room.channels.find((c) => c.kind === "voice")?.id;
      await api.voice.serverMute(room.id, need(channel, "cmd.error.no_voice"), m.user.address, def.name === "mute");
      ctx.info(t(def.name === "mute" ? "cmd.mute.done" : "cmd.unmute.done", { user: m.user.address }));
      return;
    }
    case "move": {
      const m = member();
      const room = need(ctx.room);
      const target = voiceChannel(room, str("channel"));
      const states = await api.voice.roomStates(room.id);
      const from = states.items.find((s) => s.participants.some((p) => p.user === m.user.address))?.channel_id;
      await api.voice.move(room.id, need(from, "cmd.error.not_in_voice"), m.user.address, target.id);
      ctx.info(t("cmd.move.done", { user: m.user.address, channel: target.name }));
      return;
    }
    case "purge": {
      const amount = parsePurgeAmount(str("amount"));
      if (!amount) throw new CommandError("cmd.error.purge_amount");
      let from: string;
      if ("count" in amount) {
        const msgs = [];
        let before: string | undefined;
        while (msgs.length < amount.count) {
          const page = await api.conversations.messages(ctx.conversationId, { limit: Math.min(100, amount.count - msgs.length), before });
          msgs.push(...page);
          if (page.length === 0) break;
          before = page.at(-1)!.id;
        }
        if (msgs.length === 0) throw new CommandError("cmd.error.nothing");
        from = msgs[msgs.length - 1]!.created_at;
      } else {
        from = new Date(Date.now() - amount.seconds * 1000).toISOString();
      }
      const filter = { channel_ids: [ctx.conversationId], from };
      const preview = await api.rooms.purge(roomId(), filter);
      if (!preview.messages) throw new CommandError("cmd.error.nothing");
      if (!(await ctx.confirm(t("cmd.purge.confirm", { count: preview.messages })))) return;
      const done = await api.rooms.purge(roomId(), { ...filter, confirm_token: preview.confirm_token });
      ctx.info(t("cmd.purge.done", { count: done.messages }));
      return;
    }
    default:
      throw new CommandError("cmd.error.unknown");
  }
}
