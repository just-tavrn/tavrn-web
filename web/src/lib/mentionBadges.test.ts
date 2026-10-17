// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { botMentionTokens, markBotMentions, markMentions, mentionDirectory, mentionTokens, parseMentionTokens, serializeMentionTokens } from "./mentionBadges";

describe("BOT badges on mentions", () => {
  const bots = new Set(["weather@node.test", "helper@other.test"]);

  it("finds the mentioned bots and their spellings", () => {
    expect(botMentionTokens(["weather@node.test", "alice@node.test"], bots, "node.test")).toEqual(["weather@node.test", "weather"]);
    expect(botMentionTokens(["helper@other.test"], bots, "node.test")).toEqual(["helper@other.test"]);
    expect(botMentionTokens([], bots, "node.test")).toEqual([]);
    expect(botMentionTokens(["weather@node.test"], undefined, "node.test")).toEqual([]);
  });

  it("marks mentions in text, never in code, links, tags or other names", () => {
    const tokens = botMentionTokens(["weather@node.test"], bots, "node.test");
    const html = markBotMentions("<p>hi @weather and @weatherman, @weather@node.test <code>@weather</code> <a href=\"x@weather\">@weather@node.test</a></p>", tokens, "BOT");
    expect(html.match(/data-testid="mention"/g)).toHaveLength(2);
    expect(html).toContain("@weatherman,");
    expect(html).toContain("<code>@weather</code>");
    // A pill inside a link would be a control inside a control: the link keeps its text.
    expect(html).toContain('<a href="x@weather">@weather@node.test</a>');
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
      { token: "weather@node.test", kind: "bot", target: "weather@node.test" },
      { token: "alice@node.test", kind: "self", target: "alice@node.test" },
      { token: "bob@other.test", kind: "user", target: "bob@other.test" },
      { token: "Raid Leads", kind: "role", target: "Raid Leads" },
      { token: "everyone", kind: "everyone" },
      { token: "weather", kind: "bot", target: "weather@node.test" },
      { token: "alice", kind: "self", target: "alice@node.test" },
      { token: "here", kind: "everyone" },
      { token: "Mod", kind: "role", target: "Mod" },
    ]);
    // @everyone and @here only when the message mentions everyone; the @everyone role is never a role token.
    expect(mentionTokens({ mentions: [], mentions_everyone: false }, { nodeDomain: "node.test", roles: ["@everyone"] })).toEqual([]);
  });

  it("wraps mentions with the kind; roles with spaces; nothing inside code or other words", () => {
    const tokens = mentionTokens(msg, { bots, self: "alice@node.test", nodeDomain: "node.test", roles: ["Raid Leads"] });
    const html = markMentions("<p>@alice @Alice@node.test @bob@other.test @everyone @here @Raid Leads ready? @raid @alicey <code>@alice</code></p>", tokens, "BOT");
    const button = 'role="button" tabindex="0" aria-haspopup="dialog"';
    expect(html).toContain(`<span class="mention" data-testid="mention" data-mention="self" data-address="alice@node.test" ${button}>@alice</span> `);
    expect(html).toContain(`data-mention="self" data-address="alice@node.test" ${button}>@Alice@node.test</span>`);
    expect(html).toContain(`data-mention="user" data-address="bob@other.test" ${button}>@bob@other.test</span>`);
    // @everyone and @here are no buttons: there is nothing to open.
    expect(html).toContain('data-mention="everyone">@everyone</span>');
    expect(html).toContain('data-mention="everyone">@here</span>');
    expect(html).toContain(`data-mention="role" data-role="Raid Leads" ${button}>@Raid Leads</span> ready?`);
    expect(html).toContain(" @raid @alicey ");
    expect(html).toContain("<code>@alice</code>");
    expect(html.match(/data-testid="mention"/g)).toHaveLength(6);
    expect(html).not.toContain("bot-mention-badge");
  });

  it("bots keep the badge next to the pill", () => {
    const tokens = mentionTokens({ mentions: ["weather@node.test"] }, { bots, nodeDomain: "node.test" });
    const html = markMentions("<p>@weather?</p>", tokens, "BOT");
    expect(html).toBe('<p><span class="mention" data-testid="mention" data-mention="bot" data-bot="true" data-address="weather@node.test" role="button" tabindex="0" aria-haspopup="dialog">@weather</span><span class="bot-mention-badge" data-testid="bot-badge">BOT</span>?</p>');
  });

  it("a role named like a mentioned bot or member does not take over their mention (the bot's managed role)", () => {
    // An application's managed role carries its name; its bot's username is the same name in lower case.
    const tokens = mentionTokens({ mentions: ["weather@node.test", "alice@node.test"] }, { bots, self: "alice@node.test", nodeDomain: "node.test", roles: ["Weather", "Alice", "Mod"] });
    expect(tokens.filter((t) => t.token.toLowerCase() === "weather")).toEqual([{ token: "weather", kind: "bot", target: "weather@node.test" }]);
    expect(tokens.filter((t) => t.token.toLowerCase() === "alice")).toEqual([{ token: "alice", kind: "self", target: "alice@node.test" }]);
    const html = markMentions("<p>Danke @weather! @alice @Mod</p>", tokens, "BOT");
    expect(html).toContain('data-mention="bot" data-bot="true" data-address="weather@node.test" role="button" tabindex="0" aria-haspopup="dialog">@weather</span><span class="bot-mention-badge" data-testid="bot-badge">BOT</span>!');
    expect(html).toContain('data-mention="self" data-address="alice@node.test"');
    expect(html).toContain('data-mention="role" data-role="Mod"');
  });

  it("round-trips through the string form for memoised rows", () => {
    const tokens = mentionTokens(msg, { bots, self: "alice@node.test", nodeDomain: "node.test", roles: ["Mod"] });
    expect(parseMentionTokens(serializeMentionTokens(tokens))).toEqual(tokens);
    expect(serializeMentionTokens([])).toBe("");
    expect(parseMentionTokens("")).toEqual([]);
    expect(parseMentionTokens("{nope")).toEqual([]);
  });
});

