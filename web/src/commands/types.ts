// SPDX-License-Identifier: Apache-2.0
/**
 * Slash commands (design note 4.11, PROTOCOL.md §4.1): the client registry uses the command definition shape of
 * `tavrn-protocol/APPLICATIONS.md` §5.1/§5.4, so phase 5 application commands (`source: "app"`, fetched from
 * `GET /conversations/{id}/commands`) and the built-ins share one format.
 */

export type ArgType = "string" | "integer" | "number" | "boolean" | "user" | "channel" | "role";

export interface CommandArgOption {
  name: string;
  value: string | number;
}

export interface CommandArg {
  /** `^[a-z0-9_-]{1,32}$` */
  name: string;
  description: string;
  type: ArgType;
  required: boolean;
  /** Choices (APPLICATIONS.md §5.1 `options`). */
  options?: CommandArgOption[];
  min?: number;
  max?: number;
  max_length?: number;
  /** Client extension for built-ins: the last string argument takes the rest of the line. */
  rest?: boolean;
}

export interface CommandDefinition {
  /** Application commands: their id; built-ins: empty. */
  id: string;
  name: string;
  description: string;
  args: CommandArg[];
  /** Decimal mask the user must hold in the current channel (`null`/absent: none). */
  permission?: string | null;
  /** Application default (APPLICATIONS.md §5.1); built-ins leave it null. */
  default_permissions?: string | null;
  /** Usable in DMs and group DMs. */
  dm_allowed: boolean;
  source: "builtin" | "app";
  /** Built-ins: needs a room with at least one voice channel (`/mute`, `/move`). */
  needs_voice?: boolean;
  /** Built-ins that cannot be undone ask for confirmation. */
  destructive?: boolean;
  /** Application commands: `<application ref>/<command id>` (what an invocation names). */
  ref?: string;
  /** Application commands: the application (its bot carries the BOT badge). */
  application?: { ref: string; name: string; bot: string };
  /** Shown after the name when another command has the same name (`/weather · WeatherBot`). */
  qualifier?: string;
}

/** Where the composer is: what the user may do there. */
export interface CommandScope {
  /** The user's effective permissions in the current conversation. */
  permissions: bigint;
  /** DM or group DM (no room). */
  direct: boolean;
  /** The room has a voice channel. */
  hasVoice?: boolean;
}

/** A parsed argument value. */
export type ArgValue = string | number | boolean;
