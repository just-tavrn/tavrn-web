// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderMarkdown, type MarkdownLinks, type MarkdownMentions } from "./markdown";
import { mentionDirectory } from "./mentionBadges";

const R = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const C = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const M = "01JMMMMMMMMMMMMMMMMMMMMMMM";
const F = "01JFFFFFFFFFFFFFFFFFFFFFFF";

const links: MarkdownLinks = {
  known: [
    { domain: "node.test", web: "https://node.test" },
    { domain: "other.test", web: "https://chat.other.test" },
  ],
  key: "k1",
  home: (d) => d === "node.test",
};
const directory = mentionDirectory(["alice@node.test", "bob@other.test"], { nodeDomain: "node.test" });
const mentions: MarkdownMentions = { tokens: [], key: "", botLabel: "BOT", directory };

const dom = (html: string) => {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
};

describe("markdown: addresses are not e-mail links", () => {
  it("keeps @name@domain as text (also without a directory), so the mention pass can mark it", () => {
    for (const src of ["@alice@node.test", "hi @alice@node.test!", "**@alice@node.test**", "Tank: @a.b-c@node.test, @x@y.test"]) {
      const html = renderMarkdown(src);
      expect(html, src).not.toContain("mailto:");
      expect(html, src).not.toContain("<a ");
    }
    expect(renderMarkdown("hi @alice@node.test!")).toContain("hi @alice@node.test!");
  });

  it("a mentioned member becomes a pill, not a link", () => {
    const html = renderMarkdown("Lead @alice@node.test and @bob@other.test", undefined, undefined, mentions);
    const pills = dom(html).querySelectorAll(".mention");
    expect([...pills].map((p) => p.getAttribute("data-address"))).toEqual(["alice@node.test", "bob@other.test"]);
    expect(html).not.toContain("mailto:");
  });

  it("a bare address stays a mailto link unless it is a member of the conversation", () => {
    const html = renderMarkdown("write to carol@mail.test or alice@node.test", undefined, undefined, mentions);
    const fragment = dom(html);
    expect(fragment.querySelector('a[href="mailto:carol@mail.test"]')?.textContent).toBe("carol@mail.test");
    expect(fragment.querySelector('a[href="mailto:alice@node.test"]')).toBeNull();
    expect(fragment.querySelector('.mention[data-address="alice@node.test"]')?.textContent).toBe("alice@node.test");
  });

  it("keeps explicit mailto links, even to a member", () => {
    const html = renderMarkdown("[mail me](mailto:alice@node.test) [alice@node.test](mailto:alice@node.test)", undefined, undefined, mentions);
    const anchors = dom(html).querySelectorAll('a[href="mailto:alice@node.test"]');
    expect(anchors).toHaveLength(2);
    expect(dom(html).querySelector(".mention")).toBeNull();
  });

  it("mentions and addresses in code stay literal", () => {
    const html = renderMarkdown("`@alice@node.test` and\n\n```\nalice@node.test\n```", undefined, undefined, mentions);
    expect(html).not.toContain("mailto:");
    expect(dom(html).querySelector(".mention")).toBeNull();
    expect(html).toContain("@alice@node.test</code>");
  });
});

describe("markdown: tavrn links", () => {
  it("turns bare links of known nodes into in-app chips with their target", () => {
    const html = renderMarkdown(`see https://node.test/rooms/${R}/channels/${C} and https://chat.other.test/rooms/${R}/channels/${C}?message=${M}`, undefined, undefined, undefined, links);
    const chips = [...dom(html).querySelectorAll<HTMLAnchorElement>("a.tavrn-chip")];
    expect(chips.map((a) => a.getAttribute("href"))).toEqual([`/rooms/${R}/channels/${C}`, `/n/other.test/rooms/${R}/channels/${C}?m=${M}`]);
    expect(chips.map((a) => a.dataset.tavrnLink)).toEqual(["channel", "message"]);
    expect(chips[1]!.dataset.node).toBe("other.test");
    expect(chips[1]!.dataset.target).toBe(M);
    // In-app: no new tab, no rel juggling, nothing of the original anchor left.
    expect(chips[0]!.hasAttribute("target")).toBe(false);
  });

  it("covers files, invites and rooms; profile links become user pills", () => {
    const html = renderMarkdown(`https://node.test/rooms/${R}/channels/${C}/files/${F} https://node.test/invite/AbCd12 https://node.test/rooms/${R} https://node.test/u/bob@other.test`, undefined, undefined, mentions, links);
    const fragment = dom(html);
    expect([...fragment.querySelectorAll<HTMLElement>("a.tavrn-chip")].map((a) => [a.dataset.tavrnLink, a.dataset.target ?? null])).toEqual([
      ["file", F],
      ["invite", "AbCd12"],
      ["room", null],
    ]);
    expect(fragment.querySelector('.mention[data-address="bob@other.test"]')?.textContent).toBe("@bob@other.test");
  });

  it("a labelled link keeps its label and navigates in the app", () => {
    const html = renderMarkdown(`[the raid channel](https://node.test/rooms/${R}/channels/${C})`, undefined, undefined, undefined, links);
    const a = dom(html).querySelector<HTMLAnchorElement>("a.tavrn-link")!;
    expect(a.textContent).toBe("the raid channel");
    expect(a.getAttribute("href")).toBe(`/rooms/${R}/channels/${C}`);
  });

  it("leaves unknown hosts, look-alikes and credentials as plain external links", () => {
    for (const url of [`https://unknown.test/rooms/${R}`, `https://node.test.evil.test/rooms/${R}`, `https://evil@node.test/rooms/${R}`, `https://xn--nde-ple.test/rooms/${R}`]) {
      const html = renderMarkdown(url, undefined, undefined, undefined, links);
      const a = dom(html).querySelector("a")!;
      expect(a.classList.contains("tavrn-chip"), url).toBe(false);
      expect(a.getAttribute("target"), url).toBe("_blank");
      expect(a.getAttribute("rel"), url).toContain("noopener");
    }
  });

  it("links in code stay literal", () => {
    const html = renderMarkdown(`\`https://node.test/rooms/${R}\`\n\n\`\`\`\nhttps://node.test/invite/AbCd12\n\`\`\``, undefined, undefined, undefined, links);
    expect(dom(html).querySelector("a")).toBeNull();
    expect(html).toContain(`https://node.test/rooms/${R}</code>`);
  });

  it("never lets a link produce script URLs or attributes", () => {
    const html = renderMarkdown(`[x](javascript:alert(1)) https://node.test/rooms/${R}"onmouseover="alert(1) <a href="https://node.test/rooms/${R}">raw</a>`, undefined, undefined, undefined, links);
    const fragment = dom(html);
    for (const el of fragment.querySelectorAll("*")) {
      expect(el.getAttributeNames().filter((n) => n.startsWith("on")), el.outerHTML).toEqual([]);
      expect(el.getAttribute("href") ?? "", el.outerHTML).not.toMatch(/^\s*javascript:/i);
    }
    // The quote stays inside the URL (encoded): no chip for a malformed id, a plain link instead.
    expect(fragment.querySelector("a.tavrn-chip")).toBeNull();
  });

  it("caches per known-node set: a new session re-renders", () => {
    const url = `https://chat.third.test/rooms/${R}`;
    expect(renderMarkdown(url, undefined, undefined, undefined, links)).not.toContain("tavrn-chip");
    const more: MarkdownLinks = { ...links, known: [...links.known, { domain: "third.test", web: "https://chat.third.test" }], key: "k2" };
    expect(renderMarkdown(url, undefined, undefined, undefined, more)).toContain("tavrn-chip");
  });
});
