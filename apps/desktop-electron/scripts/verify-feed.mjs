#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Checks the signed update feeds of a release before the upload (desktop.yml, release-assets): `<feed>.minisig` must
 * verify with the update key of tauri.conf.json and name the feed file and the feed's version in its trusted comment,
 * exactly what the app checks before it offers an update (src/main/updater.ts, docs/DESKTOP.md "Updates").
 *   node verify-feed.mjs <feed>...      e.g. installers/latest-linux.yml installers/latest.yml
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePublicKey, verifyMinisign } from "../src/main/minisign.ts";
import { parseFeed } from "../src/main/updater.ts";

const TAURI_CONF = new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url);

/** The update key of both shells (`plugins.updater.pubkey`). */
export function updateKey(conf = TAURI_CONF) {
  return JSON.parse(readFileSync(conf, "utf8")).plugins.updater.pubkey;
}

/** Verifies one feed and its `.minisig`; returns the signed version, throws with the reason otherwise. */
export function verifyFeedFile(feedPath, pubkey) {
  const feed = readFileSync(feedPath);
  const { fields } = verifyMinisign(feed, readFileSync(`${feedPath}.minisig`, "utf8"), parsePublicKey(pubkey));
  const { version, files } = parseFeed(feed.toString("utf8"));
  if (fields.file !== basename(feedPath)) throw new Error(`${feedPath}: signed for ${fields.file ?? "no file name"}`);
  if (!version || fields.version !== version) throw new Error(`${feedPath}: signed for version ${fields.version ?? "(none)"}, the feed says ${version || "(none)"}`);
  if (files.length === 0 || files.some((f) => !f.url || !f.sha512)) throw new Error(`${feedPath}: no files with their SHA-512`);
  return version;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const feeds = process.argv.slice(2);
  if (feeds.length === 0) {
    console.error("usage: verify-feed.mjs <feed>...");
    process.exit(2);
  }
  try {
    const key = updateKey();
    for (const feed of feeds) console.log(`${feed}: signed, version ${verifyFeedFile(feed, key)}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
