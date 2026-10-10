// SPDX-License-Identifier: Apache-2.0
// The built desktop app under WebDriver (tauri-driver, WebKitWebDriver) for specs that need a browser participant and
// the app in one call (desktop-voice.spec.ts). Plain WebDriver over HTTP (no client library); the app runs
// on the X display of xvfb-run (`just desktop-voice-e2e` forces GTK to X11 and removes WAYLAND_DISPLAY, the display
// rule of docs/DESKTOP.md "Tests"), with its settings and web storage in a temporary directory.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

export interface DesktopOptions {
  app: string;
  driver?: string;
  port: number;
  env?: Record<string, string>;
}

/** One running app with its tauri-driver and WebDriver session. */
export class DesktopApp {
  session = "";
  private readonly children: ChildProcess[] = [];
  private readonly scratch = mkdtempSync(join(tmpdir(), "tavrn-desktop-voice-"));
  readonly log: string[] = [];

  constructor(private readonly opts: DesktopOptions) {}

  private get base() {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  async wd<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const json = (await resp.json().catch(() => ({}))) as { value?: T };
    if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${JSON.stringify(json.value ?? json)}`);
    return json.value as T;
  }

  async start(): Promise<void> {
    const xdg = { XDG_CONFIG_HOME: join(this.scratch, "config"), XDG_DATA_HOME: join(this.scratch, "data"), XDG_CACHE_HOME: join(this.scratch, "cache") };
    for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, ...xdg, ...this.opts.env, GDK_BACKEND: "x11" };
    delete env.WAYLAND_DISPLAY;
    const driver = spawn(this.opts.driver ?? "tauri-driver", ["--port", String(this.opts.port), "--native-port", String(this.opts.port + 1)], { env, stdio: ["ignore", "pipe", "pipe"] });
    driver.stdout?.on("data", (d) => this.log.push(String(d)));
    driver.stderr?.on("data", (d) => this.log.push(String(d)));
    this.children.push(driver);
    await until("tauri-driver", async () => (await fetch(`${this.base}/status`)).ok);
    const created = await this.wd<{ sessionId: string }>("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: this.opts.app } } } }, 90_000);
    this.session = created.sessionId;
  }

  async stop(): Promise<void> {
    if (this.session) await this.wd("DELETE", `/session/${this.session}`).catch(() => undefined);
    this.session = "";
    for (const c of this.children.reverse()) c.kill("SIGTERM");
    await sleep(500);
    rmSync(this.scratch, { recursive: true, force: true });
  }

  find = async (css: string): Promise<string> => (await this.wd<Record<string, string>>("POST", `/session/${this.session}/element`, { using: "css selector", value: css }))[ELEMENT]!;
  waitFor = (css: string, timeoutMs?: number) => until(`element ${css}`, () => this.find(css), timeoutMs);
  text = (id: string) => this.wd<string>("GET", `/session/${this.session}/element/${id}/text`);
  click = (id: string) => this.wd("POST", `/session/${this.session}/element/${id}/click`, {});
  async type(id: string, value: string) {
    await this.wd("POST", `/session/${this.session}/element/${id}/clear`, {});
    await this.wd("POST", `/session/${this.session}/element/${id}/value`, { text: value });
  }
  script = <T = unknown>(body: string, args: unknown[] = []) => this.wd<T>("POST", `/session/${this.session}/execute/sync`, { script: body, args });
  /** Clicks from the page itself (a WebDriver click goes to coordinates, which a layout change would miss). */
  press = async (css: string) => this.script("arguments[0].scrollIntoView({ block: 'center' }); arguments[0].click();", [{ [ELEMENT]: await this.waitFor(css, 30_000) }]);
  goTo = (path: string) => this.script("history.pushState({}, '', arguments[0]); dispatchEvent(new PopStateEvent('popstate'));", [path]);
  window = () => this.wd<string>("GET", `/session/${this.session}/window`);
  handles = () => this.wd<string[]>("GET", `/session/${this.session}/window/handles`);
  switchTo = (handle: string) => this.wd("POST", `/session/${this.session}/window`, { handle });
  async screenshot(): Promise<Buffer | null> {
    try {
      return Buffer.from(await this.wd<string>("GET", `/session/${this.session}/screenshot`), "base64");
    } catch {
      return null;
    }
  }

  /**
   * Signs `username` (registered with TOTP) in as in the desktop smoke test: the address on the node picker, the node's
   * own page in the sign-in window (password, TOTP, allow), the main window takes the session and sets up the
   * recovery key; resolves once the app shell shows.
   */
  async signIn(nodeUrl: string, account: { username: string; password: string }, code: () => Promise<string>): Promise<void> {
    const nodeHost = `localhost:${new URL(nodeUrl).port}`;
    await this.type(await this.waitFor("input[name=address]", 60_000), `${account.username}@${nodeHost}`);
    await this.click(await this.find("form button[type=submit]"));
    await this.waitFor("input[name=username]", 30_000);
    const main = await this.window();
    await this.click(await this.waitFor("[data-testid=node-page-signin]", 30_000));
    await this.waitFor("[data-testid=handoff-waiting]");
    const connect = await until("the sign-in window", async () => (await this.handles()).find((h) => h !== main), 30_000);
    await this.switchTo(connect);
    await this.type(await this.waitFor("input[name=username]", 60_000), account.username);
    await this.type(await this.find("input[name=password]"), account.password);
    await this.click(await this.find("form button[type=submit]"));
    await this.type(await this.waitFor("input[name=totp_code]", 30_000), await code());
    await this.click(await this.find("form button[type=submit]"));
    await this.click(await this.waitFor("[data-testid=connect-allow]", 30_000));
    await this.waitFor("[data-testid=connect-done]", 30_000);
    await this.switchTo(main);
    await this.waitFor("[data-testid=recovery-key-words]", 60_000);
    await this.press("input[type=checkbox]");
    await this.script("document.evaluate(\"//input[@type='checkbox']/ancestor::label/following-sibling::button[1]\", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.click();");
    await this.waitFor("[data-testid=app-shell]", 60_000);
  }
}
