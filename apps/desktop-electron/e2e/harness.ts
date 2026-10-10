// SPDX-License-Identifier: Apache-2.0
/**
 * The shared settings of the Electron shell's Playwright specs (docs/DESKTOP.md "The Linux shell (Electron)"): the
 * paths, the node and its web client, the app's environment. The app itself is started by `launch.ts` (sandboxed, over
 * the DevTools protocol), always on the X display of `xvfb-run` (WAYLAND_DISPLAY is dropped and Chromium is told to use
 * X11, so no window ever opens on the desktop).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoDir = resolve(appDir, "../..");
// The main suite's helpers (e2e/tests/helpers.ts) read the same variables with other defaults: pin ours for every
// module that loads after this one (the config imports this file first, and the workers inherit the environment).
process.env.E2E_NODE_PORT ??= "8300";
process.env.E2E_WEB_PORT ??= "5300";
export const nodePort = Number(process.env.E2E_NODE_PORT);
export const nodeUrl = process.env.E2E_NODE_URL ?? `http://127.0.0.1:${nodePort}`;
/** The client's Vite dev server: the node names it as its web client, so the sign-in window shows this checkout's client. */
export const webPort = Number(process.env.E2E_WEB_PORT);
export const webOrigin = `http://localhost:${webPort}`;

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
