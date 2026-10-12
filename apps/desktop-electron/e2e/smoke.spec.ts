// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test of the Electron shell (docs/DESKTOP.md "The Linux shell (Electron)", "Tests"): the bundled client on
 * `app://tavrn` with the bridge and nothing of Node; the node picker (the shell's resolver, the advanced URL, address
 * first); signing in with password and TOTP in the app and on the node's page in the sign-in window, whose page signs its
 * own session out after the handoff; the microphone and camera without a prompt and screen sharing through the shell's
 * picker; the packaged app once, with its fuses. Every start is sandboxed and driven over CDP (`launch.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FAKE_MEDIA, nodePort, nodeUrl, webOrigin } from "./harness.ts";
import { chooseInPicker, packagedApp, startApp, type ElectronApp } from "./launch.ts";
import { devices, nextCode, registerAccount, type Account } from "./node-api.ts";

let run: ElectronApp | null = null;
let pkg: ElectronApp | null = null;

test.afterEach(async () => {
  await run?.close();
  await pkg?.close();
  run = null;
  pkg = null;
});

/** The chosen node, as the picker stores it after address first (its web client is the dev server). */
const chosen = { node: nodeUrl, web: webOrigin, domain: "localhost" };

type ShellWindow = Window & { tavrnShell: { shell: { setNode(url: string): Promise<unknown>; appInfo(): Promise<unknown> } } };

async function bridgeSurface(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { tavrnShell?: { kind: string; window: string; shell: object } };
    return {
      kind: w.tavrnShell?.kind,
      window: w.tavrnShell?.window,
      shell: Object.keys(w.tavrnShell?.shell ?? {}).sort(),
      namespaces: Object.keys(w.tavrnShell ?? {}).sort(),
      node: typeof w.require + typeof w.process + typeof w.module + typeof w.ipcRenderer,
      secure: window.isSecureContext,
      origin: location.origin,
    };
  });
}

const expectedSurface = {
  kind: "electron",
  window: "main",
  shell: ["appInfo", "closeConnect", "getConfig", "openConnect", "openExternal", "resolveNode", "setNode", "takeLinks"],
  namespaces: ["events", "files", "games", "hotkeys", "keychain", "kind", "notify", "passkeys", "shell", "tray", "updater", "window"],
  node: "undefinedundefinedundefinedundefined",
  secure: true,
  origin: "app://tavrn",
};

async function signInWithTotp(page: Page, account: Account): Promise<void> {
  await page.locator('input[name="username"]').fill(account.username);
  await page.locator('input[name="password"]').fill(account.password);
  await page.locator('input[name="password"]').press("Enter");
  const code = page.locator('input[name="totp_code"]');
  await code.fill(await nextCode(account));
  await code.press("Enter");
}

test("the node picker: the shell's resolver, the advanced URL and address first", async ({}, testInfo) => {
  const account = await registerAccount();
  run = await startApp();
  const { page, configHome } = run;
  await expect(page).toHaveURL(/^app:\/\/tavrn\//);
  await expect(page).toHaveTitle("tavrn");
  expect(await bridgeSurface(page)).toEqual(expectedSurface);
  // The policy of the bundled client: no inline scripts (Playwright's own evaluation is exempt, a page's script is not).
  expect(
    await page.evaluate(
      () =>
        new Promise<string>((done) => {
          document.addEventListener("securitypolicyviolation", (e) => done(e.violatedDirective), { once: true });
          const s = document.createElement("script");
          s.textContent = "document.title = 'inline ran'";
          document.head.append(s);
          setTimeout(() => done(document.title), 2000);
        }),
    ),
  ).toBe("script-src-elem");
  // The shell refuses with the Tauri shell's codes.
  expect(await page.evaluate(() => (window as unknown as ShellWindow).tavrnShell.shell.setNode("http://evil").then(() => "resolved", (e: unknown) => e))).toBe("node_url.insecure");

  // A domain without any node: the shell's resolver names it.
  const address = page.locator('input[name="address"]');
  await address.fill("someone@nowhere.invalid");
  await address.press("Enter");
  await expect(page.getByTestId("node-picker-error")).toContainText("nowhere.invalid", { timeout: 30_000 });

  // The advanced node URL refuses plain http to another computer.
  await page.getByTestId("node-picker-advanced").click();
  const url = page.locator('input[name="node"]');
  await url.fill("http://evil");
  await url.press("Enter");
  await expect(page.getByTestId("node-picker-error")).toContainText("https");

  // Address first: the account's address on the development node finds the node and its login page.
  await page.reload();
  await page.locator('input[name="address"]').fill(`${account.username}@localhost:${nodePort}`);
  await page.locator('input[name="address"]').press("Enter");
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/, { timeout: 30_000 });
  await expect(page.locator('input[name="username"]')).toHaveValue(account.username);
  await expect(page.getByTestId("node-name")).toContainText("(localhost)");
  const settings = JSON.parse(readFileSync(join(configHome, "tavrn-desktop", "settings.json"), "utf8")) as Record<string, unknown>;
  expect(settings).toEqual({ node: expect.stringMatching(new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${nodePort}$`)), web: webOrigin, domain: "localhost" });
  await page.screenshot({ path: testInfo.outputPath("login.png") });
});

