// SPDX-License-Identifier: Apache-2.0
// node --test apps/desktop/scripts: the asset set of a release, as the website's download page reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAssets, expectedAssets, releaseNotes, versionOf, websiteEntry } from "./release-assets.mjs";

const RELEASE_0_3_0 = [
  "Tavrn_0.3.0_x64-setup.exe",
  "Tavrn_0.3.0_x64-setup.exe.sha256",
  "Tavrn_0.3.0_x64-setup.exe.sig",
  "Tavrn_0.3.0_x64_en-US.msi",
  "Tavrn_0.3.0_x64_en-US.msi.sha256",
  "Tavrn_0.3.0_x64_en-US.msi.sig",
  "tavrn-electron_0.3.0_x64-setup.exe",
  "tavrn-electron_0.3.0_x64-setup.exe.sha256",
  "tavrn-electron_0.3.0_x64-setup.exe.blockmap",
  "Tavrn-0.3.0.AppImage",
  "Tavrn-0.3.0.AppImage.sha256",
  "tavrn_0.3.0_amd64.deb",
  "tavrn_0.3.0_amd64.deb.sha256",
  "latest.json",
  "latest.yml",
  "latest.yml.minisig",
  "latest-linux.yml",
  "latest-linux.yml.minisig",
  "tavrn-web-0.3.0.tar.gz",
  "tavrn-web-0.3.0.tar.gz.sha256",
];

test("a release carries exactly these files", () => {
  assert.deepEqual(expectedAssets("0.3.0").map((a) => a.name).sort(), [...RELEASE_0_3_0].sort());
  assert.deepEqual(checkAssets(RELEASE_0_3_0, "0.3.0"), []);
  const desktop = RELEASE_0_3_0.filter((n) => !n.startsWith("tavrn-web-"));
  assert.deepEqual(checkAssets(desktop, "0.3.0", ["desktop"]), [], "the desktop job's directory before the upload");
});

test("the download page reads every installer as the right system, shell, format and architecture", () => {
  const installers = Object.fromEntries(RELEASE_0_3_0.map((n) => [n, websiteEntry(n)]).filter(([, e]) => e));
  assert.deepEqual(installers, {
    "Tavrn_0.3.0_x64-setup.exe": { os: "windows", shell: "tauri", kind: "nsis", arch: "x64" },
    "Tavrn_0.3.0_x64_en-US.msi": { os: "windows", shell: "tauri", kind: "msi", arch: "x64" },
    "tavrn-electron_0.3.0_x64-setup.exe": { os: "windows", shell: "electron", kind: "nsis", arch: "x64" },
    "Tavrn-0.3.0.AppImage": { os: "linux", shell: "electron", kind: "appimage", arch: "x64" },
    "tavrn_0.3.0_amd64.deb": { os: "linux", shell: "electron", kind: "deb", arch: "x64" },
  });
  // Every installer has its checksum; the Tauri installers their updater signature.
  for (const name of Object.keys(installers)) assert.ok(RELEASE_0_3_0.includes(`${name}.sha256`), name);
  for (const name of Object.keys(installers).filter((n) => installers[n].shell === "tauri")) assert.ok(RELEASE_0_3_0.includes(`${name}.sig`), name);
});

test("missing, retired and misnamed files fail the check", () => {
  const without = RELEASE_0_3_0.filter((n) => n !== "latest-linux.yml.minisig" && n !== "tavrn_0.3.0_amd64.deb.sha256");
  assert.deepEqual(checkAssets(without, "0.3.0"), ["missing: tavrn_0.3.0_amd64.deb.sha256", "missing: latest-linux.yml.minisig"]);
  // The Tauri Linux bundles retired; electron-builder's default Windows name would hide the fallback from the page.
  const extra = [...RELEASE_0_3_0, "Tavrn_0.3.0_amd64.AppImage", "Tavrn_0.3.0_amd64.deb", "Tavrn Setup 0.3.0.exe", "latest-linux.yml.sig"];
  assert.deepEqual(checkAssets(extra, "0.3.0"), [
    "unexpected: Tavrn_0.3.0_amd64.AppImage",
    "unexpected: Tavrn_0.3.0_amd64.deb",
    "unexpected: Tavrn Setup 0.3.0.exe",
    "unexpected: latest-linux.yml.sig",
  ]);
  assert.equal(websiteEntry("Tavrn Setup 0.3.0.exe"), null, "electron-builder's default name is not a download on the page");
});

test("pre-release tags", () => {
  assert.equal(versionOf("v1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => versionOf("1.2.3"), /tag/);
  assert.throws(() => versionOf("v1.2"), /tag/);
  const names = expectedAssets("1.2.3-rc.1").map((a) => a.name);
  assert.ok(names.includes("tavrn-electron_1.2.3-rc.1_x64-setup.exe"));
  assert.deepEqual(checkAssets(names, "1.2.3-rc.1"), []);
});

test("the release notes name every download with its platform, the fallback marked, and explain sums and feeds", () => {
  const notes = releaseNotes("v0.3.0", "just-tavrn/tavrn-web");
  for (const a of expectedAssets("0.3.0").filter((x) => x.installer || x.name.endsWith(".tar.gz"))) {
    assert.ok(notes.includes(`[\`${a.name}\`](https://github.com/just-tavrn/tavrn-web/releases/download/v0.3.0/${a.name})`), a.name);
  }
  assert.match(notes, /\| Windows \(fallback\) \| \[`tavrn-electron_0\.3\.0_x64-setup\.exe`\].*\*\*Fallback only\*\*/);
  assert.match(notes, /sha256sum -c/);
  assert.match(notes, /latest-linux\.yml/);
  assert.match(notes, /\.minisig/);
  assert.ok(notes.startsWith("## Downloads\n"));
});
