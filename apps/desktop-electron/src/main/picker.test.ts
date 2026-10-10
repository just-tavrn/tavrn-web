// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { PICKER_CSP, pickerChoice, pickerHtml, pickerLabels, pickerSources, pickerUrl } from "./picker.ts";

const png = "data:image/png;base64,iVBORw0KGgo=";

test("the picker's page runs no script and loads nothing", () => {
  assert.match(PICKER_CSP, /script-src 'none'/);
  assert.match(PICKER_CSP, /default-src 'none'/);
  const html = pickerHtml("en-US");
  assert.ok(html.includes(`content="${PICKER_CSP}"`));
  assert.ok(!/<script/i.test(html));
  assert.match(html, /<html lang="en">/);
  assert.match(pickerHtml("de-DE"), /<html lang="de">/);
  assert.ok(pickerUrl("en").startsWith("data:text/html;charset=utf-8,"));
});

test("texts in English or German", () => {
  assert.equal(pickerLabels("en-US").title, "Share your screen");
  assert.equal(pickerLabels("de-AT").cancel, "Abbrechen");
  assert.equal(pickerLabels("fr").screens, "Screens");
  assert.match(pickerLabels("de").empty, /keinen Bildschirm/);
});

test("sources: screens and windows with a name and a PNG thumbnail", () => {
  const sources = pickerSources([
    { id: "screen:0:0", name: "Entire screen", thumbnail: png },
    { id: "window:123:0", name: "", thumbnail: "javascript:alert(1)" },
    { id: "webcontents:1", name: "x", thumbnail: png },
    { id: "screen:<script>", name: "x", thumbnail: png },
  ]);
  assert.deepEqual(sources, [
    { id: "screen:0:0", name: "Entire screen", kind: "screen", thumbnail: png },
    { id: "window:123:0", name: "window:123:0", kind: "window", thumbnail: "" },
  ]);
});

test("the answer must be one of the offered sources", () => {
  const offered = pickerSources([{ id: "screen:0:0", name: "Screen", thumbnail: png }]);
  assert.equal(pickerChoice("screen:0:0", offered), "screen:0:0");
  for (const bad of [null, undefined, "screen:1:0", 42, { id: "screen:0:0" }]) assert.equal(pickerChoice(bad, offered), null);
});
