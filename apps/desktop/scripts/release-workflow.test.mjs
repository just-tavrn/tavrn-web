// SPDX-License-Identifier: Apache-2.0
// node --test: the release workflow keeps the updater key away from every job that builds or installs dependencies
// (docs/DESKTOP.md "Builds and releases"). Only desktop.yml's release-assets job may name the key; it declares the
// environment `release`, installs only the Tauri CLI without lifecycle scripts and runs no build, no cargo and no
// Actions cache. A compromised dependency in a build job therefore never sees the key that signs every update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const WORKFLOWS = new URL("../../../.github/workflows/", import.meta.url);
const KEY = /TAURI_SIGNING_PRIVATE_KEY/;

/** The jobs of a workflow file by name (the lines below `jobs:` at two spaces of indentation) and what precedes them. */
function jobsOf(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === "jobs:");
  assert.ok(at >= 0, "no jobs: block");
  const jobs = {};
  let name = null;
  for (const line of lines.slice(at + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) name = m[1];
    else if (name) jobs[name] = `${jobs[name] ?? ""}${line}\n`;
  }
  return { head: lines.slice(0, at).join("\n"), jobs };
}

/** The lines that run or configure something: comments dropped. */
const code = (body) => body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
const desktop = jobsOf(readFileSync(new URL("desktop.yml", WORKFLOWS), "utf8"));
const signer = desktop.jobs["release-assets"];

test("only desktop.yml's release-assets job names the updater key", () => {
  for (const file of files) {
    const { jobs } = jobsOf(readFileSync(new URL(file, WORKFLOWS), "utf8"));
    for (const [name, body] of Object.entries(jobs)) {
      if (file === "desktop.yml" && name === "release-assets") continue;
      assert.doesNotMatch(code(body), KEY, `${file}: job ${name} names the updater key`);
    }
  }
  assert.match(signer, KEY);
});

test("release-assets runs in the environment release and installs nothing but the signer, without scripts", () => {
  assert.match(signer, /^ {4}environment: release$/m);
  for (const line of signer.split("\n").filter((l) => /\bpnpm install\b/.test(l))) {
    assert.match(line, /--ignore-scripts/, `pnpm install without --ignore-scripts: ${line.trim()}`);
    assert.match(line, /--filter @tavrn\/desktop\b/, `pnpm install of more than the signer: ${line.trim()}`);
  }
  for (const forbidden of [/\btauri build\b/, /\bcargo\b/, /\brustup\b/, /rust-cache/, /\bnpm (install|ci)\b/, /\bnpx\b/, /pnpm (--filter \S+ )?(run )?(build|package)/, /actions\/cache@/, /cache: pnpm/]) {
    assert.doesNotMatch(code(signer), forbidden, `release-assets must not run ${forbidden}`);
  }
});

test("the Windows build makes no updater artifacts (release-assets signs the installers)", () => {
  assert.doesNotMatch(code(desktop.jobs.windows), /createUpdaterArtifacts/);
});

test("the parser sees the jobs of desktop.yml", () => {
  assert.deepEqual(Object.keys(desktop.jobs).sort(), ["linux-electron", "release-assets", "tauri-linux", "windows", "windows-electron", "windows-nsis"]);
});
