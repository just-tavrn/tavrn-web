#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The licence text of the installers (`LICENSE.txt`, tauri.conf.json `bundle.licenseFile`): the Apache-2.0 licence of
 * the app, its NOTICE and the terms of use and privacy notice (`TERMS.md`, rendered as plain text). The NSIS installer
 * shows it as the licence page to accept, the MSI as its licence dialog; the .deb ships it in /usr/share/doc/tavrn/.
 *
 *   node apps/desktop/scripts/license-txt.mjs   (pnpm --filter @tavrn/desktop license-txt) writes LICENSE.txt
 *
 * The test (license-txt.test.mjs) fails while the committed file is not current.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LICENSE_TXT = join(app, "LICENSE.txt");
const RULE = "=".repeat(78);

/** Markdown of TERMS.md as plain text: underlined headings, links as "text (url)", no emphasis. */
export function renderMarkdown(md) {
  return md
    .split("\n")
    .flatMap((line) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!heading) return [line];
      const text = inline(heading[2]);
      return [text, (heading[1].length === 1 ? "=" : "-").repeat(text.length)];
    })
    .map(inline)
    .join("\n");
}

function inline(text) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

/** The whole text: licence, notice, terms, separated by rules. */
export function licenseText(license = read("LICENSE"), notice = read("NOTICE"), terms = read("TERMS.md")) {
  const block = (s) => s.replace(/\s+$/, "") + "\n";
  return [block(license), block(notice), block(renderMarkdown(terms))].join(`\n${RULE}\n\n`);
}

function read(name) {
  return readFileSync(join(app, name), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(LICENSE_TXT, licenseText());
  console.log(`wrote ${LICENSE_TXT}`);
}
