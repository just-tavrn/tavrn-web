// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./markdown";
import { markMentions, type MentionToken } from "./mentionBadges";

/** Counts the DOM passes over rendered HTML (each one parses the HTML in a template). */
function countPasses(fn: () => void): number {
  const create = document.createElement.bind(document);
  let n = 0;
  const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string, opts?: ElementCreationOptions) => {
    if (tag === "template") n++;
    return create(tag, opts);
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return n;
}

describe("renderMarkdown: post-processing passes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("typographic punctuation is no reason for the emoji pass", () => {
    for (const text of ["it’s fine", "„Anführung“ und ‚so‘", "a – b — c", "warte…", "5 €", "«guillemets» ‹x›", "‰ † •"]) {
      renderMarkdown(text);
      // Another emoji map (no cached result): only the sanitized HTML is reused.
      expect(countPasses(() => renderMarkdown(text, {}))).toBe(0);
      expect(renderMarkdown(text)).not.toContain("emoji-text");
    }
  });

  it("still marks real emojis, also next to punctuation", () => {
    const html = renderMarkdown("it’s 😀 – ✅ ok 🇩🇪 1️⃣");
    expect(html.match(/class="emoji-text"/g)).toHaveLength(4);
    expect(renderMarkdown("❤️")).toContain("emoji-only");
  });

  it("caches the final rendering: a remounted row does no DOM pass", () => {
    const urls = { party: "https://n.test/e/party.webp" };
    const first = renderMarkdown("hey 😀 :party:", urls);
    expect(countPasses(() => expect(renderMarkdown("hey 😀 :party:", urls)).toBe(first))).toBe(0);
    // Another emoji map renders again.
    expect(renderMarkdown("hey 😀 :party:", { party: "https://n.test/e/other.webp" })).toContain("other.webp");
  });

  it("applies mentions in the same pass as the emojis, with the same result as a separate pass", () => {
    const tokens: MentionToken[] = [
      { token: "weather@n.test", kind: "bot" },
      { token: "weather", kind: "bot" },
      { token: "bob", kind: "user" },
    ];
    const mentions = { tokens, key: JSON.stringify(tokens), botLabel: "BOT" };
    for (const text of ["hi @bob 😀", "@weather forecast `@bob`", "plain @bob", "no mention 🎉", "@weather@n.test – ok"]) {
      const fresh = `${text} `; // not cached yet
      let merged = "";
      const passes = countPasses(() => {
        merged = renderMarkdown(fresh, {}, undefined, mentions);
      });
      expect(passes).toBeLessThanOrEqual(1);
      expect(merged).toBe(markMentions(renderMarkdown(fresh), tokens, "BOT"));
    }
    expect(renderMarkdown("hi @bob 😀 ", {}, undefined, mentions)).toContain('data-mention="user"');
  });
});
