#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * WebDriver smoke test of the BUILT desktop app (docs/DESKTOP.md "Tests"): the app starts, shows the node picker,
 * refuses `http://evil`, accepts a node in development mode on this computer and reaches the login page; then an
 * account (registered over the API with TOTP) signs in with password and TOTP code, sets up its recovery key (the
 * encryption core in the webview) and sends a message in an end-to-end encrypted channel, which the node stores as
 * ciphertext only. Then voice on Linux: media streams are on, and WebRTC is on whenever the system's WebKitGTK is
 * built with it; and a global hotkey: the recorder of Settings → Voice binds Ctrl+Alt+M to "mute", the window is
 * minimized and a real key press of the X server (xdotool) toggles mute through the shell's global grab.
 *
 * Plain WebDriver over HTTP (no client library): tauri-driver (`cargo install tauri-driver --locked`) drives the app
 * through WebKitWebDriver (Linux packages `webkit2gtk-driver` or `webkitgtk-webdriver`) and `xdotool` for the global
 * hotkey. Linux only; under `xvfb-run` without a display.
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
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
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
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

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
const xpath = async (path) => (await wd("POST", `/session/${session}/element`, { using: "xpath", value: path }))[ELEMENT];
const script = (body, args = []) => wd("POST", `/session/${session}/execute/sync`, { script: body, args });

// ---- the node's API (the account is registered there, like the Playwright helpers do) ----
async function api(method, path, body, token) {
  const resp = await fetch(`${nodeUrl}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${JSON.stringify(json)}`);
  return json;
}

function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

function totp(secret, stepNo) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepNo));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A code newer than the last accepted step (the node refuses replays), within the node's window. */
async function nextCode(account) {
  const now = () => Math.floor(Date.now() / 30_000);
  while (account.lastStep + 1 > now() + 1) await sleep(1000);
  account.lastStep = Math.max(now(), account.lastStep + 1);
  return totp(account.secret, account.lastStep);
}

