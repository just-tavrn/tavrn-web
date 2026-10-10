// SPDX-License-Identifier: Apache-2.0
/**
 * The Playwright harness of the Electron shell (docs/DESKTOP.md "The Linux shell (Electron)", "Tests"): starts the app
 * through Playwright's Electron driver (no WebDriver) with a profile of its own, always on the X display of
 * `xvfb-run` (WAYLAND_DISPLAY is dropped and Chromium is told to use X11, so no window ever opens on the desktop).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoDir = resolve(appDir, "../..");
export const nodePort = Number(process.env.E2E_NODE_PORT ?? "8300");
export const nodeUrl = process.env.E2E_NODE_URL ?? `http://127.0.0.1:${nodePort}`;

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

/** Starts the app (the development build in `dist/`, the bundled client from `web/dist`) with a fresh profile. */
export async function launchApp(extra: Record<string, string> = {}): Promise<RunningApp> {
  if (!process.env.DISPLAY) throw new Error("no X display: run the test under xvfb-run -a (just electron-e2e)");
  const configHome = mkdtempSync(join(tmpdir(), "tavrn-electron-e2e-"));
  const executablePath = createRequire(import.meta.url)("electron") as unknown as string;
  const app = await _electron.launch({
    executablePath,
    args: [appDir, "--ozone-platform=x11"],
    cwd: appDir,
    env: appEnv(process.env, configHome, extra),
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
