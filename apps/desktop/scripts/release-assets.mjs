#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The assets of a tavrn-web release (docs/DESKTOP.md "Builds and releases"): the exact file names, the release notes'
 * table of them, and the check that a release carries exactly these files, named as the download page of the website
 * reads them (its classifier in tavrn-website src/lib/releases.ts, re-implemented minimally below).
 *   node release-assets.mjs check <tag> <dir>     the desktop assets in <dir> before the upload (exactly the expected set)
 *   node release-assets.mjs check-release <tag>   the asset names of the whole release on stdin, one per line
 *   node release-assets.mjs notes <tag> <owner/repo>   the asset table of the release notes (Markdown)
 */
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The version of a release tag (`v1.2.3`, `v1.2.3-rc.1`). */
export function versionOf(tag) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`not a release tag: ${tag}`);
  return m[1];
}

/**
 * Every file of a release. `from`: the job that attaches it (`release` for release.yml's web bundle, `desktop` for
 * desktop.yml's release-assets job). `installer`: what the download page lists (it also needs `<name>.sha256`).
 */
export function expectedAssets(version) {
  const v = version;
  return [
    { name: `Tavrn_${v}_x64-setup.exe`, from: "desktop", installer: { os: "windows", shell: "tauri", kind: "nsis" }, signed: true },
    { name: `Tavrn_${v}_x64_en-US.msi`, from: "desktop", installer: { os: "windows", shell: "tauri", kind: "msi" }, signed: true },
    { name: `tavrn-electron_${v}_x64-setup.exe`, from: "desktop", installer: { os: "windows", shell: "electron", kind: "nsis" } },
    { name: `tavrn-electron_${v}_x64-setup.exe.blockmap`, from: "desktop" },
    { name: `Tavrn-${v}.AppImage`, from: "desktop", installer: { os: "linux", shell: "electron", kind: "appimage" } },
    { name: `tavrn_${v}_amd64.deb`, from: "desktop", installer: { os: "linux", shell: "electron", kind: "deb" } },
    { name: "latest.json", from: "desktop" },
    { name: "latest.yml", from: "desktop" },
    { name: "latest.yml.minisig", from: "desktop" },
    { name: "latest-linux.yml", from: "desktop" },
    { name: "latest-linux.yml.minisig", from: "desktop" },
    { name: `tavrn-web-${v}.tar.gz`, from: "release" },
    { name: `tavrn-web-${v}.tar.gz.sha256`, from: "release" },
  ].flatMap((a) => [
    a,
    ...(a.installer ? [{ name: `${a.name}.sha256`, from: a.from }] : []),
    ...(a.signed ? [{ name: `${a.name}.sig`, from: a.from }] : []),
  ]);
}

// The download page's rules (tavrn-website src/lib/releases.ts: FORMATS, shellOf, archFromName), kept as small as the
// check needs: which files count as installers, for which system and shell. A name the page would misread fails here.
const FORMATS = [
  { kind: "nsis", os: "windows", test: /-setup\.exe$|electron.*\.exe$/i },
  { kind: "msi", os: "windows", test: /\.msi$/i },
  { kind: "appimage", os: "linux", test: /\.appimage$/i },
  { kind: "deb", os: "linux", test: /\.deb$/i },
  { kind: "dmg", os: "macos", test: /\.dmg$/i },
  { kind: "app-tar", os: "macos", test: /\.app\.tar\.gz$/i },
  { kind: "apk", os: "android", test: /\.apk$/i },
];

function archFromName(name) {
  const lower = name.toLowerCase();
  const token = (t) => new RegExp(`(^|[^a-z0-9])(${t})([^a-z0-9]|$)`).test(lower);
  if (token("aarch64|arm64")) return "arm64";
  if (/x86[_-]64/.test(lower) || token("x64|amd64")) return "x64";
  if (token("universal")) return "universal";
  if (token("i686|i386|x86")) return "x86";
  return null;
}