describe("mentions of members without a mentions list (bot cards)", () => {
  const directory = mentionDirectory(["Alice@node.test", "bob@other.test", "weather@node.test", "me@node.test"], { bots: new Set(["weather@node.test"]), self: "me@node.test", nodeDomain: "node.test" });

  it("marks @name@domain and @name of members, nobody else, never in code or links", () => {
    const html = markMentions("<p>Tank: @alice@node.test, @bob@other.test. Lead @alice; @me @weather! @carol@node.test @bob @alice@node.test.x <code>@alice</code> <a href=\"https://x.test\">@alice</a></p>", [], "BOT", directory);
    expect(html).toContain('data-mention="user" data-address="alice@node.test" role="button" tabindex="0" aria-haspopup="dialog">@alice@node.test</span>,');
    expect(html).toContain('data-address="bob@other.test" role="button" tabindex="0" aria-haspopup="dialog">@bob@other.test</span>.');
    expect(html).toContain('data-address="alice@node.test" role="button" tabindex="0" aria-haspopup="dialog">@alice</span>;');
    expect(html).toContain('data-mention="self" data-address="me@node.test"');
    expect(html).toContain('data-mention="bot" data-bot="true" data-address="weather@node.test" role="button" tabindex="0" aria-haspopup="dialog">@weather</span><span class="bot-mention-badge" data-testid="bot-badge">BOT</span>!');
    // Not a member, a bare name of another node, or part of a longer word: plain text.
    expect(html).toContain(" @carol@node.test @bob @alice@node.test.x ");
    expect(html).toContain("<code>@alice</code>");
    expect(html).toContain('<a href="https://x.test">@alice</a>');
    expect(html.match(/data-testid="mention"/g)).toHaveLength(5);
  });

  it("listed mentions keep their kind; the directory adds the rest", () => {
    const tokens = mentionTokens({ mentions: ["bob@other.test"] }, { nodeDomain: "node.test" });
    const html = markMentions("<p>@bob@other.test and @alice</p>", tokens, "BOT", directory);
    expect(html.match(/data-testid="mention"/g)).toHaveLength(2);
    expect(html).toContain('data-address="alice@node.test"');
  });

  it("a text without @ or an empty directory is left alone", () => {
    expect(markMentions("<p>hello</p>", [], "BOT", directory)).toBe("<p>hello</p>");
    expect(markMentions("<p>@alice</p>", [], "BOT", mentionDirectory([], { nodeDomain: "node.test" }))).toBe("<p>@alice</p>");
  });
});