/** Whether the system's WebKitGTK is built with WebRTC (distributions build it without: ENABLE_WEB_RTC is off). */
function webkitHasWebrtc() {
  try {
    const lib = execFileSync("ldconfig", ["-p"], { encoding: "utf8" }).match(/=>\s*(\S*libwebkit2gtk-4\.1\.so\.0)\s*$/m)?.[1];
    return !!lib && /libgstwebrtc-1\.0/.test(execFileSync("ldd", [lib], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

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

  // An account with TOTP, registered over the API (another device of the same user).
  const username = `desk${randomBytes(4).toString("hex")}`;
  const password = `passwort-${username}-xyz`;
  const pre = await api("POST", "/auth/register", { username, password, device_name: "smoke" });
  const { secret } = await api("POST", "/auth/totp/enroll", {}, pre.preauth_token);
  const account = { secret, lastStep: 0 };
  const confirmed = await api("POST", "/auth/totp/confirm", { code: await nextCode(account) }, pre.preauth_token);
  const apiToken = confirmed.session.access_token;

  // Password and second factor in the app.
  await type(await find("input[name=username]"), username);
  await type(await find("input[name=password]"), password);
  await click(await find("form button[type=submit]"));
  const code = await waitFor("input[name=totp_code]", 30_000);
  await type(code, await nextCode(account));
  await click(await find("form button[type=submit]"));
  await waitFor("[data-testid=recovery-key-words]", 60_000);
  step("signed in with password and TOTP");

  // The recovery key: generated by the encryption core (WebAssembly) in the webview.
  await click(await find("input[type=checkbox]"));
  await click(await xpath("//input[@type='checkbox']/ancestor::label/following-sibling::button[1]"));
  await waitFor("[data-testid=app-shell]", 60_000);
  step("recovery key set up, app shell shown");

  // A message in an end-to-end encrypted channel (the room's default text channel is encrypted).
  const room = await api("POST", "/rooms", { name: "Desktop smoke", join_mode: "invite" }, apiToken);
  const channel = room.channels.find((c) => c.kind === "text");
  await script("history.pushState({}, '', arguments[0]); dispatchEvent(new PopStateEvent('popstate'));", [`/rooms/${room.id}/channels/${channel.id}`]);
  const composer = await waitFor("[data-testid=composer] textarea:not([aria-hidden])", 30_000);
  const sent = `Hello from the desktop app ${randomBytes(3).toString("hex")}`;
  // The text goes in like typed input (WebKitWebDriver's keyboard does not reach the composer under xvfb), Enter sends.
  await script(
    `const el = arguments[0];
     el.focus();
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, arguments[1]);
     el.dispatchEvent(new Event("input", { bubbles: true }));`,
    [{ [ELEMENT]: composer }, sent],
  );
  await sleep(300);
  await script(`arguments[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));`, [{ [ELEMENT]: composer }]);
  await until("the sent message", async () => {
    const messages = await wd("POST", `/session/${session}/elements`, { using: "css selector", value: "[data-testid=message]" });
    for (const m of messages) if ((await text(m[ELEMENT])).includes(sent)) return true;
    return false;
  }, 60_000);
  const stored = await api("GET", `/rooms/${room.id}/channels/${channel.id}/messages`, undefined, apiToken);
  const list = Array.isArray(stored) ? stored : (stored.messages ?? stored.items ?? []);
  if (JSON.stringify(stored).includes(sent)) throw new Error("the node stored the message in plaintext");
  if (!list.some((m) => m.encrypted === true && m.author === `${username}@localhost`)) throw new Error(`no encrypted message of the account: ${JSON.stringify(stored).slice(0, 300)}`);
  step("message sent in an encrypted channel; the node holds ciphertext only");

  // Voice on Linux: the shell switches on media streams and WebRTC of WebKitGTK (src-tauri/src/media.rs).
  const media = await script("return { pc: typeof RTCPeerConnection, gum: typeof (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };");
  if (media.gum !== "function") throw new Error(`no getUserMedia in the webview: ${JSON.stringify(media)}`);
  if (webkitHasWebrtc()) {
    if (media.pc !== "function") throw new Error("the system's WebKitGTK has WebRTC, but RTCPeerConnection is missing in the app");
    step("getUserMedia and RTCPeerConnection present");
  } else {
    if (media.pc !== "undefined") throw new Error(`unexpected RTCPeerConnection without a WebRTC build: ${media.pc}`);
    step("getUserMedia present; this system's WebKitGTK is built without WebRTC (no RTCPeerConnection, docs/DESKTOP.md)");
  }

  // A global hotkey: bound in Settings → Voice, pressed through the X server while the window is minimized.
  await script("history.pushState({}, '', '/settings/voice'); dispatchEvent(new PopStateEvent('popstate'));");
  await click(await waitFor("[data-testid=hotkey-toggle_mute-change]", 30_000));
  // The combination goes in like typed input (WebKitWebDriver's keyboard does not reach the page under xvfb).
  await script(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", key: "m", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));`);
  await until("the bound combination", async () => (await text(await find("[data-testid=hotkey-toggle_mute-key]"))) === "Ctrl + Alt + M");
  step("Ctrl+Alt+M bound to mute through the shell");
  const minimized = await wd("POST", `/session/${session}/window/minimize`, {}).then(
    () => true,
    () => false,
  );
  const pressAndExpect = async (pattern) => {
    execFileSync("xdotool", ["key", "--clearmodifiers", "ctrl+alt+m"]);
    return until(`the mute toast ${pattern}`, async () => {
      // textContent: a minimized window renders nothing, the DOM is there.
      const toasts = await script("return [...document.querySelectorAll('[data-testid=hotkey-voice-state]')].map((e) => e.textContent);");
      return toasts.some((t) => pattern.test(t));
    });
  };
  await pressAndExpect(/muted|stummgeschaltet/i);
  await pressAndExpect(/Microphone on|Mikrofon an/i);
  step(`a real Ctrl+Alt+M of the X server toggled mute and back${minimized ? " while the window was minimized" : " (the window could not be minimized)"}`);
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
