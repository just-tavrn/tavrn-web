// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
/**
 * Cheap static accessibility checks over the JSX sources (docs/ACCESSIBILITY.md; the full audit is axe in
 * e2e/tests/a11y.spec.ts): every icon-only button has an accessible name (`aria-label`, `aria-labelledby` or
 * `title`), every `<img>` has an `alt`, every range input has an `aria-valuetext`, every element with
 * `role="dialog"` is labelled and no plain `span`/`div`/`p` carries a name (ARIA prohibits it on generic elements).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [path] : [];
  });
}

interface Tag {
  file: string;
  line: number;
  attrs: string;
  /** Text between the opening and the closing tag ("" for self-closing tags). */
  body: string;
}

/** End of a JSX opening tag that starts at `start` (skips braces, strings and `=>`). */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/** Every `<name …>` element of the sources (the body up to the first closing tag). */
function elements(name: string): Tag[] {
  const out: Tag[] = [];
  for (const file of sources(SRC)) {
    const src = readFileSync(file, "utf8");
    const open = new RegExp(`<${name}(?=[\\s>/])`, "g");
    for (let m = open.exec(src); m; m = open.exec(src)) {
      const end = tagEnd(src, m.index + name.length + 1);
      if (end < 0) continue;
      const attrs = src.slice(m.index + name.length + 1, end);
      const selfClosing = attrs.trimEnd().endsWith("/");
      const close = selfClosing ? end : src.indexOf(`</${name}>`, end);
      out.push({ file: relative(SRC, file), line: src.slice(0, m.index).split("\n").length, attrs, body: selfClosing || close < 0 ? "" : src.slice(end + 1, close) });
    }
  }
  return out;
}

const where = (t: Tag) => `${t.file}:${t.line}`;
const named = (attrs: string) => /\baria-label(ledby)?=|\btitle=|\{\.\.\.\w+\}/.test(attrs);

/**
 * Text a button shows: tags and attribute expressions removed; `{…}` children and components other than icons
 * might render text, so they count as text.
 */
function visibleText(body: string): string {
  let text = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "<") {
      const end = tagEnd(body, i + 1);
      if (end < 0) break;
      const tag = body.slice(i, end + 1);
      // An element marked as hidden from assistive technology does not name the button.
      if (/aria-hidden/.test(tag) && !tag.endsWith("/>")) {
        const name = /^<(\w+)/.exec(tag)?.[1];
        const close = name ? body.indexOf(`</${name}>`, end) : -1;
        if (close >= 0) {
          i = close + name!.length + 2;
          continue;
        }
      }
      // A component (not an icon or glyph) may render text.
      if (/^<[A-Z]/.test(tag) && !/^<\w*(Icon|Glyph)\b/.test(tag)) text += "{component}";
      i = end;
      continue;
    }
    text += body[i];
  }
  return text;
}

describe("static accessibility checks", () => {
  it("icon-only buttons have an accessible name", () => {
    const buttons = elements("button");
    // The scanner finds the app's buttons (guards against a silently broken parser).
    expect(buttons.length).toBeGreaterThan(100);
    expect(buttons.filter((b) => named(b.attrs) && !/\p{L}/u.test(visibleText(b.body))).length).toBeGreaterThan(50);
    const missing = buttons
      .filter((b) => !named(b.attrs))
      .filter((b) => {
        const text = visibleText(b.body);
        // A `{…}` expression (translated text, a name) or a letter makes a visible label.
        return !/\{/.test(text) && !/\p{L}|\p{N}/u.test(text);
      })
      .map(where);
    expect(missing).toEqual([]);
  });

  it("images have an alt text (empty when decorative)", () => {
    const missing = elements("img")
      .filter((i) => !/\balt=|\{\.\.\.\w+\}/.test(i.attrs))
      .map(where);
    expect(missing).toEqual([]);
  });

  it("range inputs have a label and announce their value with a unit", () => {
    const missing = elements("input")
      .filter((i) => /type="range"/.test(i.attrs))
      .filter((i) => !/aria-valuetext=/.test(i.attrs) || !/aria-label(ledby)?=/.test(i.attrs))
      .map(where);
    expect(missing).toEqual([]);
  });

  it("names are only given to elements whose role allows one (no aria-label on a plain span or div)", () => {
    const missing = [...elements("span"), ...elements("div"), ...elements("p")]
      .filter((e) => /\baria-label(ledby)?=/.test(e.attrs) && !/\brole=/.test(e.attrs))
      .map(where);
    expect(missing).toEqual([]);
  });

  it("dialogs are labelled", () => {
    const missing = [...elements("div"), ...elements("section"), ...elements("aside")]
      .filter((d) => /role="(alert)?dialog"/.test(d.attrs) && !/aria-label(ledby)?=/.test(d.attrs))
      .map(where);
    expect(missing).toEqual([]);
  });
});

/** The design tokens of `styles.css` (`--color-<name>: #rrggbb`). */
function tokens(): Record<string, string> {
  const css = readFileSync(join(SRC, "styles.css"), "utf8");
  return Object.fromEntries([...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

/** WCAG 2.2 contrast ratio of two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("form control borders (WCAG 1.4.11 non-text contrast, docs/ACCESSIBILITY.md)", () => {
  it("the line-strong token has at least 3:1 against every background a field sits on or is filled with", () => {
    const t = tokens();
    expect(t["line-strong"], "--color-line-strong in styles.css").toMatch(/^#[0-9a-f]{6}$/);
    for (const bg of ["bg-0", "bg-1", "bg-2", "bg-3"]) expect(contrast(t["line-strong"]!, t[bg]!), `line-strong on ${bg}`).toBeGreaterThanOrEqual(3);
    // The focus border (accent) stays well above it.
    for (const bg of ["bg-0", "bg-1", "bg-2", "bg-3"]) expect(contrast(t.accent!, t[bg]!), `accent on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it("text fields, selects and text areas draw their border with line-strong, not the divider token", () => {
    const controls = [...elements("input"), ...elements("select"), ...elements("textarea")].filter((c) => !/type="(checkbox|radio|range|file|color|hidden)"/.test(c.attrs));
    expect(controls.length).toBeGreaterThan(25);
    const weak = controls.filter((c) => /\bborder-line(?!-)/.test(c.attrs)).map(where);
    expect(weak).toEqual([]);
  });
});