test("contacts no host but this computer at the first start (no dictionary downloads)", async ({}, testInfo) => {
  // Chromium's own log of every request and host lookup of the app's browser process (the sandbox stays on).
  const log = testInfo.outputPath("net-log.json");
  run = await startApp({ args: [`--log-net-log=${log}`] });
  await expect(run.page).toHaveURL(/^app:\/\/tavrn\//);
  await expect(run.page.locator('input[name="address"]')).toBeVisible();
  // The spellchecker would fetch its dictionaries within the first seconds.
  await run.page.waitForTimeout(8000);
  await run.close();
  run = null;
  const text = readFileSync(log, "utf8");
  const hosts = new Set<string>();
  for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([^/"\\:]+)/gi)) hosts.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/"host":"([^"\\:]+)/gi)) hosts.add(m[1]!.toLowerCase());
  const foreign = [...hosts].filter((h) => !["localhost", "127.0.0.1", "[::1]", "::1"].includes(h));
  expect(foreign).toEqual([]);
});

test("signs in with password and TOTP in the app, without a browser", async () => {
  const account = await registerAccount();
  run = await startApp({ settings: chosen });
  const page = run.page;
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/, { timeout: 30_000 });
  await signInWithTotp(page, account);
  // Signed in: the encryption is set up in the app (the recovery key comes from the WebAssembly core).
  await expect(page.getByTestId("recovery-key-words")).toBeVisible({ timeout: 60_000 });
});

test("signs in on the node's page in the sign-in window, which signs its own session out", async ({}, testInfo) => {
  const account = await registerAccount();
  run = await startApp({ settings: chosen });
  const { page } = run;
  const app = run;
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/, { timeout: 30_000 });
  const opened = app.waitForWindow();
  await page.getByTestId("node-page-signin").click();
  await expect(page.getByTestId("handoff-waiting")).toBeVisible();
  const signIn = await opened;
  expect(signIn.url()).toMatch(new RegExp(`^${webOrigin}/connect\\?session=[A-Za-z0-9_-]{43}`));
  // The page there has no bridge, and knows the sign-in window by the user agent's marker.
  expect(await signIn.evaluate(() => [typeof (window as unknown as { tavrnShell?: unknown }).tavrnShell, typeof (window as unknown as { require?: unknown }).require, /TavrnDesktopSignIn\/1/.test(navigator.userAgent)])).toEqual([
    "undefined",
    "undefined",
    true,
  ]);
  await signInWithTotp(signIn, account);
  await signIn.getByTestId("connect-allow").click({ timeout: 30_000 });
  await expect(signIn.getByTestId("connect-done")).toBeVisible({ timeout: 30_000 });
  await signIn.screenshot({ path: testInfo.outputPath("sign-in-window.png") });
  // The app takes over its own session; the window closes a few seconds later.
  await expect(page.getByTestId("recovery-key-words")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBe(1);
  // The page signed its session out after the handoff: the registration's device and the app's, no orphan of the page.
  await expect.poll(async () => (await devices(account)).length, { timeout: 30_000 }).toBe(2);
});

/** Starts getDisplayMedia in the page; the result lands in `window.__share`. */
async function startShare(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __share: Promise<unknown> }).__share = navigator.mediaDevices.getDisplayMedia({ video: true }).then(
      (s) => ({ kind: s.getVideoTracks()[0]?.kind, live: s.getVideoTracks()[0]?.readyState, stop: s.getTracks().forEach((t) => t.stop()) }),
      (e: Error) => e.name,
    );
  });
}

