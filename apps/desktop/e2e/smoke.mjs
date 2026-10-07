#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * WebDriver smoke test of the BUILT desktop app (docs/DESKTOP.md "Tests"): the app starts, shows the node picker,
 * refuses `http://evil`, accepts a node in development mode on this computer and reaches the login page.
 *
 * Plain WebDriver over HTTP (no client library): tauri-driver (`cargo install tauri-driver --locked`) drives the app
 * through WebKitWebDriver (Linux packages `webkit2gtk-driver` or `webkitgtk-webdriver`). Linux only; under `xvfb-run`
 * without a display.
 *
 * Environment:
 *   TAVRN_DESKTOP_APP  the built app binary (default: $CARGO_TARGET_DIR/release/tavrn, else target/release/tavrn)
 *   E2E_NODE_BIN       a tavrn-node binary: the node runs in development mode with a temporary database
 *   E2E_NODE_PORT      the node's port (default 8300)
 *   E2E_NODE_URL       instead of E2E_NODE_BIN: a node in development mode that is already running
 *                      (http://127.0.0.1:<port>, e.g. the container image with host networking in desktop.yml)
 *   TAURI_DRIVER       the tauri-driver binary (default: tauri-driver on the PATH)
 *   WEBDRIVER_PORT     tauri-driver's port (default 4444; WebKitWebDriver uses the next one)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const targetDir = process.env.CARGO_TARGET_DIR || join(here, "../src-tauri/target");
const app = process.env.TAVRN_DESKTOP_APP || join(targetDir, "release", "tavrn");
const nodeBin = process.env.E2E_NODE_BIN;
const nodePort = Number(process.env.E2E_NODE_PORT || 8300);
const nodeUrl = process.env.E2E_NODE_URL || `http://127.0.0.1:${nodePort}`;
const driverBin = process.env.TAURI_DRIVER || "tauri-driver";
const driverPort = Number(process.env.WEBDRIVER_PORT || 4444);
const driver = `http://127.0.0.1:${driverPort}`;
const ELEMENT = "element-6066-11e4-a52f-4f735466cecf";

if (!nodeBin && !process.env.E2E_NODE_URL) fail("set E2E_NODE_BIN to a tavrn-node binary or E2E_NODE_URL to a running development node");
if (!existsSync(app)) fail(`no built app at ${app} (just desktop-build, or set TAVRN_DESKTOP_APP)`);

const scratch = mkdtempSync(join(tmpdir(), "tavrn-desktop-smoke-"));
const children = [];

function fail(message) {
  console.error(`desktop smoke: ${message}`);
  process.exit(1);
}

function start(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  child.log = log;
  children.push(child);
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function wd(method, path, body) {
  const resp = await fetch(`${driver}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${JSON.stringify(json.value ?? json)}`);
  return json.value;
}

let session = null;
const find = async (css) => (await wd("POST", `/session/${session}/element`, { using: "css selector", value: css }))[ELEMENT];
const text = async (id) => wd("GET", `/session/${session}/element/${id}/text`);
const type = async (id, value) => {
  await wd("POST", `/session/${session}/element/${id}/clear`, {});
  await wd("POST", `/session/${session}/element/${id}/value`, { text: value });
};
const click = async (id) => wd("POST", `/session/${session}/element/${id}/click`, {});
const waitFor = (css, timeoutMs) => until(`element ${css}`, () => find(css), timeoutMs);
const step = (name) => console.log(`desktop smoke: ${name}`);

async function main() {
  // A node in development mode with its own database (plain HTTP on 127.0.0.1: what the node picker allows).
  if (!process.env.E2E_NODE_URL) {
    start(nodeBin, ["--dev"], {
      TAVRN_LISTEN: `127.0.0.1:${nodePort}`,
      TAVRN_DATABASE_URL: `sqlite://${join(scratch, "node.db")}?mode=rwc`,
      TAVRN_DATA_DIR: join(scratch, "node"),
      TAVRN_VOICE_ENABLED: "false",
    });
  }
  await until("the node", async () => (await fetch(`${nodeUrl}/healthz`)).ok, 120_000);
  step(`node at ${nodeUrl}`);

  // The app's settings and web storage go to the scratch directory (a clean first start).
  const xdg = { XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), XDG_CACHE_HOME: join(scratch, "cache") };
  for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true });
  start(driverBin, ["--port", String(driverPort), "--native-port", String(driverPort + 1)], xdg);
  await until("tauri-driver", async () => (await fetch(`${driver}/status`)).ok);

  const created = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app } } } });
  session = created.sessionId;
  step("app started");

  const input = await waitFor("input[name=node]", 60_000);
  step("node picker shown");

  await type(input, "http://evil");
  await click(await find("form button[type=submit]"));
  const error = await waitFor("[data-testid=node-picker-error]");
  const message = await text(error);
  if (!/https/.test(message)) throw new Error(`unexpected refusal text: ${message}`);
  step(`http://evil refused: ${message}`);

  await type(await find("input[name=node]"), nodeUrl);
  await click(await find("form button[type=submit]"));
  await waitFor("input[name=username]", 30_000);
  const node = await until("the node name", async () => {
    const t = await text(await find("[data-testid=node-name]"));
    return /\(localhost\)/.test(t) ? t : null;
  });
  step(`login page of ${node}`);
}

async function cleanup(failed) {
  if (session) {
    if (failed) {
      try {
        const png = await wd("GET", `/session/${session}/screenshot`);
        mkdirSync(join(repo, "test-results"), { recursive: true });
        writeFileSync(join(repo, "test-results", "desktop-smoke.png"), Buffer.from(png, "base64"));
        console.error("desktop smoke: screenshot in test-results/desktop-smoke.png");
      } catch {
        /* no screenshot */
      }
    }
    await wd("DELETE", `/session/${session}`).catch(() => undefined);
  }
  for (const c of children.reverse()) c.kill("SIGTERM");
  await sleep(500);
  if (failed) for (const c of children) console.error(`--- ${c.spawnargs[0]}\n${c.log.join("").slice(-4000)}`);
  rmSync(scratch, { recursive: true, force: true });
}

main().then(
  async () => {
    await cleanup(false);
    console.log("desktop smoke: ok");
  },
  async (e) => {
    console.error(`desktop smoke: FAILED: ${e.message}`);
    await cleanup(true);
    process.exit(1);
  },
);
