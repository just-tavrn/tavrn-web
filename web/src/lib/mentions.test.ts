// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MAX_MENTIONS, extractMentions, mentionsMe } from "./mentions";

const ctx = {
  domain: "node.example",
  users: [{ address: "alice@node.example" }, { address: "bob@node.example" }, { address: "carol@other.example" }],
  roles: [
    { id: "r1", name: "Raid Leads", mentionable: true, is_everyone: false },
    { id: "r2", name: "Secret", mentionable: false, is_everyone: false },
    { id: "e", name: "@everyone", mentionable: false, is_everyone: true },
  ],
  memberRoles: { "alice@node.example": ["r1"], "bob@node.example": ["r2"] },
  canMentionEveryone: false,
};

describe("extractMentions", () => {
  it("finds local and remote users, case-insensitive and without duplicates", () => {
    expect(extractMentions("hi @Bob and @carol@other.example, @bob again", ctx)).toEqual({ mentions: ["bob@node.example", "carol@other.example"], mentions_everyone: false });
  });

  it("ignores unknown names, e-mail addresses and code", () => {
    expect(extractMentions("mail me at x@bob.example `@alice` ```\n@bob\n``` @nobody", ctx).mentions).toEqual([]);
  });

  it("expands mentionable roles to their members", () => {
    expect(extractMentions("@raid leads ready?", ctx).mentions).toEqual(["alice@node.example"]);
    expect(extractMentions("@Secret", ctx).mentions).toEqual([]);
    expect(extractMentions("@Secret", { ...ctx, canMentionEveryone: true }).mentions).toEqual(["bob@node.example"]);
  });

  it("sets @everyone/@here only with the permission", () => {
    expect(extractMentions("@everyone look", ctx).mentions_everyone).toBe(false);
    expect(extractMentions("@here look", { ...ctx, canMentionEveryone: true }).mentions_everyone).toBe(true);
  });

  it("caps at the node's limit", () => {
    const users = Array.from({ length: 60 }, (_, i) => ({ address: `u${i}@node.example` }));
    const body = users.map((u) => `@${u.address.split("@")[0]}`).join(" ");
    expect(extractMentions(body, { ...ctx, users }).mentions).toHaveLength(MAX_MENTIONS);
  });
});

describe("mentionsMe", () => {
  it("matches the address or @everyone", () => {
    expect(mentionsMe({ mentions: ["Alice@node.example"], mentions_everyone: false }, "alice@node.example")).toBe(true);
    expect(mentionsMe({ mentions: [], mentions_everyone: true }, "alice@node.example")).toBe(true);
    expect(mentionsMe({ mentions: [], mentions_everyone: false }, "alice@node.example")).toBe(false);
  });
});
