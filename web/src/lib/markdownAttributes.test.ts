// SPDX-License-Identifier: Apache-2.0
// Nothing is string-edited after sanitising: emoji tokens, room emojis, bot mentions and link attributes are applied
// to DOM nodes, so text from a message can never leave an attribute value. jsdom serialises `<`/`>` in attribute
// values raw (like older browser engines), which makes these tests faithful for those engines.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { markBotMentions } from "./mentionBadges";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function dom(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

const handlers = (root: HTMLElement) => [...root.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => a.name.startsWith("on")));

function onlyOneLink(html: string): HTMLAnchorElement {
  const root = dom(html);
  expect(handlers(root)).toEqual([]);
  expect(root.querySelectorAll("a")).toHaveLength(1);
  expect(root.querySelector("img:not(.emoji), meta, style")).toBeNull();
  return root.querySelector("a")!;
}

describe("markdown keeps attribute values intact", () => {
  it("this engine keeps `<` raw in attribute values (the precondition these tests rely on)", () => {
    const d = dom("");
    d.appendChild(Object.assign(document.createElement("a"), { title: "<b>" }));
    expect(d.innerHTML).toBe('<a title="<b>"></a>');
  });

  it("a custom emoji token in a link title stays literal text (no resolver)", () => {
    const title = `<:aa:${ID}><img src=x onerror=alert(1)>`;
    const a = onlyOneLink(renderMarkdown(`[x](https://a.example "${title}")`));
    expect(a.getAttribute("title")).toBe(title);
  });

  it("a custom emoji token in a link title stays literal text (with a resolver)", () => {
    const title = `<:aa:${ID}><img src=x onerror=alert(1)>`;
    const a = onlyOneLink(renderMarkdown(`[x](https://a.example "${title}")`, {}, () => "https://n.example/e.png"));
    expect(a.getAttribute("title")).toBe(title);
  });

  it("a custom emoji token alone in a title gives the link no foreign attributes", () => {
    const a = onlyOneLink(renderMarkdown(`[x](https://a.example "<:aa:${ID}>")`));
    expect(a.getAttribute("title")).toBe(`<:aa:${ID}>`);
    expect(a.getAttributeNames().sort()).toEqual(["href", "rel", "target", "title"]);
  });

  it("a room emoji `:name:` in a title is not replaced", () => {
    const title = "a>:smile: <img src=x onerror=alert(1)>";
    const a = onlyOneLink(renderMarkdown(`[x](https://a.example "${title}")`, { smile: "https://n.example/s.png" }));
    expect(a.getAttribute("title")).toBe(title);
  });

  it("`<a ` inside a title does not add attributes to the real link", () => {
    const a = onlyOneLink(renderMarkdown(`[x](https://a.example "<a onmouseover=alert(1) z")`));
    expect(a.getAttribute("onmouseover")).toBeNull();
    expect(a.getAttribute("title")).toBe("<a onmouseover=alert(1) z");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("a bot mention in a title is not marked", () => {
    const title = "a>@weather <img src=x onerror=alert(1)>";
    const html = markBotMentions(renderMarkdown(`[x](https://a.example "${title}")`), ["weather"], "BOT");
    const a = onlyOneLink(html);
    expect(a.getAttribute("title")).toBe(title);
    expect(dom(html).querySelector('[data-testid="bot-badge"]')).toBeNull();
  });

  it("no <meta refresh> or <style> can come out of a title", () => {
    const html = renderMarkdown(`[x](https://a.example "<:aa:${ID}><meta http-equiv=refresh content='0;url=https://evil.example'><style>body{display:none}")`);
    const root = dom(html);
    expect(root.querySelector("meta")).toBeNull();
    expect(root.querySelector("style")).toBeNull();
    onlyOneLink(html);
  });

  it("emoji tokens, room emojis and bot mentions still work in text", () => {
    const resolved = dom(renderMarkdown(`hi <:aa:${ID}> :smile:`, { smile: "blob:room" }, () => "https://n.example/e.png"));
    expect([...resolved.querySelectorAll("img.emoji")].map((i) => i.getAttribute("src"))).toEqual(["https://n.example/e.png", "blob:room"]);
    const marked = dom(markBotMentions(renderMarkdown("hi @weather"), ["weather"], "BOT"));
    expect(marked.querySelector('[data-testid="mention"]')?.textContent).toBe("@weather");
    expect(marked.querySelector('[data-testid="bot-badge"]')?.textContent).toBe("BOT");
  });

  it("blob: links are not kept in messages", () => {
    const a = dom(renderMarkdown("[x](blob:https://n.example/0b7c1d2e-0000-4000-8000-000000000000)")).querySelector("a");
    expect(a?.hasAttribute("href") ?? false).toBe(false);
  });
});
