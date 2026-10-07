// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { botMentionTokens, markBotMentions } from "./mentionBadges";

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
    expect(html).toContain('<span class="mention" data-testid="mention" data-bot="true">@weather@node.test</span>');
  });

  it("escapes the label and leaves html without tokens unchanged", () => {
    expect(markBotMentions("<p>@weather</p>", ["weather"], "<b>")).toContain("&lt;b&gt;");
    expect(markBotMentions("<p>@weather</p>", [], "BOT")).toBe("<p>@weather</p>");
  });
});
