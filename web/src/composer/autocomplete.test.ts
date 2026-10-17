// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { applyCompletion, findTrigger, insideCode } from "./autocomplete";

/** `|` marks the caret. */
function at(text: string) {
  const caret = text.indexOf("|");
  return { value: text.replace("|", ""), caret };
}

describe("autocomplete triggers", () => {
  it("opens when @ starts a word and the caret is inside it", () => {
    const a = at("@bo|");
    expect(findTrigger(a.value, a.caret, "@")).toEqual({ start: 0, end: 3, query: "bo" });
    const b = at("hi @al|");
    expect(findTrigger(b.value, b.caret, "@")).toEqual({ start: 3, end: 6, query: "al" });
    // Right after the @: an empty query (everything is offered).
    const c = at("hi @|");
    expect(findTrigger(c.value, c.caret, "@")).toEqual({ start: 3, end: 4, query: "" });
    // After a line break and opening brackets.
    for (const text of ["x\n@bo|", "(@bo|", "[@bo|", "{@bo|", "\"@bo|", "> @bo|"]) {
      const d = at(text);
      expect(findTrigger(d.value, d.caret, "@")?.query, text).toBe("bo");
    }
  });

  it("the caret in the middle of the word: the query is what precedes it, the word end is replaced", () => {
    const a = at("@bo|b und mehr");
    expect(findTrigger(a.value, a.caret, "@")).toEqual({ start: 0, end: 4, query: "bo" });
  });

  it("never opens in e-mail addresses, URLs, after word characters or once the caret has left the word", () => {
    for (const text of ["mail foo@ba|", "https://example.org/@us|", "x@|", "a.b@c|", "@bob\n|", "|@bob", "@@bo|", "\\@bo|"]) {
      const a = at(text);
      expect(findTrigger(a.value, a.caret, "@"), text).toBeNull();
    }
  });

  it("never opens inside code spans or code blocks", () => {
    for (const text of ["`@bo|", "`code` und `@bo|", "```\n@bo|", "```js\nlet x\n@bo|", "text ```@bo|"]) {
      const a = at(text);
      expect(findTrigger(a.value, a.caret, "@"), text).toBeNull();
    }
    // After a closed span or block it opens again.
    for (const text of ["`code` @bo|", "```\nx\n```\n@bo|", "``doppelt`` @bo|"]) {
      const a = at(text);
      expect(findTrigger(a.value, a.caret, "@")?.query, text).toBe("bo");
    }
  });

  it("a query may contain spaces (role names) but not line breaks, and is limited in length", () => {
    const a = at("@Mod Te|");
    expect(findTrigger(a.value, a.caret, "@")).toEqual({ start: 0, end: 7, query: "Mod Te" });
    const b = at(`@${"x".repeat(80)}|`);
    expect(findTrigger(b.value, b.caret, "@")).toBeNull();
    // Spaces keep the query going (the matching decides whether anything is offered).
    const d = at("@bob und |");
    expect(findTrigger(d.value, d.caret, "@")?.query).toBe("bob und ");
    // The nearest trigger wins.
    const c = at("@alice und @bo|");
    expect(findTrigger(c.value, c.caret, "@")?.query).toBe("bo");
  });

  it("insideCode looks at fences and backticks on the current line", () => {
    expect(insideCode("`x` y", 4)).toBe(false);
    expect(insideCode("`x y", 3)).toBe(true);
    expect(insideCode("```\nx", 5)).toBe(true);
    expect(insideCode("```\nx\n```\ny", 11)).toBe(false);
  });

  it("applies a completion: replaces trigger and word, adds one space and puts the caret after it", () => {
    const a = at("hi @bo|b ok");
    const trigger = findTrigger(a.value, a.caret, "@")!;
    expect(applyCompletion(a.value, trigger, "@bob")).toEqual({ value: "hi @bob ok", start: 8, end: 8 });
    const b = at("hi @al|");
    expect(applyCompletion(b.value, findTrigger(b.value, b.caret, "@")!, "@alice")).toEqual({ value: "hi @alice ", start: 10, end: 10 });
    const c = at("@Mod Te| danach");
    expect(applyCompletion(c.value, findTrigger(c.value, c.caret, "@")!, "@Mod Team")).toEqual({ value: "@Mod Team danach", start: 10, end: 10 });
  });
});
