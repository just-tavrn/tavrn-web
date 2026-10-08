#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * WebDriver smoke test of the BUILT desktop app (docs/DESKTOP.md "Tests"): the app starts and shows the node picker;
 * the shell's resolver reports an address whose domain has no node; the advanced node URL refuses `http://evil`; the
 * address of an account (registered over the API with TOTP) on a node in development mode on this computer finds the
 * node and reaches its login page. The account signs in on the node's own page in the sign-in window (password and
 * TOTP, app sessions of the connect flow), the main window picks up the session, sets up its recovery key (the
 * encryption core in the webview) and sends a message in an end-to-end encrypted channel, which the node stores as
 * ciphertext only. Then voice on Linux: media streams are on, and WebRTC is on whenever the system's WebKitGTK is
 * built with it; and the system-wide hotkeys: the recorders of Settings → Voice bind Ctrl+Alt+M to "mute" and the left
 * Ctrl alone to push-to-talk, the window is minimized and real key presses of the X server (xdotool) reach the client
 * through the shell's key listener (X RECORD, observed and never grabbed): Ctrl+Alt+M toggles mute and back, holding
 * the left Ctrl holds push-to-talk (its key lights up in the settings) until it is released.
 *
 * Keychain, tray and notifications: the first start runs without a keychain (`TAVRN_DESKTOP_KEYCHAIN=unavailable`, a
 * session without a Secret Service), so the key stays in IndexedDB and Settings → App warns. The app is then started
 * again with the keyring crate's in-memory mock store (`TAVRN_DESKTOP_KEYCHAIN=memory`; xvfb has no Secret Service):
 * the key moves into the keychain, the IndexedDB copy is removed, and a reload opens the store from the keychain
 * alone. The tray's state is read through the shell's `tray_status` command: the client reports "disconnected" after
 * sign-in, and the shell maps a state it is given to its icon and tooltip (voice itself needs WebRTC, which the
 * distributions' WebKitGTK lacks; the Playwright spec desktop-shell.spec.ts drives the tray with real voice).
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
 *
 * The node must serve its web client (the sign-in window shows its pages): a release build or the container image. A
 * debug tavrn-node reads `web/dist` from its build tree at run time and serves a placeholder once that tree is gone;
 * the test refuses such a node. The app always renders on the X display of xvfb-run: GTK is forced to X11 and
 * WAYLAND_DISPLAY is removed (WSLg sets it, and GTK would otherwise open the windows on the desktop). The app runs as a
 * single instance (a second start hands over to the first and exits), so the test waits for a quit app to be gone
 * before it starts it again, and refuses to start while another instance of the same binary runs.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appProcessPattern, childEnv, servesWebClient } from "./smoke-lib.mjs";

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
  const child = spawn(cmd, args, { env: childEnv(process.env, env), stdio: ["ignore", "pipe", "pipe"] });
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

