#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Copies the built key listener (`native/keywatch`, `pnpm --filter @tavrn/keywatch-native build`) of this platform to
 * `dist/native/keywatch.node`, where the main process loads it (docs/DESKTOP.md "Hotkeys"). Without the module the app
 * runs and the hotkeys answer `hotkey.unavailable`; `--require` (the package step) fails instead.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(app, "native", "keywatch");
const prefix = `keywatch.${process.platform}-${process.arch}`;
const built = existsSync(source) ? readdirSync(source).filter((f) => f.startsWith(prefix) && f.endsWith(".node")) : [];
const target = join(app, "dist", "native", "keywatch.node");
if (built.length !== 1) {
  const why = built.length ? `several builds (${built.join(", ")})` : `no ${prefix}*.node`;
  if (process.argv.includes("--require")) {
    console.error(`copy-native: ${why} in ${source}: build it with \`pnpm --filter @tavrn/keywatch-native build\` (just electron-native)`);
    process.exit(1);
  }
  console.warn(`copy-native: ${why} in ${source}; the app runs without system-wide hotkeys`);
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(source, built[0]), target);
console.log(`copy-native: ${built[0]} → dist/native/keywatch.node`);
