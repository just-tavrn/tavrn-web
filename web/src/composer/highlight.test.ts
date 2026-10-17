// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { F, highlight, type Run } from "./highlight";
import { renderMarkdown } from "../lib/markdown";

/** The characters carrying `flag`, as one string per contiguous run. */
function having(runs: Run[], flag: number): string[] {
  const out: string[] = [];
  let open = false;
  for (const r of runs) {
    if (r.flags & flag) {
      if (open) out[out.length - 1] += r.text;
      else out.push(r.text);
      open = true;
    } else open = false;
  }
  return out;
}
const join = (runs: Run[]) => runs.map((r) => r.text).join("");

describe("styled input tokenizer", () => {
  it("always reproduces the text exactly (the layer must align with the textarea)", () => {
    const samples = ["", "plain", "**b** _i_ ~~s~~ `c` ||sp||", "```js\nlet x\n", "> q\n- a\n1. b\n\n\n", "unclosed **bold and `code", "\\*esc\\* [l](https://x) @bob", "tab\tand\r\nwindows", "emoji 🎉👍🏽 and ünïcödé"];
    for (const s of samples) expect(join(highlight(s, ["@bob"]))).toBe(s);
    // Random strings of Markdown characters.
    const alphabet = "*_~`|>[]()-1. \n\\@abc";
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 300; i++) {
      const s = Array.from({ length: Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      expect(join(highlight(s))).toBe(s);
    }
  });

  it("bold, italic, strikethrough: the markers dimmed, the content formatted", () => {
    const r = highlight("a **bold** b *it* c _it2_ d ~~gone~~ e ~one~");
    expect(having(r, F.BOLD)).toEqual(["bold"]);
    expect(having(r, F.ITALIC)).toEqual(["it", "it2"]);
    expect(having(r, F.STRIKE)).toEqual(["gone", "one"]);
    expect(having(r, F.MARK)).toEqual(["**", "**", "*", "*", "_", "_", "~~", "~~", "~", "~"]);
  });

  it("nesting and combined markers", () => {
    const r = highlight("**bold *both* bold** ***all***");
    expect(having(r, F.BOLD)).toEqual(["bold *both* bold", "all"]);
    // `***all***`: strong inside emphasis (the inner markers carry the outer format).
    expect(having(r, F.ITALIC)).toEqual(["both", "**all**"]);
  });

  it("unclosed or non-flanking markers stay plain text", () => {
    for (const s of ["**bold", "*it", "a * b * c", "snake_case_name", "~~~", "2*3*4 is 2 * 3 * 4"]) {
      const r = highlight(s);
      expect(having(r, F.BOLD | F.ITALIC | F.STRIKE), s).toEqual(s === "2*3*4 is 2 * 3 * 4" ? ["3"] : []);
    }
  });

  it("code spans and code blocks suppress every other format inside", () => {
    const span = highlight("x `**not bold**` y");
    expect(having(span, F.CODE)).toEqual(["`**not bold**`"]);
    expect(having(span, F.BOLD)).toEqual([]);
    const block = highlight("```js\n**x** @bob\n```\n**after**", ["@bob"]);
    expect(having(block, F.BLOCK)).toEqual(["```js\n**x** @bob\n```"]);
    expect(having(block, F.BOLD)).toEqual(["after"]);
    expect(having(block, F.MENTION)).toEqual([]);
    // An unclosed fence runs to the end (as the renderer shows it).
    expect(having(highlight("a\n```\n*b*"), F.BLOCK)).toEqual(["```\n*b*"]);
    // A double-backtick span may contain a backtick.
    expect(having(highlight("``a`b``"), F.CODE)).toEqual(["``a`b``"]);
  });

  it("escapes: the backslash is dimmed, the escaped character is no marker", () => {
    const r = highlight("\\*not italic\\* and \\`no code`");
    expect(having(r, F.ITALIC | F.CODE)).toEqual([]);
    expect(having(r, F.MARK)).toEqual(["\\", "\\", "\\"]);
  });

  it("spoilers, with formats inside", () => {
    const r = highlight("das ||ende **hier**|| ja");
    expect(having(r, F.SPOILER)).toEqual(["ende **hier**"]);
    expect(having(r, F.BOLD)).toEqual(["hier"]);
    expect(having(highlight("|| nope||"), F.SPOILER)).toEqual([]);
  });

  it("links: the label is the link, brackets and URL dimmed; bare URLs are links", () => {
    const r = highlight("siehe [die Seite](https://x.example/a) oder https://y.example/b.");
    expect(having(r, F.LINK)).toEqual(["die Seite", "https://y.example/b"]);
    expect(having(r, F.MARK)).toEqual(["[", "](https://x.example/a)"]);
  });

  it("quotes and list markers", () => {
    const r = highlight("> zitat *x*\n- punkt\n* stern\n12. zwölf\nnormal");
    expect(having(r, F.QUOTE)).toEqual(["> zitat *x*"]);
    expect(having(r, F.ITALIC)).toEqual(["x"]);
    expect(having(r, F.MARK)).toEqual(["> ", "*", "*", "-", "*", "12."]);
    // A star that starts a list item never opens emphasis.
    expect(having(highlight("* a*"), F.ITALIC)).toEqual([]);
  });

  it("emphasis spans the lines of a paragraph, not a blank line", () => {
    expect(having(highlight("*eins\nzwei*"), F.ITALIC)).toEqual(["eins\nzwei"]);
    expect(having(highlight("*eins\n\nzwei*"), F.ITALIC)).toEqual([]);
  });

  it("mentions of the conversation get the pill colour", () => {
    const r = highlight("hi @bob, @bobby und @Mod Team! mail@bob.x `@bob`", ["@bob", "@mod team"]);
    expect(having(r, F.MENTION)).toEqual(["@bob", "@Mod Team"]);
  });

  it("agrees with the message renderer on which formats appear", () => {
    const samples = ["**a**", "*a*", "_a_", "~~a~~", "~a~", "`a`", "snake_case_word", "**a", "a * b * c", "***a***", "**a *b* c**", "\\*a\\*", "*a\nb*", "x**y**z", "x__y__z", "_a_b", "**a**b", "~~~a~~~"];
    for (const s of samples) {
      const html = renderMarkdown(s);
      const r = highlight(s);
      const got = { bold: having(r, F.BOLD).length > 0, italic: having(r, F.ITALIC).length > 0, strike: having(r, F.STRIKE).length > 0, code: having(r, F.CODE).length > 0 };
      const want = { bold: html.includes("<strong>"), italic: html.includes("<em>"), strike: html.includes("<del>"), code: html.includes("<code>") };
      expect({ s, ...got }).toEqual({ s, ...want });
    }
  });
});