async function picker(app: ElectronApp, page: Page): Promise<Page> {
  const next = app.waitForWindow();
  await startShare(page);
  return next;
}

test("the microphone and camera without a prompt; screen sharing through the shell's picker", async () => {
  run = await startApp({ args: FAKE_MEDIA });
  const { page } = run;
  const app = run;
  await expect(page).toHaveURL(/^app:\/\/tavrn\//);
  const media = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const kinds = stream.getTracks().map((t) => t.kind).sort();
    stream.getTracks().forEach((t) => t.stop());
    return { kinds, pc: typeof RTCPeerConnection };
  });
  expect(media).toEqual({ kinds: ["audio", "video"], pc: "function" });
  // Other permissions stay denied.
  expect(await page.evaluate(() => Notification.requestPermission())).toBe("denied");

  // The picker lists the screens (and windows of other programs), keyboard first: the first source has the focus.
  const first = await picker(app, page);
  await expect(first.locator("h1")).toHaveText("Share your screen");
  const screen = first.locator('button.source[data-kind="screen"]').first();
  await expect(screen).toBeVisible();
  await expect(screen).toBeFocused();
  expect(await first.evaluate(() => [typeof (window as unknown as { tavrnShell?: unknown }).tavrnShell, typeof (window as unknown as { require?: unknown }).require])).toEqual(["undefined", "undefined"]);
  // The picker meets WCAG 2.2 AA (axe; legacy mode: an Electron app opens no extra page for the results).
  const axe = await new AxeBuilder({ page: first }).setLegacyMode().withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await chooseInPicker(first, screen);
  expect(await page.evaluate(() => (window as unknown as { __share: Promise<unknown> }).__share)).toMatchObject({ kind: "video", live: "live" });

  // Escape cancels: the page is refused (Electron rejects with AbortError, which the client takes as a closed picker).
  const second = await picker(app, page);
  await expect(second.locator('button.source[data-kind="screen"]').first()).toBeFocused();
  // The picker closes on the key going down, so the key's release finds no page any more.
  await Promise.all([second.waitForEvent("close"), second.keyboard.press("Escape").catch(() => undefined)]);
  expect(await page.evaluate(() => (window as unknown as { __share: Promise<unknown> }).__share)).toBe("AbortError");
});

test("the packaged app over CDP: its fuses, the bundled client and the node picker", async () => {
  test.skip(!existsSync(packagedApp), `no packaged app at ${packagedApp} (just electron-package)`);
  // ELECTRON_RUN_AS_NODE and --inspect are switched off by the fuses: the app starts as the app, without a debugger.
  pkg = await startApp({ packaged: packagedApp, env: { ELECTRON_RUN_AS_NODE: "1" }, args: ["--inspect=0"] });
  const { page, output } = pkg;
  await expect(page).toHaveURL(/^app:\/\/tavrn\//);
  expect(await bridgeSurface(page)).toEqual(expectedSurface);
  expect(output.join("")).not.toMatch(/Debugger listening/);
  await page.getByTestId("node-picker-advanced").click();
  await page.locator('input[name="node"]').fill(nodeUrl);
  await page.locator('input[name="node"]').press("Enter");
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as ShellWindow).tavrnShell.shell.appInfo())).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+/), updater: true });
});
