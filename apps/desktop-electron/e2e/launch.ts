// SPDX-License-Identifier: Apache-2.0
/**
 * Starts the app for the full smoke test (`electron-smoke.spec.ts`), sandboxed, and drives it over the DevTools
 * protocol: the app gets `--remote-debugging-port=0` (Chromium picks a free port on 127.0.0.1 and prints it) and
 * Playwright attaches with `connectOverCDP`. Playwright's own Electron driver is not used: it switches Chromium's
 * sandbox off on the command line, and the packages keep Electron's fuse `enableNodeCliInspectArguments` off, so it
 * could not attach to them anyway. Only the pages are reachable, never the main process.
 *
 * - **the development build** (`dist/`, the default): the Electron binary of `node_modules` with this directory;
 * - **a package** (`E2E_ELECTRON_APP`): the `.AppImage` (run with `APPIMAGE_EXTRACT_AND_RUN=1`: CI has no FUSE) or the
 *   unpacked `linux-unpacked/tavrn`.
 *
 * Both get the harness's environment (no Wayland, never as plain Node, a fresh `XDG_CONFIG_HOME`), X11 forced and the
 * caller's Chromium switches (the fake microphone and camera). The sandbox always stays on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appDir, appEnv } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The package under test (`E2E_ELECTRON_APP`), or null for the development build. */
export function packagedApp(): string | null {
  const app = process.env.E2E_ELECTRON_APP?.trim();
  return app ? resolve(app) : null;
}

export interface SmokeApp {
  /** "dev": the development build in `dist/`; "packaged": a package. */
  mode: "dev" | "packaged";
  /** The main window's page (the bundled client). */
  page: Page;
  configHome: string;
  /** The app's open windows (pages). */
  windows(): Page[];
  /** The next window the app opens (the sign-in window, the screen-share picker), null after `timeoutMs`. */
  nextWindow(timeoutMs: number): Promise<Page | null>;
  /** Starts the app a second time with the same profile (it hands over to the running one and exits): its exit code. */
  secondStart(): Promise<number | null>;
  /** Waits until the app has exited. */
  exited(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** The command line of the app: the package, or Electron with this directory; X11 and the caller's switches. */
function command(extraArgs: string[]): { file: string; args: string[]; mode: "dev" | "packaged" } {
  const packaged = packagedApp();
  if (packaged) {
    if (!existsSync(packaged)) throw new Error(`E2E_ELECTRON_APP: no such file ${packaged}`);
    return { file: packaged, args: ["--ozone-platform=x11", ...extraArgs], mode: "packaged" };
  }
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  return { file: electron, args: [appDir, "--ozone-platform=x11", ...extraArgs], mode: "dev" };
}

/** Starts the app with a fresh profile; `extraArgs` are Chromium switches (the fake media devices). */
export async function startSmokeApp(extraArgs: string[], extraEnv: Record<string, string> = {}): Promise<SmokeApp> {
  if (!process.env.DISPLAY) throw new Error("no X display: run the test under xvfb-run -a (just electron-e2e)");
  if (extraArgs.some((a) => a.includes("sandbox"))) throw new Error("the app always runs sandboxed");
  const configHome = mkdtempSync(join(tmpdir(), "tavrn-electron-smoke-"));
  const { file, args, mode } = command(extraArgs);
  // The AppImage runs without FUSE (extracted into a temporary directory first).
  const env = appEnv(process.env, configHome, { APPIMAGE_EXTRACT_AND_RUN: "1", ...extraEnv });

  // A process group of its own: an AppImage's runtime starts Electron as its child, and the group is ended as a whole.
  const child = spawn(file, [...args, "--remote-debugging-port=0"], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const log: string[] = [];
  let endpoint: string | null = null;
  const read = (d: Buffer) => {
    log.push(String(d));
    endpoint ??= /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(log.join(""))?.[1] ?? null;
  };
  child.stdout!.on("data", read);
  child.stderr!.on("data", read);
  for (let i = 0; i < 240 && !endpoint; i++) {
    if (ended(child)) throw new Error(`the app exited (${child.exitCode ?? child.signalCode}) before it opened its window:\n${log.join("").slice(-3000)}`);
    await sleep(250);
  }
  if (!endpoint) throw new Error(`no DevTools endpoint after 60 s:\n${log.join("").slice(-3000)}`);
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  const context: BrowserContext = browser.contexts()[0]!;
  const isMain = (p: Page) => p.url().startsWith("app://tavrn/");
  let page = context.pages().find(isMain);
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(250);
    page = context.pages().find(isMain);
  }
  if (!page) throw new Error(`the main window did not show the bundled client: ${context.pages().map((p) => p.url()).join(", ")}`);
  return {
    mode,
    page,
    configHome,
    windows: () => context.pages(),
    nextWindow: (timeoutMs) => context.waitForEvent("page", { timeout: timeoutMs }).catch(() => null),
    secondStart: () => waitExit(spawn(file, args, { cwd: appDir, env, stdio: "ignore" }), 60_000),
    exited: async (timeoutMs) => (await waitExit(child, timeoutMs)) !== null,
    close: async () => {
      await browser.close().catch(() => undefined);
      const group = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, signal);
        } catch {
          /* already gone */
        }
      };
      group("SIGTERM");
      if ((await waitExit(child, 10_000)) === null) group("SIGKILL");
      // Electron's processes may outlive an AppImage's runtime: a last sweep of the group.
      await sleep(500);
      group("SIGKILL");
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** The exit code of `child` once it ended (-1 for a signal), null when it still runs after `timeoutMs`. */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (ended(child)) return Promise.resolve(child.exitCode ?? -1);
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
  });
}