async function wd(method, path, body, timeoutMs = 120_000) {
  const resp = await fetch(`${driver}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) }).catch((e) => {
    throw new Error(`${method} ${path}: ${e.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : e.message}`);
  });
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
/** Runs `body` (which ends by calling `done(value)`) in the page; failures come back as `{ error }`. */
const scriptAsync = (body, args = []) =>
  wd("POST", `/session/${session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1]; (async () => { ${body} })().then(done, (e) => done({ error: String(e) }));`,
    args,
  });
/** A command of the shell, called like the bundled client calls it. */
const shell = (cmd, args = {}) => scriptAsync("return await window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]);", [cmd, args]);
/** The account's record in the local key store (IndexedDB): is the local key persisted there, or in the keychain? */
const keyRecord = (account) =>
  scriptAsync(
    `return await new Promise((resolve, reject) => {
       const req = indexedDB.open("tavrn-crypto", 1);
       req.onerror = () => reject(req.error);
       req.onsuccess = () => {
         const get = req.result.transaction("accounts").objectStore("accounts").get(arguments[0]);
         get.onsuccess = () => resolve(get.result ? { hasKey: !!get.result.key, keychain: !!get.result.keychain } : null);
       };
     });`,
    [account],
  );
const goTo = (path) => script("history.pushState({}, '', arguments[0]); dispatchEvent(new PopStateEvent('popstate'));", [path]);

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
  const home = await (await fetch(`${nodeUrl}/`)).text();
  if (!servesWebClient(home)) fail(`the node at ${nodeUrl} serves no web client (a debug tavrn-node whose build tree with web/dist is gone?); use a release build or the container image`);
  step(`node at ${nodeUrl}`);

  // The first start has no keychain (a session without a Secret Service).
  await startApp("unavailable");
  step("app started (no keychain)");

  // An account with TOTP, registered over the API (another device of the same user).
  const username = `desk${randomBytes(4).toString("hex")}`;
  const password = `passwort-${username}-xyz`;
  const pre = await api("POST", "/auth/register", { username, password, device_name: "smoke" });
  const { secret } = await api("POST", "/auth/totp/enroll", {}, pre.preauth_token);
  const account = { secret, lastStep: 0 };
  const confirmed = await api("POST", "/auth/totp/confirm", { code: await nextCode(account) }, pre.preauth_token);
  const apiToken = confirmed.session.access_token;

  const address = await waitFor("input[name=address]", 60_000);
  step("node picker shown");

  // The shell's resolver (FEDERATION.md §1.4): a domain without any node.
  await type(address, "someone@nowhere.invalid");
  await click(await find("form button[type=submit]"));
  const notFound = await text(await waitFor("[data-testid=node-picker-error]", 60_000));
  if (!/nowhere\.invalid/.test(notFound)) throw new Error(`unexpected resolver error: ${notFound}`);
  step(`no node for nowhere.invalid: ${notFound}`);

  // The advanced node URL keeps refusing plain http to other hosts.
  await click(await find("[data-testid=node-picker-advanced]"));
  await type(await waitFor("input[name=node]"), "http://evil");
  await click(await find("form button[type=submit]"));
  const message = await until("the refusal", async () => {
    const t = await text(await find("[data-testid=node-picker-error]"));
    return /https/.test(t) ? t : null;
  });
  step(`http://evil refused: ${message}`);

  // Address first: the account's address on the development node finds the node and its login page.
  await script("location.reload()");
  const nodeHost = new URL(nodeUrl).port ? `localhost:${new URL(nodeUrl).port}` : "localhost";
  await type(await waitFor("input[name=address]", 30_000), `${username}@${nodeHost}`);
  await click(await find("form button[type=submit]"));
  const prefilled = await waitFor("input[name=username]", 30_000);
  const value = await wd("GET", `/session/${session}/element/${prefilled}/property/value`);
  if (value !== username) throw new Error(`the login page did not take the username: ${value}`);
  const node = await until("the node name", async () => {
    const t = await text(await find("[data-testid=node-name]"));
    return /\(localhost\)/.test(t) ? t : null;
  });
  step(`address ${username}@${nodeHost} → login page of ${node}`);

  // Sign-in on the node's own page: the sign-in window (no native API) shows the node's /connect page.
  const main = await wd("GET", `/session/${session}/window`);
  await click(await waitFor("[data-testid=node-page-signin]", 30_000));
  await waitFor("[data-testid=handoff-waiting]");
  const connectWindow = await until("the sign-in window", async () => (await wd("GET", `/session/${session}/window/handles`)).find((h) => h !== main), 30_000);
  await wd("POST", `/session/${session}/window`, { handle: connectWindow });
  const pageUrl = await wd("GET", `/session/${session}/url`);
  if (!pageUrl.startsWith(`http://${nodeHost}/`) && !pageUrl.startsWith(`${nodeUrl}/`)) throw new Error(`the sign-in window shows ${pageUrl}`);
  step(`sign-in window: ${pageUrl}`);
  // The page has no native API: a command from it is refused (or the IPC is not there at all).
  const refused = await script(
    "const ipc = window.__TAURI_INTERNALS__; return typeof ipc?.invoke === 'function' ? ipc.invoke('get_config').then(() => 'allowed', (e) => 'refused: ' + e) : 'absent';",
  );
  if (refused === "allowed") throw new Error("the node's page reached a native command");
  step(`native API from the node's page: ${refused}`);
  await type(await waitFor("input[name=username]", 60_000), username);
  await type(await find("input[name=password]"), password);
  await click(await find("form button[type=submit]"));
  await type(await waitFor("input[name=totp_code]", 30_000), await nextCode(account));
  await click(await find("form button[type=submit]"));
  await click(await waitFor("[data-testid=connect-allow]", 30_000));
  await waitFor("[data-testid=connect-done]", 30_000);
  step("signed in and confirmed on the node's page");

  // The app polls the code, exchanges it with its verifier and closes the window; encryption is set up in the app.
  await wd("POST", `/session/${session}/window`, { handle: main });
  await waitFor("[data-testid=recovery-key-words]", 60_000);
  await until("the sign-in window to close", async () => (await wd("GET", `/session/${session}/window/handles`)).length === 1, 30_000);
  step("the main window took over the session; the sign-in window closed");

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

  // ---- the keychain ----
  const accountAddress = `${username}@localhost`;
  const fallback = await keyRecord(accountAddress);
  if (!fallback?.hasKey || fallback.keychain) throw new Error(`without a keychain the key belongs in IndexedDB: ${JSON.stringify(fallback)}`);
  await goTo("/settings/app");
  await waitFor("[data-testid=app-keys-fallback]", 30_000);
  step("no keychain: the key stays in IndexedDB, Settings → App warns");

  // The tray: the client reported its voice state; the shell maps a state to its icon and tooltip.
  const tray = await until("the client's tray state", async () => {
    const s = await shell("tray_status");
    return s?.state === "disconnected" && s.tooltip === "Tavrn" ? s : null;
  });
  if (tray.close_to_tray !== true) throw new Error(`close to tray is on by default: ${JSON.stringify(tray)}`);
  const labels = { tooltip: "Tavrn · Lounge (Smoke) · Microphone muted", show: "Show Tavrn", hide: "Hide Tavrn", mute: "Mute microphone", deafen: "Deafen", leave: "Leave voice channel", quit: "Quit Tavrn" };
  const set = await shell("tray_set", { state: "muted", labels });
  if (set?.error) throw new Error(`tray_set: ${set.error}`);
  const muted = await shell("tray_status");
  if (muted.state !== "muted" || muted.tooltip !== labels.tooltip) throw new Error(`the tray did not take the state: ${JSON.stringify(muted)}`);
  step(`tray: client state "disconnected", then "muted" (tray icon ${tray.available ? "shown" : "not available on this display"})`);

  // Notifications: the shell shows valid ones (no notification server under xvfb: nothing visible) and refuses
  // paths outside the client.
  const shown = await shell("notify", { notice: { title: "Smoke", body: "A test notification", path: "/" } });
  if (shown?.error) throw new Error(`notify: ${shown.error}`);
  const foreignPath = await shell("notify", { notice: { title: "Smoke", body: "x", path: "https://evil.example/" } });
  if (!String(foreignPath?.error).includes("notify.invalid")) throw new Error(`notify accepted a foreign path: ${JSON.stringify(foreignPath)}`);
  step("notifications: shown through the shell, foreign paths refused");

  // Second start, now with a keychain: the key moves there and the IndexedDB copy goes.
  await restartApp("memory");
  await waitFor("[data-testid=app-shell]", 60_000);
  const status = await shell("keychain_status");
  if (status?.backend !== "memory" || !status.available) throw new Error(`keychain status: ${JSON.stringify(status)}`);
  const entry = await until("the keychain entry", async () => {
    const e = await shell("keychain_get", { account: accountAddress });
    return Array.isArray(e) && e.length === 32 ? e : null;
  });
  const migrated = await keyRecord(accountAddress);
  if (migrated?.hasKey || !migrated?.keychain) throw new Error(`the IndexedDB copy should be gone: ${JSON.stringify(migrated)}`);
  step(`keychain: the ${entry.length}-byte key moved from IndexedDB into the keychain`);

  // A reload opens the local key store from the keychain alone (no unlock prompt).
  await script("location.reload()");
  await sleep(1000);
  await waitFor("[data-testid=app-shell]", 60_000);
  await sleep(1500);
  const banners = await wd("POST", `/session/${session}/elements`, { using: "css selector", value: "[data-testid=e2ee-banner]" });
  if (banners.length) throw new Error("after the reload the local key store is locked");
  await goTo("/settings/app");
  const keys = await waitFor("[data-testid=app-keys][data-protection=keychain]", 30_000);
  step(`reload: unlocked from the keychain; Settings → App: ${(await text(keys)).slice(0, 60)}…`);

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

  // System-wide hotkeys: bound in Settings → Voice, pressed through the X server while the window is minimized.
  await script("history.pushState({}, '', '/settings/voice'); dispatchEvent(new PopStateEvent('popstate'));");
  // Clicks from the page itself: a WebDriver click goes to coordinates, which a layout change in between would miss.
  const press = async (css) => script("arguments[0].scrollIntoView({ block: 'center' }); arguments[0].click();", [{ [ELEMENT]: await waitFor(css, 30_000) }]);
  await press("[data-testid=hotkey-toggle_mute-change]");
  // The keys go in like typed input (WebKitWebDriver's keyboard does not reach the page under xvfb).
  const key = (type, init) => script(`window.dispatchEvent(new KeyboardEvent(arguments[0], { ...arguments[1], bubbles: true, cancelable: true }));`, [type, init]);
  await key("keydown", { code: "KeyM", key: "m", ctrlKey: true, altKey: true });
  await until("the bound combination", async () => (await text(await find("[data-testid=hotkey-toggle_mute-key]"))) === "Ctrl + Alt + M");
  step("Ctrl+Alt+M bound to mute through the shell");
  // Push-to-talk on the left Ctrl alone: recorded when it is released without another key.
  await press("[data-testid=mode-ptt]");
  await press("[data-testid=ptt-capture]");
  await key("keydown", { code: "ControlLeft", key: "Control", ctrlKey: true });
  await key("keyup", { code: "ControlLeft", key: "Control" });
  const pttBinding = () => script("return JSON.parse(localStorage.getItem('tavrn.voice.settings') || '{}').hotkeys?.push_to_talk;");
  await until("the push-to-talk binding", async () => (await pttBinding()) === "ControlLeft");
  step(`push-to-talk bound to the left Ctrl alone (${await text(await find("[data-testid=ptt-key]"))})`);
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
  const pttHeld = () => script("return document.querySelector('[data-testid=ptt-key]')?.getAttribute('data-held') === 'true';");
  execFileSync("xdotool", ["keydown", "Control_L"]);
  await until("push-to-talk held by the left Ctrl", pttHeld, 10_000);
  execFileSync("xdotool", ["keyup", "Control_L"]);
  await until("push-to-talk released with the left Ctrl", async () => !(await pttHeld()), 10_000);
  step(`a real press and release of the left Ctrl alone held and released push-to-talk${minimized ? " while the window was minimized" : ""}`);
}

/** Starts tauri-driver and the app with the keychain backend `keychain` (TAVRN_DESKTOP_KEYCHAIN). */
let driverProcess = null;
/** Pids of running instances of the app binary. */
function appPids() {
  try {
    return execFileSync("pgrep", ["-f", "-x", appProcessPattern(app)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function startApp(keychain) {
  // A running instance would take over the new start (single instance) and the session would never come up.
  if (appPids().length) throw new Error(`another instance of ${app} is running (pids ${appPids().join(", ")}); quit it first`);
  // The app's settings and web storage go to the scratch directory (a clean first start, kept for restarts).
  const xdg = { XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), XDG_CACHE_HOME: join(scratch, "cache") };
  for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true });
  driverProcess = start(driverBin, ["--port", String(driverPort), "--native-port", String(driverPort + 1)], { ...xdg, TAVRN_DESKTOP_KEYCHAIN: keychain });
  await until("tauri-driver", async () => (await fetch(`${driver}/status`)).ok);
  const created = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app } } } }, 90_000);
  session = created.sessionId;
}

/** Quits the app and starts it again (same settings and web storage) with another keychain backend. */
async function restartApp(keychain) {
  await wd("DELETE", `/session/${session}`).catch(() => undefined);
  session = null;
  // The quit app may take a moment to exit; until it has, a new start would only hand over to it (single instance).
  await until("the app to exit", async () => appPids().length === 0, 20_000).catch(() => {
    for (const pid of appPids()) process.kill(pid, "SIGKILL");
  });
  driverProcess?.kill("SIGTERM");
  await until("tauri-driver to stop", async () => {
    try {
      await fetch(`${driver}/status`);
      return false;
    } catch {
      return true;
    }
  });
  await sleep(500);
  await startApp(keychain);
  step(`app restarted (keychain: ${keychain})`);
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
