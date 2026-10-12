// SPDX-License-Identifier: Apache-2.0
/**
 * The one way the Playwright specs start the app (docs/DESKTOP.md "Builds and releases (Electron)"): always sandboxed,
 * always driven over the DevTools protocol. The app gets `--remote-debugging-port=0` on 127.0.0.1 (Chromium picks a
 * free port and prints it) and Playwright attaches with `connectOverCDP`. Playwright's own Electron driver is not used:
 * it switches Chromium's sandbox off on the command line, and the packages keep Electron's fuse
 * `enableNodeCliInspectArguments` off, so it could not attach to them anyway.
 *
 * - **the development build** (`dist/` with the Electron binary of `node_modules`, the default): also `--inspect=0`, and
 *   the specs reach the main process through Node's inspector ({@link ElectronApp.evaluate}, the counterpart of
 *   Playwright's `electronApp.evaluate`: the function gets the `electron` module and one argument);
 * - **a package** (`packaged`): the `.AppImage` (run with `APPIMAGE_EXTRACT_AND_RUN=1`: CI has no FUSE) or the unpacked
 *   `linux-unpacked/tavrn`; only its pages are reachable.
 *
 * Every run gets the harness's environment (no Wayland, never as plain Node unless a test asks for it, its own
 * `XDG_CONFIG_HOME`), X11 forced and the caller's Chromium switches. The sandbox always stays on, and the app gets a
 * process group of its own (an AppImage's runtime starts Electron as its child), ended as a whole.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { scaled } from "../../../e2e/tests/timeouts.ts";
import { appDir, appEnv } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The package the specs test when they test one: E2E_ELECTRON_APP, TAVRN_DESKTOP_APP or electron-builder's unpacked build. */
export const packagedApp = resolve(process.env.E2E_ELECTRON_APP?.trim() || process.env.TAVRN_DESKTOP_APP?.trim() || join(appDir, "release", "linux-unpacked", "tavrn"));
/** Whether the full smoke test runs against a package (E2E_ELECTRON_APP set) instead of the development build. */
export const smokePackaged = !!process.env.E2E_ELECTRON_APP?.trim();

type ElectronModule = typeof import("electron");

export interface StartOptions {
  /** Chromium switches (the fake media devices, …); never one that touches the sandbox. */
  args?: string[];
  env?: Record<string, string>;
  /** Settings to start with (`tavrn-desktop/settings.json`), e.g. a chosen node. */
  settings?: Record<string, unknown>;
  /** An existing `$XDG_CONFIG_HOME` (a restart keeps the profile); the caller removes it. */
  configHome?: string;
  /** A package to start instead of the development build. */
  packaged?: string;
}

export interface ElectronApp {
  /** "dev": the development build in `dist/`; "packaged": a package. */
  mode: "dev" | "packaged";
  /** The main window's page (the bundled client). */
  page: Page;
  /** `$XDG_CONFIG_HOME` of this run: the settings file is `tavrn-desktop/settings.json` below it. */
  configHome: string;
  /** What the app printed (stdout and stderr). */
  output: string[];
  process(): ChildProcess;
  /** The app's open windows (pages). */
  windows(): Page[];
  /** The next window the app opens (the sign-in window, the screen-share picker); throws after `timeoutMs`. */
  waitForWindow(timeoutMs?: number): Promise<Page>;
  /** The same, null after `timeoutMs`. */
  nextWindow(timeoutMs: number): Promise<Page | null>;
  /** Runs `fn(electron, arg)` in the main process (development build only) and answers its JSON value. */
  evaluate<R, A = undefined>(fn: (electron: ElectronModule, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  /** Starts the app a second time with the same profile (it hands over to the running one and exits): its exit code. */
  secondStart(): Promise<number | null>;
  /** Waits until the app has exited. */
  exited(timeoutMs: number): Promise<boolean>;
  /** Quits the app (`app.quit()` when the main process is reachable, else SIGTERM) and ends its process group. */
  quit(): Promise<void>;
  /** Quits and removes the profile (unless the caller passed its own). */
  close(): Promise<void>;
}

/** A fresh `$XDG_CONFIG_HOME`, with the settings file when given. */
export function freshProfile(settings?: Record<string, unknown>): string {
  const configHome = mkdtempSync(join(tmpdir(), "tavrn-electron-e2e-"));
  if (settings) {
    mkdirSync(join(configHome, "tavrn-desktop"), { recursive: true });
    writeFileSync(join(configHome, "tavrn-desktop", "settings.json"), JSON.stringify(settings));
  }
  return configHome;
}

/** An answer of the inspector to `Runtime.evaluate`. */
type EvaluateReply = { result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } } };

