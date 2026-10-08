// SPDX-License-Identifier: Apache-2.0
// node --test apps/desktop/scripts: the update manifest of a release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestJson, platformsOf } from "./latest-json.mjs";

const files = {
  "Tavrn_0.3.0_amd64.AppImage": "",
  "Tavrn_0.3.0_amd64.AppImage.sig": "sig-appimage",
  "Tavrn_0.3.0_amd64.deb": "",
  "Tavrn_0.3.0_x64_en-US.msi": "",
  "Tavrn_0.3.0_x64_en-US.msi.sig": "sig-msi",
  "Tavrn_0.3.0_x64-setup.exe": "",
  "Tavrn_0.3.0_x64-setup.exe.sig": "sig-nsis\n",
};

function dirWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), "latest-json-"));
  for (const [name, content] of Object.entries(entries)) writeFileSync(join(dir, name), content);
  return dir;
}

test("every signed installer becomes a platform entry with its download URL", () => {
  const base = "https://github.com/just-tavrn/tavrn-web/releases/download/v0.3.0";
  const p = platformsOf(dirWith(files), base);
  assert.deepEqual(p["linux-x86_64-appimage"], { signature: "sig-appimage", url: `${base}/Tavrn_0.3.0_amd64.AppImage` });
  assert.deepEqual(p["linux-x86_64"], p["linux-x86_64-appimage"]);
  assert.deepEqual(p["windows-x86_64-msi"], { signature: "sig-msi", url: `${base}/Tavrn_0.3.0_x64_en-US.msi` });
  assert.deepEqual(p["windows-x86_64-nsis"], { signature: "sig-nsis", url: `${base}/Tavrn_0.3.0_x64-setup.exe` });
  assert.deepEqual(p["windows-x86_64"], p["windows-x86_64-nsis"], "NSIS is the default Windows update");
  assert.equal(Object.keys(p).length, 5, "unsigned files (the .deb) are not offered");
});

test("the manifest names version, notes and date", () => {
  const m = latestJson({ dir: dirWith(files), tag: "v0.3.0", repo: "just-tavrn/tavrn-web", notes: "Notes", date: "2026-10-08T00:00:00Z" });
  assert.equal(m.version, "0.3.0");
  assert.equal(m.notes, "Notes");
  assert.equal(m.pub_date, "2026-10-08T00:00:00Z");
  assert.ok(m.platforms["linux-x86_64"].url.startsWith("https://github.com/just-tavrn/tavrn-web/releases/download/v0.3.0/"));
});

test("refuses a release without any signed installer and odd tags", () => {
  assert.throws(() => latestJson({ dir: dirWith({ "Tavrn_0.3.0_amd64.deb": "" }), tag: "v0.3.0", repo: "a/b" }), /no signed installer/);
  assert.throws(() => latestJson({ dir: dirWith(files), tag: "latest", repo: "a/b" }), /tag/);
});
