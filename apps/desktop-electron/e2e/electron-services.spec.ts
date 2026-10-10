// SPDX-License-Identifier: Apache-2.0
/**
 * The keychain, notifications, the tray and downloads of the Electron shell (docs/DESKTOP.md "The Linux shell
 * (Electron)"), each through the bridge of the running app and the main process:
 *
 * - keychain: a key survives a restart of the app in the real keyring; it needs a Secret Service in the session (the
 *   recipe under `dbus-run-session` with an unlocked gnome-keyring, see DESKTOP.md), otherwise the test is skipped;
 * - notifications: xvfb has no notification server, so `Notification` is replaced in the main process by a recorder;
 *   its click runs the shell's real path (window to the front, out of the tray, `open` event to the page);
 * - tray: the client's voice state and texts reach the tray and its status; close to tray hides the window, the
 *   setting is persisted, Quit ends the app;
 * - downloads: with `TAVRN_DESKTOP_TEST_SAVE_DIR` a save goes into that directory without a dialog, byte for byte;
 *   "show in folder" asks for exactly that file (the file manager is replaced by a recorder); an `<a download>` of the
 *   page lands there too (the safety net).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { nodeUrl } from "./harness.ts";
import { startApp, type ElectronApp } from "./launch.ts";

/** The bridge as the page sees it (only what these tests call). */
type Bridge = {
  keychain: {
    keychainGet(a: string): Promise<Uint8Array | null>;
    keychainSet(a: string, s: Uint8Array): Promise<void>;
    keychainDelete(a: string): Promise<void>;
    keychainStatus(): Promise<{ backend: string; available: boolean }>;
  };
  notify: { notify(n: { title: string; body: string; path: string | null }): Promise<void> };
  tray: {
    traySet(state: string, labels: Record<string, string>): Promise<void>;
    trayStatus(): Promise<{ state: string; tooltip: string; available: boolean; close_to_tray: boolean }>;
    setCloseToTray(on: boolean): Promise<void>;
    quitApp(): Promise<void>;
  };
  files: {
    saveFileBegin(name: string, mime: string, size: number): Promise<{ status: string; id?: string }>;
    saveFileChunk(id: string, bytes: Uint8Array): Promise<void>;
    saveFileEnd(id: string): Promise<{ path: string; folder: string }>;
    saveFileReveal(id: string): Promise<void>;
  };
  events: { subscribe(fn: (e: unknown) => void): () => void };
};
declare global {
  interface Window {
    tavrnShell: Bridge;
    shellEvents?: unknown[];
  }
}

interface Running {
  app: ElectronApp;
  page: Page;
}

const homes: string[] = [];
let running: Running | null = null;

/** A profile with the development node already chosen (as after the node picker). */
function profile(): string {
  const home = mkdtempSync(join(tmpdir(), "tavrn-electron-services-"));
  homes.push(home);
  mkdirSync(join(home, "tavrn-desktop"), { recursive: true });
  writeFileSync(join(home, "tavrn-desktop", "settings.json"), JSON.stringify({ node: nodeUrl, web: null, domain: null }));
  return home;
}

/** Starts the app on `configHome` (a restart keeps it): sandboxed, over CDP, the main process through its inspector. */
async function start(configHome: string, extra: Record<string, string> = {}): Promise<Running> {
  const app = await startApp({ configHome, env: extra });
  const page = app.page;
  await page.waitForFunction(() => typeof window.tavrnShell?.keychain === "object");
  running = { app, page };
  return running;
}

async function stop(): Promise<void> {
  await running?.app.close().catch(() => undefined);
  running = null;
}

