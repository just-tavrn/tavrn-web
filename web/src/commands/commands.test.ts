// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission } from "@tavrn/sdk";
import type { Member } from "@tavrn/sdk";
import { BUILTIN_COMMANDS } from "./builtin";
import { CommandError, resolveMember } from "./execute";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";
import { activeArgIndex, currentToken, parseArgs, parseCommandLine, parseDuration, parsePurgeAmount, tokenize } from "./parse";
import { CommandRegistry, availableCommands, builtinRegistry, usage } from "./registry";

const def = (name: string) => BUILTIN_COMMANDS.find((d) => d.name === name)!;
const member = (username: string, display: string, nick?: string): Member =>
  ({ user: { id: `id-${username}`, username, domain: "t.local", address: `${username}@t.local`, display_name: display }, nick, roles: [], joined_at: "" }) as unknown as Member;

describe("command registry", () => {
  it("uses the APPLICATIONS.md definition shape and filters by permission", () => {
    for (const d of BUILTIN_COMMANDS) {
      expect(d.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(d.source).toBe("builtin");
      expect(typeof d.dm_allowed).toBe("boolean");
      for (const a of d.args) expect(a.name).toMatch(/^[a-z0-9_-]{1,32}$/);
    }
    const reg = builtinRegistry();
    const member = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CHANGE_NICKNAME | Permission.USE_WHITEBOARD;
    const names = (perms: bigint, direct = false, hasVoice = true) => availableCommands(reg, { permissions: perms, direct, hasVoice }).map((d) => d.name);
    expect(names(member)).toEqual(["help", "me", "shrug", "whiteboard", "poll", "nick"]);
    expect(names(member | Permission.MODERATE_MEMBERS)).toContain("timeout");
    expect(names(member | Permission.MODERATE_MEMBERS)).not.toContain("kick");
    const all = names(ALL_PERMISSIONS);
    for (const n of ["kick", "ban", "timeout", "mute", "unmute", "move", "purge", "slowmode", "topic"]) expect(all).toContain(n);
    expect(names(ALL_PERMISSIONS, false, false)).not.toContain("move");
    expect(names(ALL_PERMISSIONS, true)).toEqual(["help", "me", "shrug", "whiteboard", "poll"]);
  });

  it("puts built-ins first and keeps application commands by id", () => {
    const reg = new CommandRegistry([def("help")]);
    reg.register({ id: "01JA", name: "help", description: "app help", args: [], dm_allowed: true, source: "app", permission: "0" });
    reg.register({ id: "01JB", name: "weather", description: "Forecast", args: [], dm_allowed: true, source: "app" });
    expect(reg.all().map((d) => `${d.source}:${d.name}`)).toEqual(["builtin:help", "app:help", "app:weather"]);
    expect(reg.get("help")!.source).toBe("builtin");
    reg.clearApps();
    expect(reg.all()).toHaveLength(1);
    expect(usage(def("timeout"))).toBe("/timeout <user> <duration> [reason]");
  });
});

describe("palette filtering", () => {
  it("ranks exact, prefix, substring and subsequence matches", () => {
    expect(fuzzyScore("time", "timeout")).toBeGreaterThan(fuzzyScore("out", "timeout"));
    expect(fuzzyScore("tmt", "timeout")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "timeout")).toBe(-1);
    const names = fuzzyFilter(BUILTIN_COMMANDS, "mu", (d) => d.name).map((d) => d.name);
    expect(names.slice(0, 2)).toEqual(["mute", "unmute"]);
    expect(fuzzyFilter(BUILTIN_COMMANDS, "", (d) => d.name)).toHaveLength(BUILTIN_COMMANDS.length);
  });
});

describe("parsing", () => {
  it("recognizes command lines", () => {
    expect(parseCommandLine("/time")).toEqual({ name: "time", rest: "", complete: false });
    expect(parseCommandLine("/timeout @bob 10m spam")).toEqual({ name: "timeout", rest: "@bob 10m spam", complete: true });
    expect(parseCommandLine("hello /me")).toBeNull();
    expect(parseCommandLine("//not a command")).toBeNull();
    expect(tokenize('@bob "two words" x ')).toEqual({ tokens: ["@bob", "two words", "x"], trailingSpace: true });
  });

  it("assigns arguments, rest text, missing and invalid values", () => {
    expect(parseArgs(def("timeout"), "@bob 10m being rude")).toEqual({ values: { user: "bob", duration: "10m", reason: "being rude" }, missing: [] });
    expect(parseArgs(def("timeout"), "@bob")).toEqual({ values: { user: "bob" }, missing: ["duration"] });
    expect(parseArgs(def("me"), "  waves happily ")).toEqual({ values: { action: "waves happily" }, missing: [] });
    expect(parseArgs(def("me"), "")).toEqual({ values: {}, missing: ["action"] });
    expect(parseArgs(def("move"), "@bob #Lounge")).toEqual({ values: { user: "bob", channel: "Lounge" }, missing: [] });
    expect(parseArgs(def("nick"), "x".repeat(33)).invalid).toEqual({ arg: "name", reason: "too_long" });
    const n = { id: "", name: "n", description: "", args: [{ name: "count", description: "", type: "integer" as const, required: true, min: 1, max: 5 }], dm_allowed: true, source: "app" as const };
    expect(parseArgs(n, "9").invalid).toEqual({ arg: "count", reason: "number" });
    expect(parseArgs(n, "3").values).toEqual({ count: 3 });
  });

  it("knows durations, purge amounts and the active argument", () => {
    expect(parseDuration("10m")).toBe(600);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1d")).toBe(86400);
    expect(parseDuration("15")).toBe(900);
    expect(parseDuration("15", "s")).toBe(15);
    expect(parseDuration("soon")).toBeNull();
    expect(parsePurgeAmount("20")).toEqual({ count: 20 });
    expect(parsePurgeAmount("30m")).toEqual({ seconds: 1800 });
    expect(parsePurgeAmount("0")).toBeNull();
    expect(parsePurgeAmount("5000")).toBeNull();
    expect(activeArgIndex(def("timeout"), "", true)).toBe(0);
    expect(activeArgIndex(def("timeout"), "@bob ", true)).toBe(1);
    expect(activeArgIndex(def("timeout"), "@bob 10m some reason", true)).toBe(2);
    expect(activeArgIndex(def("timeout"), "", false)).toBe(-1);
    expect(currentToken("@bo")).toBe("@bo");
    expect(currentToken("@bob ")).toBe("");
  });

  it("resolves members by address, username, name or nickname", () => {
    const members = [member("bob", "Bob"), member("bobby", "Robert", "Bobby"), member("carol", "Carol")];
    expect(resolveMember("@bob", members).user.username).toBe("bob");
    expect(resolveMember("carol@t.local", members).user.username).toBe("carol");
    expect(resolveMember("Robert", members).user.username).toBe("bobby");
    expect(() => resolveMember("dave", members)).toThrow(CommandError);
  });
});
