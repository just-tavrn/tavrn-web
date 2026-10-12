#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Writes `<asset>.sha256` (sha256sum format, `sha256sum -c` checks it) next to every installer of a release directory
 * (`.AppImage`, `.deb`, `.exe`, `.msi`, `.apk`, `.dmg`, `.app.tar.gz`); updater signatures, feeds, block maps and existing sums get none. desktop.yml
 * runs it before the upload, so every installer on the GitHub release has its checksum (docs/DESKTOP.md "Builds and
 * releases").
 *   node checksums.mjs <dir>
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const INSTALLERS = [".AppImage", ".deb", ".exe", ".msi", ".apk", ".dmg", ".app.tar.gz"];

/** Writes the sums and returns the names of the written files, sorted. */
export function writeChecksums(dir) {
  const written = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!INSTALLERS.some((s) => name.endsWith(s)) || !statSync(path).isFile()) continue;
    const hex = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(`${path}.sha256`, `${hex}  ${name}\n`);
    written.push(`${name}.sha256`);
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: checksums.mjs <dir>");
    process.exit(2);
  }
  for (const name of writeChecksums(dir)) console.log(name);
}
