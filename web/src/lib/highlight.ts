// SPDX-License-Identifier: Apache-2.0
/**
 * Syntax highlighting for fenced code blocks (design note 4.13): highlight.js (BSD-3-Clause) core with a fixed set
 * of common languages, loaded as its own chunk on the first code block that names a language
 * (`lib/markdown.ts`). Auto-detection (blocks without a language) only considers this set.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = { bash, c, cpp, csharp, css, go, java, javascript, json, kotlin, markdown, php, python, rust, shell, sql, swift, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

/** The languages auto-detection chooses from. */
export const SUBSET = Object.keys(LANGUAGES);

/** Display name of a language or alias (`ts` → `typescript`); `null` if it is not bundled. */
export function languageName(lang: string): string | null {
  const def = hljs.getLanguage(lang);
  if (!def) return null;
  return SUBSET.find((n) => hljs.getLanguage(n) === def) ?? lang;
}

/**
 * Highlighted HTML of `code` (plain text) or `null` when nothing applies. With a language: only a bundled one;
 * without: auto-detection within {@link SUBSET} (only when it is reasonably sure).
 */
export function highlight(code: string, lang: string | null): { html: string; language: string } | null {
  if (lang) {
    const name = languageName(lang);
    if (!name) return null;
    return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, language: name };
  }
  const auto = hljs.highlightAuto(code, SUBSET);
  if (!auto.language || auto.relevance < 5) return null;
  return { html: auto.value, language: auto.language };
}
