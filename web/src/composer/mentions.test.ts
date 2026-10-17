// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Permission, type Member, type Role, type User } from "@tavrn/sdk";
import { applyCompletion, findTrigger } from "./autocomplete";
import { channelMentionCandidates, directMentionCandidates, matchMentions, mentionProvider, type MentionCandidate } from "./mentions";
import { extractMentions, type MentionContext } from "../lib/mentions";

const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();
const VIEW = bits(Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES);

const role = (id: string, name: string, extra: Partial<Role> = {}): Role => ({ id, name, is_everyone: false, mentionable: false, permissions: "0", position: 1, hoist: false, room_id: "r", color: null, ...extra });
const roles: Role[] = [role("everyone", "@everyone", { is_everyone: true, permissions: VIEW, position: 0 }), role("staff", "Mod Team", { mentionable: true, color: "#ff0000" }), role("quiet", "Stille Gruppe")];

const user = (address: string, extra: Partial<User> = {}): User => {
  const [username, domain] = address.split("@") as [string, string];
  return { id: username, address, username, domain, display_name: username[0]!.toUpperCase() + username.slice(1), kind: "user", is_node_admin: false, created_at: "", ...extra };
};
const member = (address: string, memberRoles: string[] = [], extra: Partial<Member> = {}, u: Partial<User> = {}): Member =>
  ({ user: user(address, u), roles: memberRoles, joined_at: "", room_avatar_animated: false, ...extra }) as Member;

const members = [
  member("alice@a.example", [], { nickname: "Ali" }),
  member("bob@a.example", ["staff"]),
  member("carol@b.example"),
  member("helper@a.example", [], {}, { kind: "bot", display_name: "Helper" }),
  member("me@a.example"),
  member("hidden@a.example"),
];
const room = {
  owner_id: "nobody",
  roles,
  // "secret": only the staff role and carol (a member override) see it; hidden@ is denied the general channel.
  overrides: [
    { target_type: "channel", target_id: "secret", subject_type: "role", subject_id: "everyone", allow: "0", deny: bits(Permission.VIEW_CHANNEL) },
    { target_type: "channel", target_id: "secret", subject_type: "role", subject_id: "staff", allow: bits(Permission.VIEW_CHANNEL), deny: "0" },
    { target_type: "channel", target_id: "secret", subject_type: "member", subject_id: "carol", allow: bits(Permission.VIEW_CHANNEL), deny: "0" },
    { target_type: "channel", target_id: "general", subject_type: "member", subject_id: "hidden", allow: "0", deny: bits(Permission.VIEW_CHANNEL) },
  ],
  channels: [
    { id: "general", category_id: null, kind: "text" },
    { id: "secret", category_id: null, kind: "text" },
  ],
};

const keys = (list: MentionCandidate[]) => list.map((c) => c.key);

describe("mention candidates", () => {
  it("channels: members who can view this channel, mentionable roles; @everyone/@here only with the right", () => {
    const general = channelMentionCandidates({ room, channelId: "general", members, domain: "a.example", self: "me@a.example", canMentionEveryone: false });
    expect(keys(general)).toEqual(["alice@a.example", "bob@a.example", "carol@b.example", "helper@a.example", "me@a.example", "role:staff"]);
    const secret = channelMentionCandidates({ room, channelId: "secret", members, domain: "a.example", self: "me@a.example", canMentionEveryone: false });
    expect(keys(secret)).toEqual(["bob@a.example", "carol@b.example", "role:staff"]);
    // With mention_everyone: every role (also the non-mentionable ones) and @everyone/@here.
    const all = channelMentionCandidates({ room, channelId: "general", members, domain: "a.example", self: "me@a.example", canMentionEveryone: true });
    expect(keys(all).slice(-4)).toEqual(["role:staff", "role:quiet", "everyone", "here"]);
  });

  it("channels: names, inserted text, bots, remote domains and the own user", () => {
    const list = channelMentionCandidates({ room, channelId: "general", members, domain: "a.example", self: "me@a.example", canMentionEveryone: false });
    const by = (k: string) => list.find((c) => c.key === k)!;
    expect(by("alice@a.example")).toMatchObject({ kind: "user", name: "Ali", insert: "@alice", remote: null, bot: false, self: false });
    expect(by("carol@b.example")).toMatchObject({ insert: "@carol@b.example", remote: "b.example" });
    expect(by("helper@a.example")).toMatchObject({ bot: true });
    expect(by("me@a.example")).toMatchObject({ self: true });
    expect(by("role:staff")).toMatchObject({ kind: "role", name: "Mod Team", insert: "@Mod Team", color: "#ff0000" });
  });

  it("DMs and group DMs: the participants only, no roles, no @everyone", () => {
    const list = directMentionCandidates({ people: [user("me@a.example"), user("dora@a.example"), user("eve@c.example")], domain: "a.example", self: "me@a.example" });
    expect(keys(list)).toEqual(["me@a.example", "dora@a.example", "eve@c.example"]);
    expect(list[2]).toMatchObject({ insert: "@eve@c.example", remote: "c.example" });
  });
});

