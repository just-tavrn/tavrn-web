#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Copies the built native modules of this platform to `dist/native/<name>.node`, where the main process loads them:
 * the key listener (`native/keywatch`, docs/DESKTOP.md "Hotkeys") and, on Linux, the passkeys (`native/passkeys`,
 * "Passkeys on Linux"); `pnpm --filter @tavrn/keywatch-native build` and `@tavrn/passkeys-native` build them (just
 * electron-native). Without a module the app runs (the hotkeys answer `hotkey.unavailable`, passkeys go through the
 * browser); `--require` (the package step) fails instead.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The modules, and the platforms that have them. */
const MODULES = [
  { name: "keywatch", platforms: ["linux", "win32"], without: "the app runs without system-wide hotkeys" },
  { name: "passkeys", platforms: ["linux"], without: "passkeys go through the browser" },
];
let failed = false;
for (const { name, platforms, without } of MODULES) {
  if (!platforms.includes(process.platform)) continue;
  const source = join(app, "native", name);
  const prefix = `${name}.${process.platform}-${process.arch}`;
  const built = existsSync(source) ? readdirSync(source).filter((f) => f.startsWith(prefix) && f.endsWith(".node")) : [];
  const target = join(app, "dist", "native", `${name}.node`);
  if (built.length !== 1) {
    const why = built.length ? `several builds (${built.join(", ")})` : `no ${prefix}*.node`;
    if (process.argv.includes("--require")) {
      console.error(`copy-native: ${why} in ${source}: build it with \`pnpm --filter @tavrn/${name}-native build\` (just electron-native)`);
      failed = true;
    } else {
      console.warn(`copy-native: ${why} in ${source}; ${without}`);
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(source, built[0]), target);
  console.log(`copy-native: ${built[0]} → dist/native/${name}.node`);
}
if (failed) process.exit(1);
