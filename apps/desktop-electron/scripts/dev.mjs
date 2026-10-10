#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * `pnpm dev` of the Electron shell (just electron-dev): the web client's Vite dev server (hot reload) and the app in
 * development mode on it (TAVRN_DESKTOP_DEV_URL). The shell is built once first; restart after changing it. Ends both
 * when the app quits or on Ctrl+C.
 *
 * Environment: E2E_WEB_PORT the dev server's port (default 5173); the app's own variables pass through.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devEnv } from "./dev-lib.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.E2E_WEB_PORT ?? "5173");
const devUrl = `http://localhost:${port}`;

const build = spawnSync("pnpm", ["run", "build"], { cwd: appDir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

// The dev server in its own process group, so it ends with all its children.
const vite = spawn("pnpm", ["--filter", "@tavrn/web", "dev"], { cwd: appDir, stdio: "inherit", detached: true, env: { ...process.env, E2E_WEB_PORT: String(port) } });
let app = null;
const stop = (code) => {
  if (app && app.exitCode === null) app.kill("SIGTERM");
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {
    // already gone
  }
  process.exit(code);
};
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
vite.on("exit", (code) => {
  if (!app) {
    console.error(`electron dev: the Vite dev server ended (${code}) before the app started`);
    process.exit(1);
  }
});

const deadline = Date.now() + 120_000;
while (true) {
  const up = await fetch(devUrl).then((r) => r.ok, () => false);
  if (up) break;
  if (Date.now() > deadline) {
    console.error(`electron dev: no dev server on ${devUrl}`);
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}

const electron = createRequire(import.meta.url)("electron");
app = spawn(electron, [appDir], { cwd: appDir, stdio: "inherit", env: devEnv(process.env, devUrl) });
app.on("exit", (code) => stop(code ?? 0));
