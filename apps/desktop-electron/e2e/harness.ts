// SPDX-License-Identifier: Apache-2.0
/**
 * The Playwright harness of the Electron shell (docs/DESKTOP.md "The Linux shell (Electron)", "Tests"): starts the app
 * through Playwright's Electron driver (no WebDriver) with a profile of its own, always on the X display of
 * `xvfb-run` (WAYLAND_DISPLAY is dropped and Chromium is told to use X11, so no window ever opens on the desktop).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoDir = resolve(appDir, "../..");
export const nodePort = Number(process.env.E2E_NODE_PORT ?? "8300");
export const nodeUrl = process.env.E2E_NODE_URL ?? `http://127.0.0.1:${nodePort}`;
/** The client's Vite dev server: the node names it as its web client, so the sign-in window shows this checkout's client. */
export const webPort = Number(process.env.E2E_WEB_PORT ?? "5300");
export const webOrigin = `http://localhost:${webPort}`;
/** The packaged app (electron-builder's unpacked Linux build, or TAVRN_DESKTOP_APP). */
export const packagedApp = process.env.TAVRN_DESKTOP_APP ?? join(appDir, "release", "linux-unpacked", "tavrn");

/** Chromium's fake camera and microphone (instead of the Tauri shell's TAVRN_DESKTOP_FAKE_AUDIO). */
export const FAKE_MEDIA = ["--use-fake-device-for-media-stream"];

/**
 * The environment of the app: no Wayland (WSLg sets WAYLAND_DISPLAY; Chromium would open its window there), never run as
 * plain Node (some tools export ELECTRON_RUN_AS_NODE), the profile and the settings file in `configHome`.
 */
export function appEnv(base: NodeJS.ProcessEnv, configHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  delete env.WAYLAND_DISPLAY;
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, XDG_CONFIG_HOME: configHome, LANG: "en_US.UTF-8", LANGUAGE: "en", ...extra };
}

export interface RunningApp {
  app: ElectronApplication;
  window: Page;
  /** `$XDG_CONFIG_HOME` of this run: the settings file is `tavrn-desktop/settings.json` below it. */
  configHome: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  /** Settings to start with (`tavrn-desktop/settings.json`), e.g. a chosen node. */
  settings?: Record<string, unknown>;
  args?: string[];
}

/** A fresh `$XDG_CONFIG_HOME`, with the settings file when given. */
function profile(settings?: Record<string, unknown>): string {
  const configHome = mkdtempSync(join(tmpdir(), "tavrn-electron-e2e-"));
  if (settings) {
    mkdirSync(join(configHome, "tavrn-desktop"), { recursive: true });
    writeFileSync(join(configHome, "tavrn-desktop", "settings.json"), JSON.stringify(settings));
  }
  return configHome;
}

/** Starts the app (the development build in `dist/`, the bundled client from `web/dist`) with a fresh profile. */
export async function launchApp(options: LaunchOptions = {}): Promise<RunningApp> {
  if (!process.env.DISPLAY) throw new Error("no X display: run the test under xvfb-run -a (just electron-e2e)");
  const configHome = profile(options.settings);
  const executablePath = createRequire(import.meta.url)("electron") as unknown as string;
  const app = await _electron.launch({
    executablePath,
    args: [appDir, "--ozone-platform=x11", ...(options.args ?? [])],
    cwd: appDir,
    env: appEnv(process.env, configHome, options.env),
  });
  const window = await app.firstWindow();
  return {
    app,
    window,
    configHome,
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

export interface RunningPackage {
  browser: Browser;
  page: Page;
  configHome: string;
  process: ChildProcess;
  output: string[];
  close(): Promise<void>;
}

/**
 * Starts the packaged app and drives it over the Chrome DevTools Protocol: the package's fuses switch off Node's
 * `--inspect` (which Playwright's Electron driver needs), so the harness asks Chromium for a debugging port on 127.0.0.1
 * (a random one, `--remote-debugging-port=0`) and connects to it.
 */
export async function launchPackaged(options: LaunchOptions = {}): Promise<RunningPackage> {
  if (!process.env.DISPLAY) throw new Error("no X display: run the test under xvfb-run -a (just electron-e2e)");
  if (!existsSync(packagedApp)) throw new Error(`no packaged app at ${packagedApp} (just electron-package, or set TAVRN_DESKTOP_APP)`);
  const configHome = profile(options.settings);
  const child = spawn(packagedApp, ["--ozone-platform=x11", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", ...(options.args ?? [])], {
    env: appEnv(process.env, configHome, options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no DevTools endpoint from the packaged app:\n${output.join("")}`)), 30_000);
    const scan = (d: Buffer) => {
      output.push(String(d));
      const m = output.join("").match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("exit", (code) => reject(new Error(`the packaged app exited (${code}):\n${output.join("")}`)));
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await (async () => {
    for (let i = 0; i < 100; i++) {
      const found = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("app://tavrn/"));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the packaged app shows no window of app://tavrn");
  })();
  return {
    browser,
    page,
    configHome,
    process: child,
    output,
    close: async () => {
      await browser.close().catch(() => undefined);
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}