/** A minimal client of Node's inspector protocol: `Runtime.evaluate` in the main process. */
class Inspector {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, (reply: EvaluateReply) => void>();
  #id = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (m) => {
      const reply = JSON.parse(String(m.data)) as EvaluateReply & { id?: number };
      if (reply.id === undefined) return;
      this.#pending.get(reply.id)?.(reply);
      this.#pending.delete(reply.id);
    });
  }

  static async connect(url: string): Promise<Inspector> {
    const ws = new WebSocket(url);
    await new Promise<void>((done, fail) => {
      ws.addEventListener("open", () => done(), { once: true });
      ws.addEventListener("error", () => fail(new Error(`no connection to the main process's inspector at ${url}`)), { once: true });
    });
    return new Inspector(ws);
  }

  async evaluate(expression: string): Promise<unknown> {
    const id = ++this.#id;
    const reply = await new Promise<EvaluateReply>((done) => {
      this.#pending.set(id, done);
      // includeCommandLineAPI: the inspector's `require` (the main process is an ES module without one).
      this.#ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }));
    });
    const failed = reply.result?.exceptionDetails;
    if (failed) throw new Error(`main process: ${failed.exception?.description ?? failed.text ?? "evaluation failed"}`);
    return reply.result?.result?.value;
  }

  close(): void {
    this.#ws.close();
  }
}

