// SPDX-License-Identifier: Apache-2.0
/**
 * The client as the desktop app sees it (docs/DESKTOP.md), in Chromium and the phone emulation: the Tauri runtime is
 * simulated with an init script that answers the shell's commands (`web/src/platform/tauri.ts`), so the node picker,
 * the explicit node base and Settings → App run against the real node. The built app itself is covered by the
 * WebDriver smoke test (apps/desktop/e2e/smoke.mjs).
 */
import { expect, test, type Page } from "@playwright/test";
import { NODE, loginAs, registerViaApi } from "./helpers";

/** A fake shell: the chosen node lives in sessionStorage (survives reloads like the app's config file). */
async function asDesktopApp(page: Page, node: string | null = null) {
  await page.addInitScript((initial) => {
    const KEY = "e2e.desktop.node";
    if (initial && sessionStorage.getItem(KEY) === null) sessionStorage.setItem(KEY, initial);
    const w = window as unknown as Record<string, unknown>;
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { url?: string }) => {
        switch (cmd) {
          case "get_config":
            return { node: sessionStorage.getItem(KEY) };
          case "app_info":
            return { version: "0.2.0", updater: false };
          case "set_node": {
            const url = String(args.url);
            if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw "node_url.insecure";
            sessionStorage.setItem(KEY, url);
            return url;
          }
          case "open_external":
            return null;
        }
        throw `unknown command ${cmd}`;
      },
      transformCallback: () => 0,
    };
  }, node);
}

test.describe("Desktop app (simulated shell)", () => {
  test("first start: the node picker refuses http://evil, accepts the node and continues to its login page", async ({ page }) => {
    await asDesktopApp(page);
    await page.goto("/rooms/x/channels/y");
    await expect(page.getByRole("heading", { name: "Wähle deinen Heimatknoten" })).toBeVisible();
    const input = page.getByLabel("Adresse des Knotens", { exact: true });
    await input.fill("http://evil");
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page.getByTestId("node-picker-error")).toContainText("https");
    await input.fill(NODE);
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("node-name")).toHaveText(/tavrn \(localhost\)/);
    // Passkeys need the node's origin: the app offers password and second factor only.
    await expect(page.getByRole("button", { name: "Mit Passkey anmelden" })).toHaveCount(0);
    // The picker fits the phone width without horizontal scrolling.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("Settings → App: version, node and the way back to the picker", async ({ page, request }) => {
    const account = await registerViaApi(request, "desk");
    await asDesktopApp(page, NODE);
    await loginAs(page, account);
    await page.goto("/settings/app");
    await expect(page.getByTestId("app-version")).toHaveText("Version 0.2.0");
    await expect(page.getByTestId("app-node")).toHaveText(NODE);
    await expect(page.getByTestId("app-updates-unconfigured")).toBeVisible();
    await page.getByRole("link", { name: "Knoten wechseln" }).click();
    await expect(page).toHaveURL(/\/node$/);
    await expect(page.getByTestId("node-picker-current")).toContainText(NODE);
    await expect(page.getByTestId("node-picker-warning")).toBeVisible();
    await page.getByRole("link", { name: "Abbrechen" }).click();
    await expect(page).toHaveURL(/\/settings\/app$/);
  });

  test("the browser has neither the picker nor Settings → App", async ({ page, request }) => {
    const account = await registerViaApi(request, "web");
    await loginAs(page, account);
    await page.goto("/settings/profile");
    await expect(page.getByRole("link", { name: "App", exact: true })).toHaveCount(0);
  });
});
