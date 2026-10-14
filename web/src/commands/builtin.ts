// SPDX-License-Identifier: Apache-2.0
import { Permission } from "@tavrn/sdk";
import type { CommandArg, CommandDefinition } from "./types";

const p = (bit: bigint) => bit.toString();
const user: CommandArg = { name: "user", description: "Member (@name)", type: "user", required: true };
const reason: CommandArg = { name: "reason", description: "Reason", type: "string", required: false, rest: true };

/**
 * Built-in commands of the reference client. Descriptions here are English fallbacks; the composer shows
 * `cmd.<name>.description` and `cmd.arg.<arg>` in the user's language.
 */
export const BUILTIN_COMMANDS: CommandDefinition[] = [
  { id: "", name: "help", description: "List the commands you can use here", args: [], dm_allowed: true, source: "builtin" },
  {
    id: "",
    name: "me",
    description: "Send an action in the third person",
    args: [{ name: "action", description: "What you do", type: "string", required: true, rest: true, max_length: 4000 }],
    permission: p(Permission.SEND_MESSAGES),
    dm_allowed: true,
    source: "builtin",
  },
  {
    id: "",
    name: "shrug",
    description: "Append ¯\\_(ツ)_/¯ to your message",
    args: [{ name: "message", description: "Message", type: "string", required: false, rest: true }],
    permission: p(Permission.SEND_MESSAGES),
    dm_allowed: true,
    source: "builtin",
  },
  {
    id: "",
    name: "poll",
    description: "Create a poll or a date poll",
    args: [{ name: "question", description: "Question", type: "string", required: false, rest: true, max_length: 300 }],
    // `create_polls` with `send_messages` (PROTOCOL.md §7g); DMs and group DMs grant both to every member.
    permission: p(Permission.SEND_MESSAGES | Permission.CREATE_POLLS),
    dm_allowed: true,
    source: "builtin",
  },
  { id: "", name: "whiteboard", description: "Open the whiteboard of this conversation", args: [], permission: p(Permission.USE_WHITEBOARD), dm_allowed: true, source: "builtin" },
  {
    id: "",
    name: "nick",
    description: "Set your nickname in this room (empty: remove it)",
    args: [{ name: "name", description: "Nickname", type: "string", required: false, rest: true, max_length: 32 }],
    permission: p(Permission.CHANGE_NICKNAME),
    dm_allowed: false,
    source: "builtin",
  },
  {
    id: "",
    name: "topic",
    description: "Set the channel topic",
    args: [{ name: "text", description: "Topic", type: "string", required: false, rest: true, max_length: 1024 }],
    permission: p(Permission.MANAGE_CHANNELS),
    dm_allowed: false,
    source: "builtin",
  },
  {
    id: "",
    name: "slowmode",
    description: "Seconds between messages per member (0: off)",
    args: [{ name: "seconds", description: "Seconds, e.g. 10 or 5m", type: "string", required: true }],
    permission: p(Permission.MANAGE_CHANNELS),
    dm_allowed: false,
    source: "builtin",
  },
  { id: "", name: "kick", description: "Remove a member from the room", args: [user, reason], permission: p(Permission.KICK_MEMBERS), dm_allowed: false, source: "builtin", destructive: true },
  { id: "", name: "ban", description: "Ban a member from the room", args: [user, reason], permission: p(Permission.BAN_MEMBERS), dm_allowed: false, source: "builtin", destructive: true },
  {
    id: "",
    name: "timeout",
    description: "Time out a member",
    args: [user, { name: "duration", description: "10m, 2h, 1d", type: "string", required: true }, reason],
    permission: p(Permission.MODERATE_MEMBERS),
    dm_allowed: false,
    source: "builtin",
  },
  { id: "", name: "mute", description: "Mute a member in voice (room-wide)", args: [user], permission: p(Permission.MUTE_MEMBERS), dm_allowed: false, source: "builtin", needs_voice: true },
  { id: "", name: "unmute", description: "Lift a member's voice mute", args: [user], permission: p(Permission.MUTE_MEMBERS), dm_allowed: false, source: "builtin", needs_voice: true },
  {
    id: "",
    name: "move",
    description: "Move a member to another voice channel",
    args: [user, { name: "channel", description: "Voice channel (#name)", type: "channel", required: true }],
    permission: p(Permission.MOVE_MEMBERS),
    dm_allowed: false,
    source: "builtin",
    needs_voice: true,
  },
  {
    id: "",
    name: "purge",
    description: "Delete the last messages of this channel",
    args: [{ name: "amount", description: "Count (e.g. 20) or time (e.g. 30m)", type: "string", required: true }],
    permission: p(Permission.PURGE),
    dm_allowed: false,
    source: "builtin",
    destructive: true,
  },
];