describe("mention matching", () => {
  const list = channelMentionCandidates({ room, channelId: "general", members, domain: "a.example", self: "me@a.example", canMentionEveryone: true });

  it("matches display name, nickname and username by prefix and fuzzily, the own user last", () => {
    expect(keys(matchMentions(list, "ali"))[0]).toBe("alice@a.example");
    // The username matches as well as the shown name.
    expect(keys(matchMentions(list, "alice"))[0]).toBe("alice@a.example");
    expect(keys(matchMentions(list, "bo"))[0]).toBe("bob@a.example");
    expect(keys(matchMentions(list, "every"))).toEqual(["everyone"]);
    expect(keys(matchMentions(list, "mod"))).toContain("role:staff");
    // An empty query: everybody (the own user last), at most eight rows.
    const empty = matchMentions(list, "");
    expect(empty.length).toBeLessThanOrEqual(8);
    expect(keys(empty)).not.toContain("me@a.example");
    expect(keys(matchMentions(list, "m")).at(-1)).toBe("me@a.example");
  });

  it("a query with a space matches by prefix only (role names), else nothing: typing just continues", () => {
    expect(keys(matchMentions(list, "Mod T"))).toEqual(["role:staff"]);
    expect(matchMentions(list, "bob und ")).toEqual([]);
    expect(matchMentions(list, "zzz")).toEqual([]);
  });

  it("the provider offers suggestions with their inserted text", () => {
    const provider = mentionProvider(list);
    expect(provider.trigger).toBe("@");
    expect(provider.suggest("car")[0]).toMatchObject({ key: "carol@b.example", insert: "@carol@b.example" });
  });
});

describe("inserted mentions round-trip through extractMentions", () => {
  const ctx: MentionContext = {
    domain: "a.example",
    users: members.map((m) => ({ address: m.user.address })),
    roles,
    memberRoles: Object.fromEntries(members.map((m) => [m.user.address, m.roles])),
    canMentionEveryone: true,
  };
  const list = channelMentionCandidates({ room, channelId: "general", members, domain: "a.example", self: "me@a.example", canMentionEveryone: true });

  it.each(list.map((c) => [c.key, c] as const))("%s", (_key, c) => {
    // Typed in the middle of a sentence, completed, then more text: what the composer produces.
    const typed = "hallo @x und weiter";
    const trigger = findTrigger(typed, 8, "@")!;
    const { value } = applyCompletion(typed, trigger, c.insert);
    const out = extractMentions(value, ctx);
    if (c.kind === "user") expect(out.mentions).toContain(c.key);
    else if (c.kind === "role") expect(out.mentions).toEqual(members.filter((m) => m.roles.includes(c.key.slice(5))).map((m) => m.user.address));
    else expect(out.mentions_everyone).toBe(true);
    // And at the very end of the text, with the trailing space.
    expect(extractMentions(`${c.insert} `, ctx)).toEqual(out);
  });

  it("DM forms round-trip as well", () => {
    const people = [user("me@a.example"), user("dora@a.example"), user("eve@c.example")];
    const dm: MentionContext = { domain: "a.example", users: people.map((p) => ({ address: p.address })), canMentionEveryone: false };
    for (const c of directMentionCandidates({ people, domain: "a.example", self: "me@a.example" })) {
      expect(extractMentions(`${c.insert} hi`, dm).mentions).toEqual([c.key]);
    }
  });
});
