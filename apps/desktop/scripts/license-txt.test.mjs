// SPDX-License-Identifier: Apache-2.0
// node --test apps/desktop/scripts: the licence text of the installers (LICENSE.txt) is generated and up to date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { licenseText, renderMarkdown, LICENSE_TXT } from "./license-txt.mjs";

test("headings, links and lists of TERMS.md become plain text", () => {
  const md = "# Title\n\nSome **bold** text with [a link](https://tavrn.org).\n\n## 1. Part\n\n- one\n- two\n";
  assert.equal(renderMarkdown(md), "Title\n=====\n\nSome bold text with a link (https://tavrn.org).\n\n1. Part\n-------\n\n- one\n- two\n");
});

test("the licence, the notice and the terms in this order", () => {
  const text = licenseText("APACHE\n", "NOTICE\n", "# Terms\n\nBody\n");
  assert.ok(text.indexOf("APACHE") < text.indexOf("NOTICE") && text.indexOf("NOTICE") < text.indexOf("Terms"));
  assert.match(text, /\n=+\n/);
});

test("LICENSE.txt is current and plain ASCII (the NSIS licence page shows it as is)", () => {
  const committed = readFileSync(LICENSE_TXT, "utf8");
  assert.equal(committed, licenseText(), "run: pnpm --filter @tavrn/desktop license-txt");
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(committed), "LICENSE.txt has non-ASCII characters");
  // Both shells: the Tauri app's and the Electron app's folders, keychain items and update feeds.
  for (const part of ["Apache License", "Terms of use and privacy notice for the tavrn desktop app", "github.com", "https://tavrn.org", "org.tavrn.desktop", "latest.json", "~/.config/tavrn-desktop/", "%APPDATA%\\tavrn-desktop\\", "tavrn Safe Storage", "latest-linux.yml", "latest.yml", ".minisig", "does not delete"]) {
    assert.ok(committed.includes(part), part);
  }
});
