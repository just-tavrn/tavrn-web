// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test of the Electron shell: the app starts on the bundled client (`app://tavrn`), the page has the bridge and
 * nothing of Node or Electron, the node picker refuses plain http to another computer, takes the development node's
 * URL (plain http on this computer), the shell stores it, and the app continues on the node's login page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, nodeUrl, type RunningApp } from "./harness.ts";

let run: RunningApp | null = null;

test.afterEach(async () => {
  await run?.close();
  run = null;
});

test("starts on the node picker and reaches the login page of a development node", async ({}, testInfo) => {
  run = await launchApp();
  const { window: page, configHome } = run;
  await expect(page).toHaveURL(/^app:\/\/tavrn\//);
  await expect(page).toHaveTitle("tavrn");

  // The page sees the bridge of the main window and nothing else of the shell.
  const surface = await page.evaluate(() => {
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
  expect(surface).toEqual({
    kind: "electron",
    window: "main",
    shell: ["appInfo", "closeConnect", "getConfig", "openConnect", "openExternal", "resolveNode", "setNode"],
    namespaces: ["events", "files", "hotkeys", "keychain", "kind", "notify", "shell", "tray", "updater", "window"],
    node: "undefinedundefinedundefinedundefined",
    secure: true,
    origin: "app://tavrn",
  });
  // The policy of the bundled client: no inline scripts (Playwright's own evaluation is exempt, a page's script is not).
  // A part of the shell that is not there yet says so.
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
  expect(await page.evaluate(() => (window as unknown as { tavrnShell: { keychain: { keychainStatus(): Promise<unknown> } } }).tavrnShell.keychain.keychainStatus().then(() => "resolved", (e: Error) => e.message))).toBe(
    "not implemented: keychainStatus",
  );
  expect(await page.evaluate(() => (window as unknown as { tavrnShell: { shell: { setNode(u: string): Promise<unknown> } } }).tavrnShell.shell.setNode("http://evil").then(() => "resolved", (e: unknown) => e))).toBe("node_url.insecure");

  // The node picker: address first; the advanced URL refuses plain http to another computer.
  await expect(page.locator('input[name="address"]')).toBeVisible();
  await page.getByTestId("node-picker-advanced").click();
  const url = page.locator('input[name="node"]');
  await url.fill("http://evil");
  await url.press("Enter");
  await expect(page.getByTestId("node-picker-error")).toBeVisible();
  await url.fill(nodeUrl);
  await url.press("Enter");

  // The shell stored the node; the client starts over on its login page.
  await expect(page).toHaveURL("app://tavrn/login", { timeout: 30_000 });
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  const settings = JSON.parse(readFileSync(join(configHome, "tavrn-desktop", "settings.json"), "utf8")) as Record<string, unknown>;
  // The web origin is what the node's document names (a development node: `http://localhost:<port>`).
  expect(settings).toEqual({ node: nodeUrl, web: expect.stringMatching(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/), domain: "localhost" });
  await page.screenshot({ path: testInfo.outputPath("login.png") });
});
