// SPDX-License-Identifier: Apache-2.0
import type { PaletteCommand } from "@tavrn/sdk";
import { isAvailable } from "./registry";
import type { CommandArg, CommandDefinition, CommandScope } from "./types";

/**
 * The `/` palette of a conversation (tavrn-protocol/APPLICATIONS.md §5.4): built-ins first (already filtered by the
 * user's permissions), then the application commands the node offers for this conversation. A name used by a
 * built-in or by another application gets the application's name as qualifier; selections are bound to the
 * definition (application commands: their id), never resolved by name across sources.
 */

/** Application commands from `GET /conversations/{id}/commands` in the registry shape. */
export function appDefinitions(list: PaletteCommand[] | undefined): CommandDefinition[] {
  return (list ?? []).map((c) => ({
    id: c.id,
    ref: c.ref,
    name: c.name,
    description: c.description,
    args: c.args.map((a): CommandArg => ({
      name: a.name,
      description: a.description,
      type: a.type as CommandArg["type"],
      required: !!a.required,
      ...(a.options ? { options: a.options.map((o) => ({ name: o.name, value: o.value as string | number })) } : {}),
      ...(a.min !== undefined && a.min !== null ? { min: a.min } : {}),
      ...(a.max !== undefined && a.max !== null ? { max: a.max } : {}),
      ...(a.max_length !== undefined && a.max_length !== null ? { max_length: a.max_length } : {}),
    })),
    permission: c.permission,
    dm_allowed: c.dm_allowed,
    source: "app",
    application: c.application,
  }));
}

/** Built-ins (as given), then the application commands available in `scope`, with collision qualifiers. */
export function mergePalette(builtins: CommandDefinition[], apps: CommandDefinition[], scope: CommandScope): CommandDefinition[] {
  const offered = apps.filter((d) => d.source === "app" && isAvailable(d, scope));
  const builtinNames = new Set(builtins.map((d) => d.name));
  const count = new Map<string, number>();
  for (const d of offered) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  const qualified = offered.map((d) =>
    builtinNames.has(d.name) || (count.get(d.name) ?? 0) > 1 ? { ...d, qualifier: d.application?.name ?? d.ref ?? d.id } : d,
  );
  return [...builtins, ...qualified];
}

/** A stable key of a definition (application commands by id, built-ins by name). */
export function commandKey(d: CommandDefinition): string {
  return d.source === "app" ? `app:${d.id}` : `builtin:${d.name}`;
}

export type Resolved = { def: CommandDefinition } | { ambiguous: CommandDefinition[] } | null;

/**
 * The command a typed name means: the one the user picked (same name), else the built-in of that name, else the
 * only application command of that name. Two applications with the name and no pick: ambiguous.
 */
export function resolveCommand(available: CommandDefinition[], name: string, picked?: CommandDefinition | null): Resolved {
  if (picked && picked.name === name) {
    const current = available.find((d) => commandKey(d) === commandKey(picked));
    if (current) return { def: current };
  }
  const builtin = available.find((d) => d.source === "builtin" && d.name === name);
  if (builtin) return { def: builtin };
  const apps = available.filter((d) => d.source === "app" && d.name === name);
  if (apps.length === 1) return { def: apps[0]! };
  return apps.length > 1 ? { ambiguous: apps } : null;
}

/** Pick-list suggestions of an argument (`options`, booleans) matching the typed text. */
export function choiceSuggestions(arg: CommandArg, partial: string): { value: string; label: string }[] {
  const q = partial.replace(/^"/, "").toLowerCase();
  const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  if (arg.options?.length) {
    return arg.options
      .filter((o) => !q || o.name.toLowerCase().includes(q) || String(o.value).toLowerCase().startsWith(q))
      .map((o) => ({ value: quote(String(o.value)), label: o.name === String(o.value) ? o.name : `${o.name} (${o.value})` }));
  }
  if (arg.type === "boolean") return ["true", "false"].filter((v) => v.startsWith(q)).map((v) => ({ value: v, label: v }));
  return [];
}