/** Starts the app (the development build, or `options.packaged`) and attaches to it. */
export async function startApp(options: StartOptions = {}): Promise<ElectronApp> {
  if (!process.env.DISPLAY) throw new Error("no X display: run the test under xvfb-run -a (just electron-e2e)");
  const extra = options.args ?? [];
  if (extra.some((a) => a.includes("sandbox"))) throw new Error("the app always runs sandboxed");
  const ownProfile = !options.configHome;
  const configHome = options.configHome ?? freshProfile(options.settings);
  const packaged = options.packaged ?? null;
  if (packaged && !existsSync(packaged)) throw new Error(`no package at ${packaged} (just electron-package)`);
  const mode = packaged ? "packaged" : "dev";
  const file = packaged ?? (createRequire(import.meta.url)("electron") as unknown as string);
  const args = [...(packaged ? [] : [appDir]), "--ozone-platform=x11", ...extra];
  // A package refuses remote debugging unless told it runs under these specs (src/main/hardening.ts).
  const env = appEnv(process.env, configHome, { APPIMAGE_EXTRACT_AND_RUN: "1", TAVRN_DESKTOP_ALLOW_DEBUGGING: "1", ...(options.env ?? {}) });

  const debug = ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", ...(packaged ? [] : ["--inspect=0"])];
  const child = spawn(file, [...args, ...debug], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const output: string[] = [];
  let inspector: Inspector | null = null;
  const read = (d: Buffer) => {
    output.push(String(d));
    // Node keeps an exiting process alive while a debugger is attached: let go once it says so.
    if (String(d).includes("Waiting for the debugger to disconnect")) inspector?.close();
  };
  child.stdout!.on("data", read);
  child.stderr!.on("data", read);
  const found = (re: RegExp) => re.exec(output.join(""))?.[1] ?? null;
  let endpoint: string | null = null;
  let inspectorUrl: string | null = null;
  // The endpoints this app printed (its own output only: a previous app's lines can never be taken).
  const started = scaled(60_000);
  for (const until = Date.now() + started; Date.now() < until && !(endpoint && (packaged || inspectorUrl)); ) {
    if (ended(child)) throw new Error(`the app exited (${child.exitCode ?? child.signalCode}) before it opened its window:\n${output.join("").slice(-3000)}`);
    endpoint ??= found(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
    inspectorUrl ??= found(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
    if (!(endpoint && (packaged || inspectorUrl))) await sleep(250);
  }
  if (!endpoint) throw new Error(`no DevTools endpoint after ${started / 1000} s:\n${output.join("").slice(-3000)}`);
  inspector = !packaged && inspectorUrl ? await Inspector.connect(inspectorUrl) : null;
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  // Playwright takes over the downloads of a browser it connects to; the app's own handling (the save dialog, the test
  // hook's directory) must stay in charge.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  const context: BrowserContext = browser.contexts()[0]!;
  const isMain = (p: Page) => p.url().startsWith("app://tavrn/");
  let page = context.pages().find(isMain);
  for (const until = Date.now() + scaled(30_000); !page && Date.now() < until; ) {
    await sleep(250);
    page = context.pages().find(isMain);
  }
  if (!page) throw new Error(`the main window did not show the bundled client: ${context.pages().map((p) => p.url()).join(", ")}`);

  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      /* already gone */
    }
  };
  const evaluate = async <R, A>(fn: (electron: ElectronModule, arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
    if (!inspector) throw new Error("the main process is reachable in the development build only (the packages keep --inspect off)");
    return (await inspector.evaluate(`(async () => { const fn = (${fn.toString()}); return await fn(require("electron"), ${JSON.stringify(arg ?? null)}); })()`)) as R;
  };
  // Fully awaited: when it returns, no process of this app is left (the next test starts on a clean slate). Also right
  // for an app that already exited by itself (Quit in the tray): the connections are closed and the group is swept.
  const quit = async () => {
    await browser.close().catch(() => undefined);
    if (!ended(child) && inspector) await inspector.evaluate(`require("electron").app.quit()`).catch(() => undefined);
    inspector?.close();
    if (!ended(child)) {
      if ((await waitExit(child, inspector ? scaled(10_000) : 0)) === null) group("SIGTERM");
      if ((await waitExit(child, scaled(10_000))) === null) group("SIGKILL");
    }
    // Electron's processes (zygote, GPU, renderers) may outlive the main process or an AppImage's runtime: end the
    // group and wait until it is gone.
    group("SIGKILL");
    if (!(await groupGone(child.pid!, scaled(10_000)))) throw new Error(`processes of the app's group ${child.pid} survived SIGKILL`);
  };
  return {
    mode,
    page,
    configHome,
    output,
    process: () => child,
    windows: () => context.pages(),
    waitForWindow: (timeoutMs = scaled(30_000)) => context.waitForEvent("page", { timeout: timeoutMs }),
    nextWindow: (timeoutMs) => context.waitForEvent("page", { timeout: timeoutMs }).catch(() => null),
    evaluate,
    secondStart: () => waitExit(spawn(file, args, { cwd: appDir, env, stdio: "ignore" }), scaled(60_000)),
    exited: async (timeoutMs) => (await waitExit(child, timeoutMs)) !== null,
    quit,
    close: async () => {
      await quit();
      if (ownProfile) rmSync(configHome, { recursive: true, force: true });
    },
  };
}

const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Whether no process of the group `pgid` is left within `timeoutMs` (signal 0 only asks). */
async function groupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  for (const until = Date.now() + timeoutMs; ; await sleep(50)) {
    try {
      process.kill(-pgid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() >= until) return false;
  }
}

/** The exit code of `child` once it ended (-1 for a signal), null when it still runs after `timeoutMs`. */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (ended(child)) return Promise.resolve(child.exitCode ?? -1);
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
  });
}

/**
 * Chooses `source` in the shell's screen-share picker (`src/main/picker.ts`), which closes its window the moment a source
 * is chosen: Playwright's click can then end with "Target page, context or browser has been closed" although it landed.
 * Done means the picker closed; any other failure of the click still fails.
 */
export async function chooseInPicker(picker: Page, source: Locator): Promise<void> {
  const closed = picker.waitForEvent("close");
  closed.catch(() => undefined);
  await source.click().catch((e: unknown) => {
    if (!picker.isClosed()) throw e;
  });
  await closed;
}
