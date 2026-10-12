#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Checks the Tauri updater signatures of a release before the upload (desktop.yml, release-assets): every Tauri
 * installer (`*.msi`, `*-setup.exe` without "electron" in the name, the macOS `*.app.tar.gz`) needs a `<installer>.sig` that verifies with the
 * update key of tauri.conf.json and names the installer in its trusted comment, and every platform of `latest.json`
 * must carry exactly that signature for the file its URL names. This is what tauri-plugin-updater checks before it
 * installs an update (the minisign crate: `ED`/`Ed` Ed25519 signatures over the whole installer); the `.sig` file
 * is the minisign signature base64-encoded once more, as `tauri signer sign` writes it.
 *   node verify-tauri.mjs <dir>       e.g. installers
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePublicKey, verifyMinisign } from "../../desktop-electron/src/main/minisign.ts";

const TAURI_CONF = new URL("../src-tauri/tauri.conf.json", import.meta.url);

/** The update key (`plugins.updater.pubkey`, the minisign public key file base64-encoded). */
export function updateKey(conf = TAURI_CONF) {
  return JSON.parse(readFileSync(conf, "utf8")).plugins.updater.pubkey;
}

/** The Tauri installers of a release directory (the Electron fallback for Windows is never a Tauri update). */
export function tauriInstallers(dir) {
  return readdirSync(dir)
    .filter((n) => (n.endsWith(".msi") || n.endsWith("-setup.exe") || n.endsWith(".app.tar.gz")) && !/electron/i.test(n))
    .sort();
}

/** Verifies one installer against its signature text (the `.sig` content); throws with the reason otherwise. */
export function verifyInstaller(path, signature, pubkey) {
  const { fields } = verifyMinisign(readFileSync(path), signature, parsePublicKey(pubkey));
  if (fields.file !== basename(path)) throw new Error(`${path}: signed for ${fields.file ?? "no file name"}`);
}

/** Verifies the installers of `dir` and, when present, its latest.json; returns the names of the checked installers. */
export function verifyRelease(dir, pubkey) {
  const installers = tauriInstallers(dir);
  if (installers.length === 0) throw new Error(`${dir}: no Tauri installer`);
  for (const name of installers) {
    const sig = join(dir, `${name}.sig`);
    if (!existsSync(sig)) throw new Error(`${name}: no signature (${name}.sig)`);
    verifyInstaller(join(dir, name), readFileSync(sig, "utf8"), pubkey);
  }
  const manifest = join(dir, "latest.json");
  if (existsSync(manifest)) {
    const { platforms } = JSON.parse(readFileSync(manifest, "utf8"));
    if (!platforms || Object.keys(platforms).length === 0) throw new Error("latest.json: no platforms");
    for (const [platform, { url, signature }] of Object.entries(platforms)) {
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      if (!installers.includes(name)) throw new Error(`latest.json ${platform}: ${name} is not a signed installer of the release`);
      if (signature.trim() !== readFileSync(join(dir, `${name}.sig`), "utf8").trim()) throw new Error(`latest.json ${platform}: not the signature of ${name}`);
      verifyInstaller(join(dir, name), signature, pubkey);
    }
  }
  return installers;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: verify-tauri.mjs <dir>");
    process.exit(2);
  }
  try {
    for (const name of verifyRelease(dir, updateKey())) console.log(`${name}: signed with the update key`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
