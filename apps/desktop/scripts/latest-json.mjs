#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Writes the update manifest `latest.json` of a release (tauri-plugin-updater's static JSON format) from the signed
 * Tauri installers in a directory: the `.sig` file next to the MSI and the NSIS installer (Windows; Linux ships the
 * Electron app, whose feed is electron-builder's latest-linux.yml). The Electron build for Windows (its name contains
 * "electron") is never a Tauri update.
 *   node latest-json.mjs <dir> <tag> <owner/repo> [notes] > latest.json
 * The app fetches it from https://github.com/<owner/repo>/releases/latest/download/latest.json (docs/DESKTOP.md).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Installer suffix → updater platform keys (the first is the installer-specific key, then the default). */
const KINDS = [
  { suffix: "-setup.exe", keys: ["windows-x86_64-nsis", "windows-x86_64"] },
  { suffix: ".msi", keys: ["windows-x86_64-msi"] },
];

export function platformsOf(dir, downloadBase) {
  const names = readdirSync(dir);
  const platforms = {};
  for (const { suffix, keys } of KINDS) {
    const installer = names.find((n) => n.endsWith(suffix) && !/electron/i.test(n) && names.includes(`${n}.sig`));
    if (!installer) continue;
    const entry = { signature: readFileSync(join(dir, `${installer}.sig`), "utf8").trim(), url: `${downloadBase}/${encodeURIComponent(installer)}` };
    for (const key of keys) platforms[key] ??= entry;
  }
  return platforms;
}

export function latestJson({ dir, tag, repo, notes = "", date = new Date().toISOString() }) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`not a release tag: ${tag}`);
  const platforms = platformsOf(dir, `https://github.com/${repo}/releases/download/${tag}`);
  if (Object.keys(platforms).length === 0) throw new Error(`no signed installer in ${dir}`);
  return { version: m[1], notes, pub_date: date, platforms };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, tag, repo, notes] = process.argv.slice(2);
  if (!dir || !tag || !repo) {
    console.error("usage: latest-json.mjs <dir> <tag> <owner/repo> [notes]");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(latestJson({ dir, tag, repo, notes }), null, 2)}\n`);
}
