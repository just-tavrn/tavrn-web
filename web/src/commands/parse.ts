// SPDX-License-Identifier: Apache-2.0
import type { ArgValue, CommandArg, CommandDefinition } from "./types";

/** `"/time"` → `{ name: "time", rest: "", complete: false }`; text that is no command → null. */
export function parseCommandLine(text: string): { name: string; rest: string; complete: boolean } | null {
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const m = /^\/([a-z0-9_-]*)(\s+([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), rest: m[3] ?? "", complete: m[2] !== undefined };
}

/** Splits arguments at whitespace; `"double quotes"` keep spaces together. */
export function tokenize(rest: string): { tokens: string[]; trailingSpace: boolean } {
  const tokens: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) tokens.push(m[1] ?? m[2] ?? "");
  return { tokens, trailingSpace: /\s$/.test(rest) };
}

/** Durations: `30s`, `10m`, `2h`, `1d`, `1w`; a plain number is `unit` (minutes by default). Seconds, or null. */
export function parseDuration(input: string, unit: "s" | "m" = "m"): number | null {
  const m = /^(\d{1,6})\s*(s|sec|m|min|h|d|w)?$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const factor: Record<string, number> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800 };
  return n * factor[(m[2] ?? unit).toLowerCase()]!;
}

/** `/purge` amount: a message count (1–1000) or a time window. */
export function parsePurgeAmount(input: string): { count: number } | { seconds: number } | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 1000 ? { count: n } : null;
  }
  const secs = parseDuration(s);
  return secs && secs > 0 ? { seconds: secs } : null;
}

export interface ParsedArgs {
  values: Record<string, ArgValue>;
  /** Required arguments that are missing. */
  missing: string[];
  /** First invalid argument with the reason key (`cmd.error.<reason>`). */
  invalid?: { arg: string; reason: string };
}

/**
 * Assigns tokens to the definition's arguments in order. `user` arguments take `@name`, `name` or
 * `name@domain`; `channel` arguments `#name`; the last `rest` argument takes the remaining text verbatim.
 */
export function parseArgs(def: CommandDefinition, rest: string): ParsedArgs {
  const values: Record<string, ArgValue> = {};
  const missing: string[] = [];
  let remaining = rest.trimStart();
  for (const arg of def.args) {
    if (arg.rest) {
      const text = remaining.trim();
      if (text) values[arg.name] = text;
      else if (arg.required) missing.push(arg.name);
      remaining = "";
      continue;
    }
    const m = /^("([^"]*)"|\S+)\s*/.exec(remaining);
    if (!m) {
      if (arg.required) missing.push(arg.name);
      continue;
    }
    remaining = remaining.slice(m[0].length);
    const raw = m[2] ?? m[1]!;
    const value = convert(arg, raw);
    if (value === null) return { values, missing, invalid: { arg: arg.name, reason: arg.type === "integer" || arg.type === "number" ? "number" : "value" } };
    if (arg.max_length && typeof value === "string" && value.length > arg.max_length) return { values, missing, invalid: { arg: arg.name, reason: "too_long" } };
    values[arg.name] = value;
  }
  for (const arg of def.args) {
    if (arg.rest && arg.max_length && typeof values[arg.name] === "string" && (values[arg.name] as string).length > arg.max_length) {
      return { values, missing, invalid: { arg: arg.name, reason: "too_long" } };
    }
  }
  return { values, missing };
}

function convert(arg: CommandArg, raw: string): ArgValue | null {
  switch (arg.type) {
    case "user":
      return raw.replace(/^@/, "") || null;
    case "channel":
      return raw.replace(/^#/, "") || null;
    case "role":
      return raw.replace(/^@/, "") || null;
    case "integer": {
      const n = Number(raw);
      return Number.isInteger(n) && (arg.min === undefined || n >= arg.min) && (arg.max === undefined || n <= arg.max) ? n : null;
    }
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) && (arg.min === undefined || n >= arg.min) && (arg.max === undefined || n <= arg.max) ? n : null;
    }
    case "boolean":
      return /^(true|yes|on|1)$/i.test(raw) ? true : /^(false|no|off|0)$/i.test(raw) ? false : null;
    default:
      if (arg.options?.length) {
        const hit = arg.options.find((o) => String(o.value).toLowerCase() === raw.toLowerCase() || o.name.toLowerCase() === raw.toLowerCase());
        return hit ? hit.value : null;
      }
      return raw;
  }
}

/** Index of the argument the cursor is in (for hints), -1 while the name is typed. */
export function activeArgIndex(def: CommandDefinition, rest: string, complete: boolean): number {
  if (!complete) return -1;
  const { tokens, trailingSpace } = tokenize(rest);
  const idx = tokens.length === 0 ? 0 : trailingSpace ? tokens.length : tokens.length - 1;
  const restIdx = def.args.findIndex((a) => a.rest);
  if (restIdx >= 0 && idx >= restIdx) return restIdx;
  return Math.min(idx, def.args.length - 1);
}

/** The partial text of the argument being typed (for user/channel suggestions). */
export function currentToken(rest: string): string {
  if (/\s$/.test(rest) || !rest) return "";
  const { tokens } = tokenize(rest);
  return tokens.at(-1) ?? "";
}
