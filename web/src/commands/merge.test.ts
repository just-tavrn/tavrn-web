// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type Member, type PaletteCommand, type RoomDetail } from "@tavrn/sdk";
import { BUILTIN_COMMANDS } from "./builtin";
import { CommandError, invokeRequest, resolveAppArgs } from "./execute";
import { appDefinitions, choiceSuggestions, commandKey, mergePalette, resolveCommand } from "./merge";
import { availableCommands, builtinRegistry } from "./registry";

const app = (ref: string, name: string) => ({ ref, name, bot: `${name.toLowerCase()}@node.test` });
const WEATHER = app("node.test/01J9ZK3G5M8Q2W4E6R8T0Y2W01", "WeatherBot");
const CLIMA = app("other.test/01J9ZK3G5M8Q2W4E6R8T0Y2W02", "Clima");

function palette(id: string, name: string, application: ReturnType<typeof app>, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, ref: `${application.ref}/${id}`, name, description: `${name} by ${application.name}`, args: [], permission: "0", source: "app", application, dm_allowed: false, ...extra };
}

const member = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const builtins = (perms: bigint, direct = false) => availableCommands(builtinRegistry(), { permissions: perms, direct, hasVoice: false });

describe("the / palette (APPLICATIONS.md §5.4)", () => {
  const list = appDefinitions([
    palette("C1", "weather", WEATHER, {
      args: [
        { name: "city", description: "City", type: "string", required: true, max_length: 100 },
        { name: "units", description: "Units", type: "string", options: [{ name: "Metric", value: "metric" as never }, { name: "Imperial", value: "imperial" as never }] },
      ],
      dm_allowed: true,
    }),
    palette("C2", "weather", CLIMA),
    palette("C3", "help", WEATHER),
    palette("C4", "purge-all", WEATHER, { permission: Permission.MANAGE_MESSAGES.toString() }),
  ]);

  it("puts built-ins first and qualifies names used by a built-in or another application", () => {
    const merged = mergePalette(builtins(member), list, { permissions: member, direct: false });
    const names = merged.map((d) => `${d.source}:${d.name}${d.qualifier ? `·${d.qualifier}` : ""}`);
    expect(names.slice(0, builtins(member).length).every((n) => n.startsWith("builtin:"))).toBe(true);
    expect(names.slice(builtins(member).length)).toEqual(["app:weather·WeatherBot", "app:weather·Clima", "app:help·WeatherBot"]);
    expect(merged.find((d) => d.id === "C1")!.args[1]!.options).toEqual([{ name: "Metric", value: "metric" }, { name: "Imperial", value: "imperial" }]);
  });

  it("filters application commands by the effective mask and DMs", () => {
    const all = mergePalette(builtins(ALL_PERMISSIONS), list, { permissions: ALL_PERMISSIONS, direct: false });
    expect(all.some((d) => d.name === "purge-all")).toBe(true);
    const dm = mergePalette(builtins(member, true), list, { permissions: member, direct: true });
    expect(dm.filter((d) => d.source === "app").map((d) => d.id)).toEqual(["C1"]);
    // A single application command keeps its plain name.
    const single = mergePalette(builtins(member), list.slice(0, 1), { permissions: member, direct: false });
    expect(single.at(-1)!.qualifier).toBeUndefined();
  });

  it("binds a selection to the command's id, never resolving across sources by name", () => {
    const merged = mergePalette(builtins(member), list, { permissions: member, direct: false });
    const clima = merged.find((d) => d.id === "C2")!;
    const help = merged.find((d) => d.id === "C3")!;
    expect(resolveCommand(merged, "weather", clima)).toEqual({ def: clima });
    expect(resolveCommand(merged, "help", help)).toEqual({ def: help });
    // Typed without picking: the built-in wins, two applications are ambiguous.
    expect((resolveCommand(merged, "help") as { def: { source: string } }).def.source).toBe("builtin");
    expect((resolveCommand(merged, "weather") as { ambiguous: unknown[] }).ambiguous).toHaveLength(2);
    expect(resolveCommand(merged, "nothing")).toBeNull();
    // A pick for another name does not stick.
    expect((resolveCommand(merged, "help", clima) as { def: { source: string } }).def.source).toBe("builtin");
    expect(commandKey(clima)).toBe("app:C2");
    expect(commandKey(BUILTIN_COMMANDS[0]!)).toBe("builtin:help");
  });

  it("suggests pick-list choices and booleans", () => {
    const units = list[0]!.args[1]!;
    expect(choiceSuggestions(units, "").map((s) => s.value)).toEqual(["metric", "imperial"]);
    expect(choiceSuggestions(units, "imp")).toEqual([{ value: "imperial", label: "Imperial (imperial)" }]);
    const spaced = { ...units, options: [{ name: "New York", value: "New York" }] };
    expect(choiceSuggestions(spaced, "")).toEqual([{ value: '"New York"', label: "New York" }]);
    expect(choiceSuggestions({ name: "loud", description: "", type: "boolean", required: false }, "t")).toEqual([{ value: "true", label: "true" }]);
    expect(choiceSuggestions({ name: "city", description: "", type: "string", required: true }, "x")).toEqual([]);
  });
});

describe("application command arguments", () => {
  const members = [{ user: { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob" }, nick: "Bobby", roles: [], joined_at: "" }] as unknown as Member[];
  const room = { channels: [{ id: "CH1", name: "general", kind: "text" }], roles: [{ id: "R1", name: "Mods" }] } as unknown as RoomDetail;
  const def = {
    id: "C",
    name: "x",
    description: "",
    dm_allowed: false,
    source: "app" as const,
    args: [
      { name: "who", description: "", type: "user" as const, required: true },
      { name: "where", description: "", type: "channel" as const, required: false },
      { name: "role", description: "", type: "role" as const, required: false },
      { name: "n", description: "", type: "integer" as const, required: false },
    ],
  };

  it("sends addresses and ids, not names", () => {
    expect(resolveAppArgs(def, { who: "bob", where: "#general", role: "mods", n: 3 }, { members, room })).toEqual({ who: "bob@t.local", where: "CH1", role: "R1", n: 3 });
    expect(resolveAppArgs(def, { who: "carol@other.test" }, { members, room })).toEqual({ who: "carol@other.test" });
    expect(() => resolveAppArgs(def, { who: "nobody" }, { members, room })).toThrow(CommandError);
    expect(() => resolveAppArgs(def, { who: "bob", where: "#nowhere" }, { members, room })).toThrow(CommandError);
    expect(() => resolveAppArgs(def, { who: "bob", role: "admins" }, { members, room })).toThrow(CommandError);
  });
});

describe("invokeRequest (APPLICATIONS.md §5.5)", () => {
  it("names the thread the command is invoked in, so the bot answers there", () => {
    expect(invokeRequest("node.test/A/C", { args: { city: "Köln" } }, null)).toEqual({ command: "node.test/A/C", args: { city: "Köln" } });
    expect(invokeRequest("node.test/A/C", { args_ciphertext: "CT", epoch: 3 }, "01J9ZK3G5M8Q2W4E6R8T0Y2TH1")).toEqual({ command: "node.test/A/C", args_ciphertext: "CT", epoch: 3, thread_id: "01J9ZK3G5M8Q2W4E6R8T0Y2TH1" });
  });
});
