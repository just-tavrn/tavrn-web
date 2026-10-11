// SPDX-License-Identifier: Apache-2.0
// Randomised payloads through the message pipeline (renderMarkdown + markBotMentions) must never yield
// event handlers, foreign tags or images other than the emoji images with known URLs.
import { describe, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { markBotMentions } from "./mentionBadges";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PIECES = [
  "<",
  ">",
  '"',
  "'",
  ":smile:",
  `<:aa:${ID}>`,
  `<:bb:${ID}@far.example>`,
  "@weather",
  "@weather@n.example",
  '[x](https://a.example "',
  ")",
  "](",
  "||",
  "`",
  "```\n",
  "&",
  "&#58;",
  "<img src=x onerror=alert(1)>",
  "<a onmouseover=alert(1) z",
  "\n",
  " ",
  "> ",
  "**",
  "<meta http-equiv=refresh content='0;url=https://e.example'>",
  "<style>",
  "javascript:",
  "blob:x",
  "<https://a.example>",
  "",
  "",
  "0",
  "<svg onload=1>",
  "<math>",
  "</title>",
  "-->",
  "<!--",
];
const URLS = new Set(["https://n.example/e.png", "https://n.example/s.png"]);

function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function check(src: string) {
  const html = markBotMentions(
    renderMarkdown(
      src,
      { smile: "https://n.example/s.png" },
      () => "https://n.example/e.png",
    ),
    ["weather", "weather@n.example"],
    "BOT",
  );
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const el of div.querySelectorAll("*")) {
    for (const a of el.attributes)
      if (a.name.startsWith("on"))
        throw new Error(`handler in ${JSON.stringify(src)}: ${html}`);
    if (
      [
        "META",
        "STYLE",
        "SCRIPT",
        "SVG",
        "MATH",
        "IFRAME",
        "FORM",
        "INPUT",
      ].includes(el.tagName.toUpperCase())
    )
      throw new Error(`tag ${el.tagName} in ${JSON.stringify(src)}`);
    if (
      el.tagName === "IMG" &&
      (!el.classList.contains("emoji") ||
        !URLS.has(el.getAttribute("src") ?? ""))
    )
      throw new Error(`img in ${JSON.stringify(src)}: ${html}`);
    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href !== null && !/^(https?|mailto):/i.test(href))
        throw new Error(`href ${href} in ${JSON.stringify(src)}`);
      if (
        el.getAttribute("rel") !== "noopener noreferrer nofollow" ||
        el.getAttribute("target") !== "_blank"
      )
        throw new Error(`a attrs in ${JSON.stringify(src)}: ${html}`);
    }
  }
}

describe("the message pipeline stays inert for random payloads", () => {
  it("random payloads stay inert", () => {
    const r = rng(42);
    for (let i = 0; i < 4000; i++) {
      const n = 1 + Math.floor(r() * 12);
      let s = "";
      for (let j = 0; j < n; j++) s += PIECES[Math.floor(r() * PIECES.length)];
      check(s);
    }
  });
  it("title payloads stay inert", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      let t = "";
      for (let j = 0; j < 6; j++) t += PIECES[Math.floor(r() * PIECES.length)];
      check(
        `[x](https://a.example "${t.replace(/"/g, "")}") and :smile: <:aa:${ID}> @weather`,
      );
    }
  });
});
