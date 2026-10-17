// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { applyFormat, FORMATS, formatForShortcut, type FormatId } from "./format";
import { renderMarkdown } from "../lib/markdown";

/** `[` and `]` mark the selection, a lone `|` the caret. */
function s(text: string) {
  if (text.includes("|") && !text.includes("[")) {
    const start = text.indexOf("|");
    return { value: text.replace("|", ""), start, end: start };
  }
  const start = text.indexOf("[");
  const end = text.indexOf("]") - 1;
  return { value: text.replace("[", "").replace("]", ""), start, end };
}
/** The state back in the same notation. */
function show(st: { value: string; start: number; end: number }) {
  if (st.start === st.end) return `${st.value.slice(0, st.start)}|${st.value.slice(st.start)}`;
  return `${st.value.slice(0, st.start)}[${st.value.slice(st.start, st.end)}]${st.value.slice(st.end)}`;
}
const f = (id: FormatId, text: string) => show(applyFormat(id, s(text)));

describe("inline formats", () => {
  it("wrap the selection and keep it selected", () => {
    expect(f("bold", "ein [wort] hier")).toBe("ein **[wort]** hier");
    expect(f("italic", "ein [wort] hier")).toBe("ein *[wort]* hier");
    expect(f("strike", "[weg]")).toBe("~~[weg]~~");
    expect(f("code", "nimm [x()]")).toBe("nimm `[x()]`");
    expect(f("spoiler", "das [ende]")).toBe("das ||[ende]||");
  });

  it("insert the markers with the caret between them without a selection", () => {
    expect(f("bold", "a |")).toBe("a **|**");
    expect(f("code", "|")).toBe("`|`");
    expect(applyFormat("spoiler", { value: "x", start: 1, end: 1 })).toEqual({ value: "x||||", start: 3, end: 3 });
  });

  it("toggle off when the selection is already wrapped (markers outside or inside the selection)", () => {
    expect(f("bold", "ein **[wort]** hier")).toBe("ein [wort] hier");
    expect(f("bold", "ein [**wort**] hier")).toBe("ein [wort] hier");
    expect(f("spoiler", "||[x]||")).toBe("[x]");
    expect(f("code", "`[x]`")).toBe("[x]");
    // Empty markers around the caret go away again.
    expect(f("bold", "a **|**")).toBe("a |");
  });

  it("tell italic and bold apart (both use asterisks)", () => {
    // Italic on bold text adds a third asterisk; removing it leaves the bold.
    expect(f("italic", "**[x]**")).toBe("***[x]***");
    expect(f("italic", "***[x]***")).toBe("**[x]**");
    expect(f("bold", "***[x]***")).toBe("*[x]*");
    // Italic is not "on" inside bold markers alone.
    expect(f("bold", "*[x]*")).toBe("***[x]***");
  });

  it("leave white space at the selection's edges outside the markers (Markdown would not render it)", () => {
    expect(f("bold", "ein[ wort ]hier")).toBe("ein **[wort]** hier");
  });

  it("produce Markdown the renderer turns into the format", () => {
    const html = (id: FormatId) => renderMarkdown(applyFormat(id, s("a [b] c")).value);
    expect(html("bold")).toContain("<strong>b</strong>");
    expect(html("italic")).toContain("<em>b</em>");
    expect(html("strike")).toContain("<del>b</del>");
    expect(html("code")).toContain("<code>b</code>");
    expect(html("spoiler")).toContain('class="spoiler"');
  });
});

describe("block formats", () => {
  it("code block: fences on their own lines around the selection; again removes them", () => {
    expect(f("codeblock", "vorher [let x = 1] nachher")).toBe("vorher \n```\n[let x = 1]\n```\n nachher");
    expect(f("codeblock", "[a\nb]")).toBe("```\n[a\nb]\n```");
    expect(f("codeblock", "|")).toBe("```\n|\n```");
    expect(f("codeblock", "```\n[a\nb]\n```")).toBe("[a\nb]");
    expect(renderMarkdown(applyFormat("codeblock", s("[let x]")).value)).toContain("codeblock");
  });

  it("quote and lists prefix every selected line and toggle off when all lines have it", () => {
    expect(f("quote", "[eins\nzwei]")).toBe("[> eins\n> zwei]");
    expect(f("quote", "[> eins\n> zwei]")).toBe("[eins\nzwei]");
    expect(f("bullets", "a\n[b\nc]")).toBe("a\n[- b\n- c]");
    expect(f("numbers", "[b\nc\nd]")).toBe("[1. b\n2. c\n3. d]");
    expect(f("numbers", "[1. b\n2. c]")).toBe("[b\nc]");
    // Bullets become numbers (and back) instead of stacking.
    expect(f("numbers", "[- b\n- c]")).toBe("[1. b\n2. c]");
    // A caret only: its line, the caret moves with the text.
    expect(f("quote", "erste\nzwei|te")).toBe("erste\n> zwei|te");
    expect(f("bullets", "- pun|kt")).toBe("pun|kt");
    expect(f("numbers", "|")).toBe("1. |");
    const html = renderMarkdown(applyFormat("bullets", s("[x\ny]")).value);
    expect(html).toContain("<ul>");
    expect(renderMarkdown(applyFormat("quote", s("[x]")).value)).toContain("<blockquote>");
    expect(renderMarkdown(applyFormat("numbers", s("[x]")).value)).toContain("<ol>");
  });

  it("link: the selection becomes the label with the URL selected; a URL becomes the target; again unwraps", () => {
    expect(f("link", "siehe [hier] bitte")).toBe("siehe [hier]([https://]) bitte");
    expect(f("link", "[https://example.org]")).toBe("[|](https://example.org)");
    expect(f("link", "a |")).toBe("a [|](https://)");
    expect(applyFormat("link", { value: "a [hier](https://x.example) b", start: 2, end: 27 })).toEqual({ value: "a hier b", start: 2, end: 6 });
    expect(renderMarkdown("[hier](https://x.example)")).toContain('href="https://x.example"');
  });
});

describe("format list and shortcuts", () => {
  it("lists every format with a label key; headings and underline are not offered (the renderer shows neither)", () => {
    expect(FORMATS.map((x) => x.id)).toEqual(["bold", "italic", "strike", "code", "codeblock", "quote", "bullets", "numbers", "link", "spoiler"]);
  });

  it("maps Ctrl/Cmd shortcuts to formats", () => {
    const key = (k: string, mod: { shift?: boolean; meta?: boolean } = {}) => formatForShortcut({ key: k, ctrlKey: !mod.meta, metaKey: !!mod.meta, shiftKey: !!mod.shift, altKey: false });
    expect(key("b")).toBe("bold");
    expect(key("B")).toBe("bold");
    expect(key("i", { meta: true })).toBe("italic");
    expect(key("X", { shift: true })).toBe("strike");
    expect(key("e")).toBe("code");
    expect(key("S", { shift: true })).toBe("spoiler");
    // Without the modifier or with other keys: nothing.
    expect(key("x")).toBeNull();
    expect(formatForShortcut({ key: "b", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBeNull();
    expect(formatForShortcut({ key: "b", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true })).toBeNull();
  });
});
