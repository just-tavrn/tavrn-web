// SPDX-License-Identifier: Apache-2.0
// node --test: the release workflow keeps the updater key away from every job that builds or installs dependencies
// (docs/DESKTOP.md "Builds and releases"). Only desktop.yml's release-assets job may name the key; it declares the
// environment `release`, installs only the Tauri CLI without lifecycle scripts and runs no build, no cargo and no
// Actions cache. A compromised dependency in a build job therefore never sees the key that signs every update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const WORKFLOWS = new URL("../../../.github/workflows/", import.meta.url);
// The updater key and the Android signing key (keystore, its passwords and alias): release-assets only.
const KEY = /TAURI_SIGNING_PRIVATE_KEY|ANDROID_KEYSTORE|ANDROID_KEY_(ALIAS|PASSWORD)/;

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

/** The caller's pass-through of an environment secret by name: `NAME: ${{ secrets.NAME }}` in a `secrets:` mapping. */
const PASS_THROUGH = /^ {6}(TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?|ANDROID_KEYSTORE_B64|ANDROID_KEYSTORE_PASSWORD|ANDROID_KEY_ALIAS|ANDROID_KEY_PASSWORD): \$\{\{ secrets\.\1 \}\}$/;

test("only desktop.yml's release-assets job names the updater key; release.yml passes it by name to desktop.yml", () => {
  for (const file of files) {
    const { jobs } = jobsOf(readFileSync(new URL(file, WORKFLOWS), "utf8"));
    for (const [name, body] of Object.entries(jobs)) {
      if (file === "desktop.yml" && name === "release-assets") continue;
      let lines = code(body).split("\n");
      if (file === "release.yml" && name === "desktop") {
        // A called workflow receives an environment secret only when the caller passes it by name; the value is the
        // environment's, resolved at the job that declares the environment. Nothing else of this job may name it.
        const passed = lines.filter((l) => PASS_THROUGH.test(l));
        assert.equal(passed.length, 6, "release.yml passes the updater key, the Android keystore and their passwords by name");
        lines = lines.filter((l) => !PASS_THROUGH.test(l));
      }
      assert.doesNotMatch(lines.join("\n"), KEY, `${file}: job ${name} names the updater key`);
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
  assert.deepEqual(Object.keys(desktop.jobs).sort(), ["android", "linux-electron", "macos", "release-assets", "route", "tauri-linux", "windows", "windows-electron", "windows-nsis"]);
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
  const upload = at(/name: desktop-linux-electron-a\$\{\{ github\.run_attempt \}\}\n/);
  assert.ok(pack >= 0 && upload > pack, "packaging, then the upload of desktop-linux-electron");
  assert.equal(upload - pack, 2, "only the collect step between packaging and the upload");
  for (const re of [/playwright install/, /livekit-install/, /NODE_IMAGE/, /playwright test/]) {
    const i = at(re);
    assert.ok(i > upload, `${re} must come after the upload`);
  }
});

test("release-assets takes each build artifact by id into its own directory and collects only allowed files before signing", () => {
  const steps = code(signer).split(/\n(?= {6}- )/);
  const downloads = steps.filter((s) => /actions\/download-artifact@/.test(s));
  assert.equal(downloads.length, 5);
  for (const d of downloads) {
    assert.match(d, /artifact-ids: \$\{\{ needs\.(windows|linux-electron|windows-electron|android|macos)\.outputs\.artifact-id \}\}/);
    assert.doesNotMatch(d, /^\s+name:/m, "never by artifact name");
    assert.match(d, /path: built\//);
  }
  const at = (re) => steps.findIndex((s) => re.test(s));
  const collect = at(/release-assets\.mjs collect/);
  assert.ok(collect > at(/download-artifact/) && collect < at(/tauri signer sign/), "collect after the downloads, before signing");
  for (const job of ["windows", "linux-electron", "windows-electron", "android", "macos"]) {
    assert.match(desktop.jobs[job], /outputs:\n\s+artifact-id: \$\{\{ steps\.\w+\.outputs\.artifact-id \}\}/, `${job} reports its artifact id`);
  }
});

test("build provenance only for public repositories; release specs use their own digest-pinned node image variable", () => {
  const attest = code(signer).split(/\n(?= {6}- )/).find((s) => /attest-build-provenance@/.test(s));
  assert.match(attest, /if: \$\{\{ !github\.event\.repository\.private \}\}/);
  const specs = code(desktop.jobs["linux-electron"]);
  assert.match(specs, /inputs\.release-tag && vars\.TAVRN_RELEASE_NODE_IMAGE \|\| 'ghcr\.io\/just-tavrn\/tavrn-node:edge'/);
});

test("the Android build: GitHub-hosted, aarch64 only, an unsigned APK, no key; release-assets signs it with apksigner", () => {
  const android = code(desktop.jobs.android);
  assert.match(android, /runs-on: ubuntu-latest/);
  assert.match(android, /tauri android build --apk --target aarch64/);
  assert.doesNotMatch(android, /--target (armv7|i686|x86_64)/);
  assert.match(android, /sdkmanager[^\n]*"ndk;28\.2\.13676358"/, "the NDK pinned");
  assert.match(android, /android-arm64-unsigned\.apk/);
  assert.doesNotMatch(android, /apksigner|keystore/i);
  const steps = code(signer).split(/\n(?= {6}- )/);
  const at = (re) => steps.findIndex((s) => re.test(s));
  const sign = at(/apksigner" sign/);
  assert.ok(sign > at(/release-assets\.mjs collect/), "signed after collect");
  assert.ok(sign < at(/checksums\.mjs/), "signed before the checksums and the asset check");
  assert.match(steps[sign], /apksigner" verify/);
  assert.match(steps[sign], /rm -f "\$keystore"/, "the keystore file is removed");
  assert.match(code(signer), /needs: \[linux-electron, windows-electron, windows, android, macos\]/);
});

test("macOS: GitHub-hosted, universal, unsigned, no key, never fails a release; release-assets signs its app archive", () => {
  const macos = desktop.jobs.macos;
  assert.match(code(macos), /runs-on: macos-latest/);
  assert.match(code(macos), /^ {4}continue-on-error: true$/m, "a failed macOS build never fails the release");
  assert.match(code(macos), /rustup target add aarch64-apple-darwin x86_64-apple-darwin/);
  assert.match(code(macos), /tauri build --target universal-apple-darwin --bundles app,dmg/);
  assert.match(code(macos), /"signingIdentity":"-"/, "signed ad hoc: Gatekeeper asks instead of calling the app damaged");
  assert.doesNotMatch(code(macos), /createUpdaterArtifacts|APPLE_|notar/i, "no updater artifacts and no Apple credentials in the build");
  assert.match(code(macos), /Tavrn_\$\{version\}_universal\.dmg/);
  assert.match(code(macos), /Tavrn_\$\{version\}_universal\.app\.tar\.gz/);
  // release-assets: the other build jobs must succeed, macOS may not; its download only when it uploaded.
  const ifLine = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(signer)?.[1] ?? "";
  assert.match(ifLine, /!cancelled\(\)/);
  for (const job of ["linux-electron", "windows-electron", "windows", "android"]) assert.match(ifLine, new RegExp(`needs\\.${job}\\.result == 'success'`), job);
  assert.doesNotMatch(ifLine, /needs\.macos\.result/);
  const steps = code(signer).split(/\n(?= {6}- )/);
  const download = steps.find((s) => /needs\.macos\.outputs\.artifact-id \}\}\n/.test(s) && /download-artifact/.test(s));
  assert.match(download, /if: \$\{\{ needs\.macos\.outputs\.artifact-id != '' \}\}/);
  assert.match(code(signer), /macos=built\/macos/);
  assert.match(code(signer), /for f in installers\/\*\.msi installers\/\*-setup\.exe installers\/\*\.app\.tar\.gz; do/);
});


test("the Tauri bundles are renamed to the release names after the build (the product is tavrn, the files keep Tavrn_…)", () => {
  // tauri.conf.json's productName is "tavrn" (tavrn-web#114) and tauri-bundler names its files after it; the release
  // keeps the capitalised names of the earlier releases (release-assets.mjs, latest.json, the website's download page).
  const rename = /for f in dist-desktop\/tavrn_\*; do mv "\$f" "dist-desktop\/Tavrn_\$\{f#dist-desktop\/tavrn_\}"; done/;
  for (const job of ["windows", "windows-nsis"]) {
    const steps = code(desktop.jobs[job]).split(/\n(?= {6}- )/);
    const build = steps.findIndex((s) => /tauri build/.test(s));
    const collect = steps.findIndex((s) => rename.test(s));
    assert.ok(build >= 0 && collect > build, `${job}: the rename follows the build`);
    const upload = steps.findIndex((s) => /upload-artifact@/.test(s));
    assert.ok(upload > collect, `${job}: the artifact is uploaded after the rename`);
  }
  const macos = code(desktop.jobs.macos);
  assert.match(macos, /cp "\$bundle\/dmg\/tavrn_\$\{version\}_universal\.dmg" "dist-macos\/Tavrn_\$\{version\}_universal\.dmg"/);
  assert.match(macos, /tar -czf "dist-macos\/Tavrn_\$\{version\}_universal\.app\.tar\.gz" -C "\$bundle\/macos" tavrn\.app/);
  assert.doesNotMatch(macos, /Tavrn\.app/, "the bundle is tavrn.app now");
});

test("macOS checkout disables credential helpers, has a short timeout and precedes dependency URL rewrites", () => {
  const steps = code(desktop.jobs.macos).split(/\n(?= {6}- )/);
  const helper = steps.findIndex((s) => /git config --global credential\.helper ''/.test(s));
  const checkout = steps.findIndex((s) => /actions\/checkout@/.test(s));
  const auth = steps.findIndex((s) => /insteadOf/.test(s));
  assert.ok(helper >= 0 && helper < checkout && checkout < auth);
  assert.match(steps[checkout], /timeout-minutes: 5/);
  assert.match(steps[checkout], /persist-credentials: false/);
});

test("release builds restore no Actions cache (built from the tag; nothing a cache of main's runs holds reaches them)", () => {
  for (const job of ["linux-electron", "windows", "macos", "windows-electron", "android"]) {
    const steps = code(desktop.jobs[job]).split(/\n(?= {6}- )/);
    for (const s of steps.filter((x) => /actions\/setup-node@/.test(x))) {
      assert.doesNotMatch(s, /cache: pnpm/, `${job}: setup-node caches the pnpm store unconditionally`);
      assert.match(s, /package-manager-cache: false/, `${job}: setup-node's automatic cache`);
      const cache = /cache: (.*)/.exec(s)?.[1];
      if (cache) assert.equal(cache, "${{ !inputs.release-tag && 'pnpm' || '' }}", `${job}: the pnpm cache must be off for a release`);
    }
    for (const s of steps.filter((x) => /Swatinem\/rust-cache@/.test(x))) {
      assert.match(s, /if: \$\{\{[^}]*!inputs\.release-tag[^}]*\}\}/, `${job}: rust-cache must be off for a release`);
    }
  }
  const release = code(readFileSync(new URL("release.yml", WORKFLOWS), "utf8"));
  assert.doesNotMatch(release, /cache: pnpm|rust-cache|actions\/cache@/, "release.yml restores a cache");
});

test("one web build per push: ci.yml uploads web/dist, the desktop jobs of its call download it", () => {
  const ci = jobsOf(readFileSync(new URL("ci.yml", WORKFLOWS), "utf8"));
  assert.match(code(ci.jobs.js), /artifact-name: \$\{\{ github\.event_name == 'push' && 'web-dist' \|\| '' \}\}/);
  assert.match(code(ci.jobs.js), /artifact-path: web\/dist/);
  assert.match(code(ci.jobs.desktop), /uses: \.\/\.github\/workflows\/desktop\.yml/);
  assert.match(code(ci.jobs.desktop), /web-dist-artifact: web-dist/);
  assert.match(code(ci.jobs.desktop), /needs: \[changes, js\]/);
  for (const job of ["tauri-linux", "linux-electron", "windows-nsis"]) {
    const steps = code(desktop.jobs[job]).split(/\n(?= {6}- )/);
    const download = steps.find((x) => /actions\/download-artifact@/.test(x) && /name: \$\{\{ inputs\.web-dist-artifact \}\}/.test(x));
    assert.ok(download, `${job}: downloads the CI run's web/dist`);
    assert.match(download, /path: web\/dist/);
    assert.match(download, /if: \$\{\{ inputs\.web-dist-artifact != ''/);
  }
  // A release builds web/dist from the tag itself, never from an artifact.
  const electron = code(desktop.jobs["linux-electron"]).split(/\n(?= {6}- )/);
  assert.match(electron.find((x) => /pnpm --filter @tavrn\/web build/.test(x)), /if: \$\{\{ inputs\.web-dist-artifact == '' \|\| inputs\.release-tag \}\}/);
  assert.match(electron.find((x) => /download-artifact@/.test(x) && /web-dist-artifact/.test(x)), /!inputs\.release-tag/);
});

test("the self-hosted jobs take the organization's trust rule from route.yml, never a copy of it", () => {
  assert.match(code(desktop.jobs.route), /uses: just-tavrn\/\.github\/\.github\/workflows\/route\.yml@main/);
  assert.match(code(desktop.jobs.route), /if: \$\{\{ vars\.CI_ENABLED == 'true' && !inputs\.release-tag \}\}/);
  assert.match(code(desktop.jobs["tauri-linux"]), /runs-on: \$\{\{ fromJSON\(needs\.route\.outputs\.runs-on\) \}\}/);
  assert.match(code(desktop.jobs["linux-electron"]), /runs-on: \$\{\{ fromJSON\(inputs\.release-tag && '"ubuntu-latest"' \|\| needs\.route\.outputs\.runs-on\) \}\}/);
  assert.match(code(desktop.jobs["windows-nsis"]), /needs\.route\.outputs\.self-hosted == 'true'/);
  for (const file of files) {
    assert.doesNotMatch(code(readFileSync(new URL(file, WORKFLOWS), "utf8")), /head\.repo\.full_name == github\.repository/, `${file} copies the trust rule`);
  }
});
