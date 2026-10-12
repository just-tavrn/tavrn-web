// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, loginViaUi, openNavIfMobile, registerViaUi, tokenOf } from "./helpers";
import { scaled } from "./timeouts";

// Sessions (PROTOCOL.md §5b): expired access tokens are refreshed once per node and shared across tabs, a refused
// token never logs out on its own, and a new login on the same browser continues the same device.

/** Ends every access token issued so far (development nodes only). */
async function expireAccessTokens(page: Page) {
  // Tokens carry whole seconds: make sure the current ones are older than the cut.
  await page.waitForTimeout(1100);
  const resp = await page.request.post(`${NODE}/api/v1/dev/expire-access-tokens`);
  expect(resp.status()).toBe(204);
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}") as { token: string | null; refresh: string | null; deviceId: string | null });

test.describe("Sessions", () => {
  test("expired access tokens: two tabs stay signed in, one refresh for both", async ({ context, page }) => {
    test.setTimeout(scaled(120_000));
    const account = await registerViaUi(page, { prefix: "tabs" });
    const second = await context.newPage();
    await second.goto("/settings/devices");
    await expect(second.getByTestId("app-shell")).toBeVisible();
    const before = await stored(page);

    await expireAccessTokens(page);
    const old = await page.request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${before.token}` } });
    expect(old.status()).toBe(401);
    expect((await old.json()).code).toBe("auth.token_expired");

    // Both tabs reload at the same time: the API calls and both WebSockets (4001) need a refresh at once.
    await Promise.all([page.reload(), second.reload()]);
    for (const p of [page, second]) {
      await expect(p.getByTestId("app-shell")).toBeVisible();
      await expect(p).not.toHaveURL(/\/login/);
    }
    await expect(second.getByTestId("device-list").locator("li")).toHaveCount(1);
    await expect.poll(async () => (await stored(page)).refresh).not.toBe(before.refresh);
    // Both tabs end with the same rotated pair: one refreshed, the other adopted it (Web Locks + storage event).
    // A refresh of the other tab may still be finishing: wait until both agree and stay on one token.
    await expect
      .poll(async () => {
        const [a, b] = [await stored(page), await stored(second)];
        return a.refresh !== null && a.refresh === b.refresh && a.refresh !== before.refresh;
      }, { timeout: 30_000 })
      .toBe(true);
    const after = await stored(page);
    expect(after.deviceId).toBe(before.deviceId);
    // The session survived (no reuse detection): the stored refresh token still works.
    const me = await page.request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
    expect(me.ok()).toBeTruthy();

    // The app keeps working without a reload: an expiry while open is refreshed on the next request.
    await expireAccessTokens(page);
    await page.goto("/settings/profile");
    await page.getByLabel("Anzeigename").fill("Nach dem Ablauf");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Profil gespeichert" })).toBeVisible();
    await openNavIfMobile(page);
    await expect(page.getByTestId("me-name")).toHaveText("Nach dem Ablauf");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    expect(account.username).toBeTruthy();
  });

  test("Network errors during the refresh do not sign out", async ({ page }) => {
    test.setTimeout(scaled(90_000));
    await registerViaUi(page, { prefix: "offline" });
    await expireAccessTokens(page);
    // The refresh route is unreachable for a while: requests fail, the session stays.
    let blocked = true;
    await page.route("**/api/v1/auth/refresh", (route) => (blocked ? route.abort("internetdisconnected") : route.continue()));
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page).not.toHaveURL(/\/login/);
    expect((await stored(page)).refresh).toBeTruthy();
    blocked = false;
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect.poll(async () => (await page.request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).status()).toBe(200);
  });

  test("signing in again in the same browser keeps the device", async ({ page }) => {
    test.setTimeout(scaled(150_000));
    const account = await registerViaUi(page, { prefix: "same" });
    const first = (await stored(page)).deviceId;
    for (let i = 0; i < 2; i++) {
      // The session is lost (e.g. signed out elsewhere) but this browser keeps its device keys.
      await page.evaluate(() => localStorage.removeItem("tavrn.auth"));
      await page.goto("/");
      await expect(page).toHaveURL(/\/login/);
      await loginViaUi(page, account);
      // The same device: the local keys open without the recovery key.
      await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
      expect((await stored(page)).deviceId).toBe(first);
    }
    await page.goto("/settings/devices");
    await expect(page.getByTestId("device-list").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("device-list").locator('[data-current="true"]')).toHaveCount(1);
    const keys = await (await page.request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json();
    expect(keys.devices).toHaveLength(1);
    expect(keys.devices[0].device_id).toBe(first);
  });
});