/** How the download page reads a file name: null for everything that is not a download (feeds, sums, signatures). */
export function websiteEntry(name) {
  const format = FORMATS.find((f) => f.test.test(name));
  if (!format) return null;
  const shell = format.os === "linux" || /electron/i.test(name) ? "electron" : "tauri";
  return { os: format.os, shell, kind: format.kind, arch: archFromName(name) ?? (format.os === "linux" ? "x64" : null) };
}

/** Compares asset names with the expected set; also checks that the page reads every expected installer as intended. */
export function checkAssets(names, version, from = ["desktop", "release"]) {
  const expected = expectedAssets(version).filter((a) => from.includes(a.from));
  const have = new Set(names);
  const want = new Set(expected.map((a) => a.name));
  const problems = [];
  for (const a of expected) {
    if (!have.has(a.name)) problems.push(`missing: ${a.name}`);
    if (a.installer) {
      const entry = websiteEntry(a.name);
      const ok = entry && entry.os === a.installer.os && entry.shell === a.installer.shell && entry.kind === a.installer.kind && entry.arch === "x64";
      if (!ok) problems.push(`the download page would read ${a.name} as ${JSON.stringify(entry)}`);
    } else if (websiteEntry(a.name)) {
      problems.push(`the download page would list ${a.name} as an installer`);
    }
  }
  for (const name of names) if (!want.has(name)) problems.push(`unexpected: ${name}`);
  return problems;
}

/** The fixed table in front of the generated release notes. */
export function releaseNotes(tag, repo) {
  const v = versionOf(tag);
  const url = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const link = (name) => `[\`${name}\`](${url(name)})`;
  const rows = [
    ["Windows (recommended)", link(`Tavrn_${v}_x64-setup.exe`), "Installer for the current user (Tauri, uses the system's WebView2)"],
    ["Windows (recommended)", link(`Tavrn_${v}_x64_en-US.msi`), "The same app as an MSI package, for managed installs"],
    ["Windows (fallback)", link(`tavrn-electron_${v}_x64-setup.exe`), "**Fallback only**: the full version with its own Chromium (Electron), for computers where WebView2 causes trouble; larger"],
    ["Linux", link(`Tavrn-${v}.AppImage`), "Runs without installing on most distributions (Electron); on Ubuntu 24.04 and later prefer the .deb"],
    ["Linux (Debian, Ubuntu)", link(`tavrn_${v}_amd64.deb`), "Package with a sandbox profile for Ubuntu (Electron); recommended on Ubuntu"],
    ["Node operators", link(`tavrn-web-${v}.tar.gz`), "The web client bundle (`web/dist`) for building a node image"],
  ];
  return [
    "## Downloads",
    "",
    "| Platform | File | What |",
    "|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "Every installer and the web bundle have a `<file>.sha256` next to them: check a download with `sha256sum -c <file>.sha256` in its folder. The installers are not signed with an OS code-signing certificate yet, so Windows SmartScreen warns on the first start.",
    "",
    "The installed apps update themselves from these files: `latest.json` with the `.sig` signatures (Windows, Tauri), `latest.yml` (Windows fallback) and `latest-linux.yml` (Linux), each with a `.minisig` signature made with the same update key. They are not downloads.",
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, tag, arg] = process.argv.slice(2);
  try {
    if (command === "notes" && tag && arg) {
      process.stdout.write(releaseNotes(tag, arg));
    } else if ((command === "check" && tag && arg) || (command === "check-release" && tag)) {
      const version = versionOf(tag);
      const names = command === "check" ? readdirSync(arg) : readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
      const problems = checkAssets(names, version, command === "check" ? ["desktop"] : ["desktop", "release"]);
      if (problems.length) {
        console.error(`the release assets of ${tag} are not as expected (docs/DESKTOP.md "Builds and releases"):\n  ${problems.join("\n  ")}`);
        process.exit(1);
      }
      console.log(`${names.length} release assets of ${tag} as expected`);
    } else {
      console.error("usage: release-assets.mjs check <tag> <dir> | check-release <tag> < names | notes <tag> <owner/repo>");
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
