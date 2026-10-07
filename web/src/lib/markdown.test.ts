// SPDX-License-Identifier: Apache-2.0
import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";
import { MARKDOWN_CACHE_SIZE, configureMarkdown, emojiToken, emojiTokens, handleMarkdownClick, handleMarkdownKey, loadHighlighter, markdownVersion, parseEmojiToken, renderMarkdown, subscribeMarkdown, wrapSpoiler } from "./markdown";

const ID = "01J9ZK8Q4V6X3M2N1P0R5S7T8W";

function dom(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("renderMarkdown", () => {
  it("renders bold, code, lists and links safely", () => {
    const html = renderMarkdown("**fett** `code`\n- a\n- b\n[x](https://example.org)");
    expect(html).toContain("<strong>fett</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>a</li>");
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("neutralizes HTML, scripts and dangerous links", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script> [k](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders blockquotes", () => {
    expect(dom(renderMarkdown("> zitiert\n\nnormal")).querySelector("blockquote")?.textContent?.trim()).toBe("zitiert");
    expect(renderMarkdown("a > b")).toContain("a &gt; b");
  });

  it("turns line breaks into <br>", () => {
    expect(renderMarkdown("eins\nzwei")).toContain("<br>");
  });

  it("shows angle brackets in inline code as typed", () => {
    expect(dom(renderMarkdown("`a < b && c`")).querySelector("code")?.textContent).toBe("a < b && c");
  });

  it("parses each text once and keeps the cache bounded (least recently used entries go first)", () => {
    const parse = vi.spyOn(marked, "parse");
    try {
      const first = renderMarkdown("**cache** one");
      expect(renderMarkdown("**cache** one")).toBe(first);
      expect(parse).toHaveBeenCalledTimes(1);
      // Emoji substitution happens after the cache and does not change the cached rendering.
      expect(renderMarkdown("**cache** one :wave:", { wave: "blob:x" })).toContain('<img class="emoji" src="blob:x"');
      expect(renderMarkdown("**cache** one :wave:")).not.toContain("<img");
      parse.mockClear();
      for (let i = 0; i < MARKDOWN_CACHE_SIZE; i++) {
        renderMarkdown(`filler ${i}`);
        if (i === 10) renderMarkdown("**cache** one"); // recently used: survives
      }
      parse.mockClear();
      renderMarkdown("**cache** one");
      expect(parse).not.toHaveBeenCalled();
      renderMarkdown("filler 0"); // evicted
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });
});

describe("spoilers (design note 4.13)", () => {
  it("hides ||text|| in an accessible button-like span, also inside quotes and lists, with nested formatting", () => {
    const root = dom(renderMarkdown("a ||secret **bold**|| b\n\n> quoted ||q||\n\n- item ||l||"));
    const spoilers = root.querySelectorAll<HTMLElement>("span.spoiler");
    expect(spoilers).toHaveLength(3);
    const first = spoilers[0]!;
    expect(first.getAttribute("role")).toBe("button");
    expect(first.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("aria-label")).toBe("Spoiler");
    expect(first.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("blockquote span.spoiler")?.textContent).toBe("q");
    expect(root.querySelector("li span.spoiler")?.textContent).toBe("l");
  });

  it("needs content and closing bars; code stays literal", () => {
    expect(renderMarkdown("|| x||")).not.toContain("spoiler");
    expect(renderMarkdown("||open")).not.toContain("spoiler");
    expect(renderMarkdown("`||code||`")).toContain("<code>||code||</code>");
  });

  it("cannot be used to inject markup or attributes", () => {
    const html = renderMarkdown('||<img src=x onerror=alert(1)>|| ||" onmouseover="alert(1)|| ||[x](javascript:alert(1))||');
    const root = dom(html);
    expect(root.querySelector("img")).toBeNull();
    expect(html).not.toContain("javascript:");
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith("on")).toBe(false);
    }
  });

  it("reveals on click and on Enter, state per element", () => {
    const root = dom(renderMarkdown("||one|| ||two||"));
    const [one, two] = Array.from(root.querySelectorAll<HTMLElement>("span.spoiler"));
    expect(handleMarkdownClick(one!, () => undefined)).toBe(true);
    expect(one!.classList.contains("revealed")).toBe(true);
    expect(one!.hasAttribute("aria-label")).toBe(false);
    expect(two!.classList.contains("revealed")).toBe(false);
    const preventDefault = vi.fn();
    expect(handleMarkdownKey({ key: "Enter", target: two!, preventDefault })).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(two!.classList.contains("revealed")).toBe(true);
    expect(handleMarkdownKey({ key: "a", target: two!, preventDefault })).toBe(false);
  });

  it("uses the localized label", () => {
    configureMarkdown({ spoiler: "Spoiler anzeigen", copy: "Kopieren", wrap: "Umbrechen" });
    try {
      expect(renderMarkdown("||de||")).toContain('aria-label="Spoiler anzeigen"');
    } finally {
      configureMarkdown({ spoiler: "Spoiler", copy: "Copy", wrap: "Wrap lines" });
    }
  });

  it("wraps the selection for the composer", () => {
    expect(wrapSpoiler("hello world", 6, 11)).toEqual({ value: "hello ||world||", start: 8, end: 13 });
    expect(wrapSpoiler("x", 1, 1)).toEqual({ value: "x||||", start: 3, end: 3 });
  });
});

describe("code blocks (design note 4.13)", () => {
  it("renders a label, copy and wrap buttons and keeps the code literal", () => {
    const root = dom(renderMarkdown("```html\n<b>x</b> & <:pog:" + ID + ">\n```"));
    const block = root.querySelector("div.codeblock")!;
    expect(block.querySelector(".codeblock-lang")?.textContent).toBe("html");
    expect(block.querySelector("pre code")?.textContent).toBe(`<b>x</b> & <:pog:${ID}>\n`.trimEnd() + (block.querySelector("pre code")?.textContent?.endsWith("\n") ? "\n" : ""));
    expect(block.querySelector("b")).toBeNull();
    const copy = vi.fn();
    expect(handleMarkdownClick(block.querySelector('[data-code-action="copy"]'), copy)).toBe(true);
    expect(copy.mock.calls[0]![0]).toContain("<b>x</b>");
    const wrap = block.querySelector<HTMLElement>('[data-code-action="wrap"]')!;
    handleMarkdownClick(wrap, copy);
    expect(block.classList.contains("codeblock-wrap")).toBe(true);
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
  });

  it("highlights after highlight.js loaded, re-renders and allows only hljs classes", async () => {
    const seen = vi.fn();
    const off = subscribeMarkdown(seen);
    const before = markdownVersion();
    const src = "```rust\nfn main() { let x = 1; }\n```";
    renderMarkdown(src);
    await loadHighlighter();
    off();
    expect(seen).toHaveBeenCalled();
    expect(markdownVersion()).toBeGreaterThan(before);
    const root = dom(renderMarkdown(src));
    expect(root.querySelector("code.hljs.language-rust")).not.toBeNull();
    expect(root.querySelector("span.hljs-keyword")?.textContent).toBe("fn");
    for (const el of root.querySelectorAll("[class]")) {
      for (const c of el.classList) expect(c).toMatch(/^(hljs(-[a-z0-9_]+)*|language-[a-z0-9+#._-]+|codeblock(-[a-z]+)?)$/);
    }
  });

  it("drops forged language classes and unknown languages", async () => {
    await loadHighlighter();
    const html = renderMarkdown('```" onclick="alert(1)\nx\n```\n\n```evil class=x\ny\n```');
    expect(html).not.toContain("onclick");
    const root = dom(html);
    expect(root.querySelectorAll("div.codeblock")).toHaveLength(2);
    expect(root.querySelectorAll("code.language-evil")).toHaveLength(1);
    expect(root.querySelector(".codeblock-lang")?.textContent).toBe("");
  });

  it("auto-detects only among the bundled languages", async () => {
    await loadHighlighter();
    const root = dom(renderMarkdown("```\nimport os\ndef main():\n    print(os.getcwd())\n    return None\n```"));
    expect(root.querySelector(".codeblock-lang")?.textContent).toBe("python");
  });
});

describe("custom emoji tokens (design note 4.13)", () => {
  it("parses tokens strictly", () => {
    expect(parseEmojiToken(`<:pog:${ID}>`)).toEqual({ name: "pog", id: ID, host: null });
    expect(parseEmojiToken(`<:pog:${ID}@b.example:8443>`)).toEqual({ name: "pog", id: ID, host: "b.example:8443" });
    for (const bad of [`<:Pog:${ID}>`, `<:pog:${ID.toLowerCase()}>`, `<:pog:${ID}@evil.example/x>`, `<:pog:${ID}@u@h>`, `<:pog:${ID}@"x>`, `<:p:${ID}>`, `<:pog:${ID}@>`]) {
      expect(parseEmojiToken(bad), bad).toBeNull();
    }
    expect(emojiTokens(`a <:pog:${ID}> b <:x:${ID}> <:gg:${ID}@b.example>`).map((t) => t.name)).toEqual(["pog", "gg"]);
    expect(emojiToken("pog", ID, "a.test", "a.test")).toBe(`<:pog:${ID}>`);
    expect(emojiToken("pog", ID, "b.test", "a.test")).toBe(`<:pog:${ID}@b.test>`);
  });

  it("renders tokens through the resolver, never the room emoji of the same name, literal in code", () => {
    const resolve = vi.fn((t: { id: string; host: string | null }) => `https://${t.host ?? "here"}/api/v1/emojis/${t.id}/image`);
    const html = renderMarkdown(`hi <:pog:${ID}@b.example> and :pog: \`<:pog:${ID}>\``, { pog: "blob:room" }, resolve);
    const root = dom(html);
    const imgs = root.querySelectorAll("img.emoji");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toBe(`https://b.example/api/v1/emojis/${ID}/image`);
    expect(imgs[1]!.getAttribute("src")).toBe("blob:room");
    expect(root.querySelector("code")?.textContent).toBe(`<:pog:${ID}>`);
    // Without a resolver (or when it gives up) the name stays as text.
    expect(dom(renderMarkdown(`<:pog:${ID}>`, { pog: "blob:room" })).textContent?.trim()).toBe(":pog:");
    expect(dom(renderMarkdown(`<:pog:${ID}>`, {}, () => null)).querySelector("img")).toBeNull();
  });

  it("does not let tokens or placeholders inject URLs or markup", () => {
    const resolve = (t: { id: string; host: string | null }) => `https://${t.host}/e/${t.id}`;
    const html = renderMarkdown(`<:pog:${ID}@evil.example"onerror="alert(1)> 0 <:x:${ID}@a.b/../c>`, {}, resolve);
    const root = dom(html);
    expect(root.querySelector("img")).toBeNull();
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith("on")).toBe(false);
    }
  });
});

describe("renderDocument (legal pages)", () => {
  it("keeps headings, lists and tables and drops markup, images and unsafe links", async () => {
    const { renderDocument } = await import("./markdown");
    const html = renderDocument("# Title\n\n## Sub\n\n- a\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<iframe src=x></iframe> <b onclick=x>b</b>\n\n[ok](https://a.example) [bad](javascript:alert(1)) [rel](/legal/terms) ![t](https://t.example/p.gif)");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Sub</h2>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<b[^>]*onclick/);
    expect(html).toContain("&lt;b onclick=x&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://a.example"');
    expect(html).toContain('href="/legal/terms"');
  });
});
