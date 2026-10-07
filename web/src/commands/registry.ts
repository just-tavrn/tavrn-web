// SPDX-License-Identifier: Apache-2.0
import { hasPermission, parsePermissions } from "@tavrn/sdk";
import { BUILTIN_COMMANDS } from "./builtin";
import type { CommandDefinition, CommandScope } from "./types";

/**
 * The command registry: built-ins first, then application commands (phase 5) that a conversation offers.
 * Selection is by definition (name for built-ins, id for applications), never by a name of another source.
 */
export class CommandRegistry {
  private readonly defs: CommandDefinition[] = [];

  constructor(initial: CommandDefinition[] = []) {
    for (const d of initial) this.register(d);
  }

  /** Adds a definition; a second built-in of the same name replaces the first. */
  register(def: CommandDefinition): void {
    const i = this.defs.findIndex((d) => d.source === def.source && (def.source === "builtin" ? d.name === def.name : d.id === def.id));
    if (i >= 0) this.defs[i] = def;
    else this.defs.push(def);
  }

  /** Drops every application command (before merging a fresh list from the node). */
  clearApps(): void {
    for (let i = this.defs.length - 1; i >= 0; i--) if (this.defs[i]!.source === "app") this.defs.splice(i, 1);
  }

  all(): CommandDefinition[] {
    return [...this.defs.filter((d) => d.source === "builtin"), ...this.defs.filter((d) => d.source === "app")];
  }

  /** The built-in (or else the first application command) of this name. */
  get(name: string): CommandDefinition | undefined {
    const n = name.toLowerCase();
    return this.defs.find((d) => d.source === "builtin" && d.name === n) ?? this.defs.find((d) => d.name === n);
  }
}

/** May the user use this command here (permission mask, DMs, voice)? */
export function isAvailable(def: CommandDefinition, scope: CommandScope): boolean {
  if (scope.direct && !def.dm_allowed) return false;
  if (def.needs_voice && !scope.hasVoice) return false;
  const needed = parsePermissions(def.permission ?? "0");
  return needed === 0n || hasPermission(scope.permissions, needed);
}

export function availableCommands(registry: CommandRegistry, scope: CommandScope): CommandDefinition[] {
  return registry.all().filter((d) => isAvailable(d, scope));
}

/** The registry of the reference client (built-ins; applications are merged per conversation in phase 5). */
export function builtinRegistry(): CommandRegistry {
  return new CommandRegistry(BUILTIN_COMMANDS);
}

/** "/timeout <user> <duration> [reason]" */
export function usage(def: CommandDefinition, label: (arg: string) => string = (a) => a): string {
  return [`/${def.name}`, ...def.args.map((a) => (a.required ? `<${label(a.name)}>` : `[${label(a.name)}]`))].join(" ");
}
