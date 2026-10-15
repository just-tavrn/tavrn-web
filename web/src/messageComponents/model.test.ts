// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { authoredByBot, componentsOf, defaultValues, errorText, modalOf } from "./model";

const button = (over: Record<string, unknown> = {}) => ({ type: "button", style: "primary", label: "Go", custom_id: "go", ...over });
const select = (over: Record<string, unknown> = {}) => ({ type: "select", custom_id: "s", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], ...over });
const text = (components: unknown) => ({ type: "text", body: "", components });
const rows = (...items: unknown[][]) => items.map((components) => ({ type: "row", components }));

describe("message components: what the client accepts (APPLICATIONS.md §5.10)", () => {
  it("accepts the limits exactly", () => {
    const five = Array.from({ length: 5 }, (_, i) => button({ custom_id: `b${i}` }));
    expect(componentsOf(text(rows(five, five.map((b, i) => ({ ...b, custom_id: `c${i}` })), [select()])))).toHaveLength(3);
    expect(componentsOf(text(rows([button({ label: "x".repeat(80) })])))).not.toBeNull();
    expect(componentsOf(text(rows([button({ label: "", emoji: "🎲" })])))).not.toBeNull();
    expect(componentsOf(text(rows([button({ label: "", emoji: ":thumbsup:" })])))).not.toBeNull();
    expect(componentsOf(text(rows([button({ style: "link", custom_id: undefined, url: "https://a.example/x" })])))).not.toBeNull();
    const options = Array.from({ length: 25 }, (_, i) => ({ label: `o${i}`, value: `v${i}` }));
    expect(componentsOf(text(rows([select({ options, min: 0, max: 25 })])))).not.toBeNull();
  });

  it.each([
    ["six rows", rows(...Array.from({ length: 6 }, (_, i) => [button({ custom_id: `b${i}` })]))],
    ["six buttons", rows(Array.from({ length: 6 }, (_, i) => button({ custom_id: `b${i}` })))],
    ["an empty row", rows([])],
    ["a select next to a button", rows([select(), button()])],
    ["a label of 81 characters", rows([button({ label: "x".repeat(81) })])],
    ["an empty label without emoji", rows([button({ label: "" })])],
    ["two emojis", rows([button({ emoji: "🎲🎲" })])],
    ["an unknown style", rows([button({ style: "blink" })])],
    ["an unknown key", rows([button({ color: "#f00" })])],
    ["html in a key's place", rows([button({ html: "<b>x</b>" })])],
    ["a duplicate custom_id", rows([button(), button()])],
    ["a link with custom_id", rows([button({ style: "link", url: "https://a.example" })])],
    ["a link over http", rows([button({ style: "link", custom_id: undefined, url: "http://a.example" })])],
    ["a javascript: link", rows([button({ style: "link", custom_id: undefined, url: "javascript:alert(1)" })])],
    ["a button with url", rows([button({ url: "https://a.example" })])],
    ["26 options", rows([select({ options: Array.from({ length: 26 }, (_, i) => ({ label: `o${i}`, value: `v${i}` })) })])],
    ["duplicate option values", rows([select({ options: [{ label: "A", value: "a" }, { label: "B", value: "a" }] })])],
    ["max above the options", rows([select({ max: 3 })])],
    ["max below min", rows([select({ min: 2, max: 1 })])],
    ["more than 8 KiB", rows(...Array.from({ length: 2 }, (_, r) => [select({ custom_id: `s${r}`, options: Array.from({ length: 25 }, (_, i) => ({ label: "y".repeat(100), value: `v${i}`, description: "z".repeat(100) })) })]))],
    ["not an array", { type: "row" }],
  ])("refuses %s", (_name, components) => {
    expect(componentsOf(text(components))).toBeNull();
  });

  it("only `text` carries components and only bot devices author them", () => {
    expect(componentsOf({ type: "action", body: "x", components: rows([button()]) })).toBeNull();
    expect(componentsOf({ type: "text", body: "x" })).toBeNull();
    expect(authoredByBot({ author_kind: "bot" }, false)).toBe(true);
    expect(authoredByBot({ author_kind: "webhook" }, true)).toBe(false);
    expect(authoredByBot({ author_kind: "user" }, true)).toBe(false);
    expect(authoredByBot({ author_kind: undefined }, true)).toBe(true);
  });

  it("modals: 1–5 inputs, title ≤ 45, unique ids, lengths", () => {
    const input = { custom_id: "a", label: "A", style: "short" };
    expect(modalOf({ custom_id: "m", title: "T", inputs: [input] })).not.toBeNull();
    expect(modalOf({ custom_id: "m", title: "x".repeat(46), inputs: [input] })).toBeNull();
    expect(modalOf({ custom_id: "m", title: "T", inputs: [] })).toBeNull();
    expect(modalOf({ custom_id: "m", title: "T", inputs: Array.from({ length: 6 }, (_, i) => ({ ...input, custom_id: `i${i}` })) })).toBeNull();
    expect(modalOf({ custom_id: "m", title: "T", inputs: [input, input] })).toBeNull();
    expect(modalOf({ custom_id: "m", title: "T", inputs: [{ ...input, max_length: 4001 }] })).toBeNull();
    expect(modalOf({ custom_id: "m", title: "T", inputs: [{ ...input, style: "rich" }] })).toBeNull();
    expect(modalOf(null)).toBeNull();
  });

  it("error texts are one line of at most 200 characters; defaults are cut to max", () => {
    expect(errorText("a\n\nb")).toBe("a b");
    expect(errorText("x".repeat(500))).toHaveLength(200);
    expect(defaultValues([{ value: "a", default: true }, { value: "b", default: true }], 1)).toEqual(["a"]);
  });
});
