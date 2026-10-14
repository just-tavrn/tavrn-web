// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { botMentionTokens, markBotMentions, markMentions, mentionTokens, parseMentionTokens, serializeMentionTokens } from "./mentionBadges";

describe("BOT badges on mentions", () => {
  const bots = new Set(["weather@node.test", "helper@other.test"]);

  it("finds the mentioned bots and their spellings", () => {
    expect(botMentionTokens(["weather@node.test", "alice@node.test"], bots, "node.test")).toEqual(["weather@node.test", "weather"]);
    expect(botMentionTokens(["helper@other.test"], bots, "node.test")).toEqual(["helper@other.test"]);
    expect(botMentionTokens([], bots, "node.test")).toEqual([]);
    expect(botMentionTokens(["weather@node.test"], undefined, "node.test")).toEqual([]);
  });

  it("marks mentions in text, never in code, tags or other names", () => {
    const tokens = botMentionTokens(["weather@node.test"], bots, "node.test");
    const html = markBotMentions("<p>hi @weather and @weatherman, <code>@weather</code> <a href=\"x@weather\">@weather@node.test</a></p>", tokens, "BOT");
    expect(html.match(/data-testid="mention"/g)).toHaveLength(2);
    expect(html).toContain("@weatherman,");
    expect(html).toContain("<code>@weather</code>");
    expect(html).toContain('href="x@weather"');
    expect(html).toContain('<span class="mention" data-testid="mention" data-mention="bot" data-bot="true">@weather@node.test</span>');
  });

  it("escapes the label and leaves html without tokens unchanged", () => {
    expect(markBotMentions("<p>@weather</p>", ["weather"], "<b>")).toContain("&lt;b&gt;");
    expect(markBotMentions("<p>@weather</p>", [], "BOT")).toBe("<p>@weather</p>");
  });
});

describe("mention pills (tavrn-web#122)", () => {
  const bots = new Set(["weather@node.test"]);
  const msg = { mentions: ["Alice@node.test", "bob@other.test", "weather@node.test"], mentions_everyone: true };

  it("names every spelling with its kind, the reader as self, longest first", () => {
    const tokens = mentionTokens(msg, { bots, self: "alice@node.test", nodeDomain: "node.test", roles: ["Raid Leads", "Mod", "@everyone"] });
    expect(tokens).toEqual([
      { token: "weather@node.test", kind: "bot" },
      { token: "alice@node.test", kind: "self" },
      { token: "bob@other.test", kind: "user" },
      { token: "Raid Leads", kind: "role" },
      { token: "everyone", kind: "everyone" },
      { token: "weather", kind: "bot" },
      { token: "alice", kind: "self" },
      { token: "here", kind: "everyone" },
      { token: "Mod", kind: "role" },
    ]);
    // @everyone and @here only when the message mentions everyone; the @everyone role is never a role token.
    expect(mentionTokens({ mentions: [], mentions_everyone: false }, { nodeDomain: "node.test", roles: ["@everyone"] })).toEqual([]);
  });

  it("wraps mentions with the kind; roles with spaces; nothing inside code or other words", () => {
    const tokens = mentionTokens(msg, { bots, self: "alice@node.test", nodeDomain: "node.test", roles: ["Raid Leads"] });
    const html = markMentions("<p>@alice @Alice@node.test @bob@other.test @everyone @here @Raid Leads ready? @raid @alicey <code>@alice</code></p>", tokens, "BOT");
    expect(html).toContain('<span class="mention" data-testid="mention" data-mention="self">@alice</span> ');
    expect(html).toContain('data-mention="self">@Alice@node.test</span>');
    expect(html).toContain('data-mention="user">@bob@other.test</span>');
    expect(html).toContain('data-mention="everyone">@everyone</span>');
    expect(html).toContain('data-mention="everyone">@here</span>');
    expect(html).toContain('data-mention="role">@Raid Leads</span> ready?');
    expect(html).toContain(" @raid @alicey ");
    expect(html).toContain("<code>@alice</code>");
    expect(html.match(/data-testid="mention"/g)).toHaveLength(6);
    expect(html).not.toContain("bot-mention-badge");
  });

  it("bots keep the badge next to the pill", () => {
    const tokens = mentionTokens({ mentions: ["weather@node.test"] }, { bots, nodeDomain: "node.test" });
    const html = markMentions("<p>@weather?</p>", tokens, "BOT");
    expect(html).toBe('<p><span class="mention" data-testid="mention" data-mention="bot" data-bot="true">@weather</span><span class="bot-mention-badge" data-testid="bot-badge">BOT</span>?</p>');
  });

  it("round-trips through the string form for memoised rows", () => {
    const tokens = mentionTokens(msg, { bots, self: "alice@node.test", nodeDomain: "node.test", roles: ["Mod"] });
    expect(parseMentionTokens(serializeMentionTokens(tokens))).toEqual(tokens);
    expect(serializeMentionTokens([])).toBe("");
    expect(parseMentionTokens("")).toEqual([]);
    expect(parseMentionTokens("{nope")).toEqual([]);
  });
});
