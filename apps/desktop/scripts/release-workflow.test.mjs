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

test("no workflow passes the updater key through workflow-level env or `secrets: inherit`", () => {
  for (const file of files) {
    const text = readFileSync(new URL(file, WORKFLOWS), "utf8");
    // The workflow-level env reaches every job (on.workflow_call.secrets may declare the key: actionlint wants it).
    const env = /^env:\n((?: {2}.*\n?)*)/m.exec(jobsOf(text).head)?.[1] ?? "";
    assert.doesNotMatch(code(env), KEY, `${file}: the workflow-level env names the updater key`);
    assert.doesNotMatch(code(text), /secrets:\s*inherit/, `${file}: secrets: inherit hands every secret to a called workflow`);
  }
});

test("release-assets installs exactly the signer package, without scripts, in one form", () => {
  const installs = code(signer).split("\n").filter((l) => /\bpnpm\s+(install|i|add)\b/.test(l));
  assert.ok(installs.length > 0, "release-assets installs the signer");
  for (const line of installs) {
    assert.equal(line.trim(), "- run: pnpm install --frozen-lockfile --ignore-scripts --filter @tavrn/desktop", `unexpected install: ${line.trim()}`);
  }
});

test("linux-electron uploads the packages right after packaging, before the specs fetch or run anything", () => {
  const steps = code(desktop.jobs["linux-electron"]).split(/\n(?= {6}- )/);
  const at = (re) => steps.findIndex((s) => re.test(s));
  const pack = at(/pnpm --filter @tavrn\/desktop-electron package/);
  const upload = at(/name: desktop-linux-electron\n/);
  assert.ok(pack >= 0 && upload > pack, "packaging, then the upload of desktop-linux-electron");
  assert.equal(upload - pack, 2, "only the collect step between packaging and the upload");
  for (const re of [/playwright install/, /livekit-install/, /NODE_IMAGE/, /playwright test/]) {
    const i = at(re);
    assert.ok(i > upload, `${re} must come after the upload`);
  }
});