test.afterEach(async () => {
  await stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("keychain: a key survives a restart in the desktop's keyring, and the profile holds only ciphertext", async () => {
  const home = profile();
  const { page } = await start(home);
  const status = await page.evaluate(() => window.tavrnShell.keychain.keychainStatus());
  test.skip(
    status.backend !== "secret-service" || !status.available,
    `no Secret Service in this session (${JSON.stringify(status)}): run the recipe under dbus-run-session with an unlocked gnome-keyring (docs/DESKTOP.md)`,
  );
  const key = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
  await page.evaluate((k) => window.tavrnShell.keychain.keychainSet("alice@localhost", new Uint8Array(k)), key);
  expect(await page.evaluate(() => window.tavrnShell.keychain.keychainSet("alice@localhost", new Uint8Array(31)).then(() => "stored", (e: unknown) => e))).toBe("keychain.invalid");
  await stop();

  const file = readFileSync(join(home, "tavrn-desktop", "keychain.json"), "utf8");
  expect(file).toContain("local-key/http://127.0.0.1:");
  expect(file).not.toContain(Buffer.from(key).toString("base64"));
  const again = await start(home);
  expect(await again.page.evaluate(() => window.tavrnShell.keychain.keychainGet("Alice@localhost").then((v) => (v ? Array.from(v) : null)))).toEqual(key);
  await again.page.evaluate(() => window.tavrnShell.keychain.keychainDelete("alice@localhost"));
  expect(await again.page.evaluate(() => window.tavrnShell.keychain.keychainGet("alice@localhost"))).toBeNull();
});

test("notifications: a click brings the hidden window back and opens the notification's path in the page", async () => {
  const { app, page } = await start(profile());
  // No notification server under xvfb: record the notifications the shell creates instead of showing them.
  await app.evaluate(({ Notification }) => {
    const g = globalThis as unknown as { shown: Array<{ title: string; body: string; icon?: unknown; n: { emit(e: string): void } }> };
    g.shown = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function (this: { title: string; body: string }) {
      g.shown.push({ title: this.title, body: this.body, n: this as unknown as { emit(e: string): void } });
    };
  });
  await page.evaluate(() => {
    window.shellEvents = [];
    window.tavrnShell.events.subscribe((e) => window.shellEvents!.push(e));
  });
  await page.evaluate(() => window.tavrnShell.notify.notify({ title: "Alice in #general", body: "New message", path: "/settings" }));
  expect(await page.evaluate(() => window.tavrnShell.notify.notify({ title: "x", body: "y", path: "https://evil.example/" }).then(() => "shown", (e: unknown) => e))).toBe("notify.invalid");
  expect(await app.evaluate(() => (globalThis as unknown as { shown: Array<{ title: string; body: string }> }).shown.map(({ title, body }) => ({ title, body })))).toEqual([
    { title: "Alice in #general", body: "New message" },
  ]);

  // The window sits in the tray; the click brings it back and the page gets the path.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
  await app.evaluate(() => (globalThis as unknown as { shown: Array<{ n: { emit(e: string): void } }> }).shown[0]?.n.emit("click"));
  await expect.poll(() => page.evaluate(() => window.shellEvents)).toEqual([{ channel: "shell_events", event: { kind: "open", path: "/settings" } }]);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
});

test("tray: the client's voice state and texts reach the tray; close to tray hides the window; Quit ends the app", async () => {
  const home = profile();
  const { app, page } = await start(home);
  // The client settles on its login page first (leaving its app layout resets the tray to "disconnected").
  await expect(page.locator('input[name="username"]')).toBeVisible({ timeout: 30_000 });
  const labels = { tooltip: "tavrn · Lounge (Gaming) · Muted", show: "Show tavrn", hide: "Hide tavrn", mute: "Mute microphone", deafen: "Deafen", leave: "Leave voice channel", quit: "Quit tavrn" };
  await page.evaluate((l) => window.tavrnShell.tray.traySet("muted", l), labels);
  const status = await page.evaluate(() => window.tavrnShell.tray.trayStatus());
  expect(status).toEqual({ state: "muted", tooltip: labels.tooltip, available: true, close_to_tray: true });
  expect(await page.evaluate((l) => window.tavrnShell.tray.traySet("shouting", l).then(() => "set", (e: unknown) => e), labels)).toBe("ipc.invalid_arguments");
  expect(await page.evaluate((l) => window.tavrnShell.tray.traySet("connected", { ...l, mute: "" }).then(() => "set", (e: unknown) => e), labels)).toBe("tray.invalid");

  // Close to tray: closing the window hides it, the app keeps running.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
  await page.evaluate(() => window.tavrnShell.tray.setCloseToTray(false));
  expect(JSON.parse(readFileSync(join(home, "tavrn-desktop", "settings.json"), "utf8"))).toMatchObject({ node: nodeUrl, close_to_tray: false });
  expect((await page.evaluate(() => window.tavrnShell.tray.trayStatus())).close_to_tray).toBe(false);
  await page.evaluate(() => window.tavrnShell.tray.setCloseToTray(true));

  // Quit really ends the app, even with close to tray on.
  const exited = new Promise<void>((done) => app.process().once("exit", () => done()));
  await page.evaluate(() => void window.tavrnShell.tray.quitApp().catch(() => undefined));
  await exited;
  running = null;
});

test("downloads: a save goes into the test directory byte for byte, 'show in folder' names it, the page's own download is caught", async () => {
  const saveDir = mkdtempSync(join(tmpdir(), "tavrn-electron-saved-"));
  homes.push(saveDir);
  const { app, page } = await start(profile(), { TAVRN_DESKTOP_TEST_SAVE_DIR: saveDir });
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { revealed: string[] };
    g.revealed = [];
    shell.showItemInFolder = (path: string) => void g.revealed.push(path);
  });
  const size = 5 * 1024 * 1024 + 17;
  const done = await page.evaluate(async (size) => {
    const files = window.tavrnShell.files;
    const all = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
    const begin = await files.saveFileBegin("../report.bin", "application/octet-stream", all.byteLength);
    if (begin.status !== "ready" || !begin.id) return { begin };
    for (let at = 0; at < all.byteLength; at += 4 * 1024 * 1024) await files.saveFileChunk(begin.id, all.subarray(at, at + 4 * 1024 * 1024));
    const saved = await files.saveFileEnd(begin.id);
    await files.saveFileReveal(begin.id);
    return { begin, saved };
  }, size);
  const content = Buffer.alloc(size).map((_, i) => (i * 31) & 0xff);
  const target = join(saveDir, "report.bin");
  expect(done).toEqual({ begin: { status: "ready", id: "1" }, saved: { path: target, folder: saveDir.split("/").at(-1) } });
  expect(readFileSync(target).equals(content)).toBe(true);
  expect(await app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toEqual([target]);

  // The safety net: an <a download> of the page itself.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["from the page"], { type: "text/plain" }));
    a.download = "page.txt";
    document.body.append(a);
    a.click();
    a.remove();
  });
  await expect.poll(() => existsSync(join(saveDir, "page.txt")) && readFileSync(join(saveDir, "page.txt"), "utf8"), { timeout: 15_000 }).toBe("from the page");
});
