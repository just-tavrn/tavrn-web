// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, adminAccount, confirmRecoveryCodes, confirmRecoveryKey, enrollTotpInUi, loginAs, openNavIfMobile, registerViaApi, uniqueName } from "./helpers";

test.describe("Node administration", () => {
  test("Overview, account invite, suspending a user and ban", async ({ page, request }) => {
    const admin = await adminAccount(request);
    expect(admin.isNodeAdmin).toBeTruthy();
    const victim = await registerViaApi(request, "victim");
    await loginAs(page, admin);
    await page.goto("/");
    // The node administration lives in the account menu (and at the top of the settings navigation).
    await openNavIfMobile(page);
    await page.getByTestId("presence-menu-button").click();
    await page.getByTestId("presence-menu").getByRole("menuitem", { name: "Knotenverwaltung" }).click();
    await expect(page.getByRole("heading", { name: "Knotenverwaltung" })).toBeVisible();
    await page.goto("/settings/profile");
    await expect(page.getByTestId("settings-admin-link")).toHaveAttribute("href", "/admin");
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Knotenverwaltung" })).toBeVisible();
    await expect(page.getByTestId("admin-stats")).toContainText("Nutzer");

    await page.getByRole("link", { name: "Einladungen" }).click();
    const note = `Test ${uniqueName("")}`;
    await page.getByLabel("Notiz").fill(note);
    await page.getByRole("button", { name: "Einladung erzeugen" }).click();
    const item = page.getByTestId("account-invite-list").locator("li").filter({ hasText: note });
    await expect(item).toBeVisible();
    const link = await item.locator("code").textContent();
    expect(link).toMatch(/\/login\?invite=/);
    const code = link!.split("invite=")[1]!;
    const check = await request.get(`${NODE}/api/v1/account-invites/${code}`);
    expect(check.ok()).toBeTruthy();

    await page.getByRole("link", { name: "Nutzer" }).click();
    await page.getByLabel("Nutzer suchen").fill(victim.username);
    const row = page.getByTestId("admin-user-list").locator("li").filter({ hasText: victim.username });
    await row.getByRole("button", { name: "Sperren" }).click();
    await expect(row).toContainText("gesperrt");
    const me = await request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${victim.token}` } });
    expect(me.status()).toBe(401);
    await row.getByRole("button", { name: "Entsperren" }).click();
    await expect(row).not.toContainText("gesperrt");

    await page.getByRole("link", { name: "Bans" }).click();
    // Unique per run: the projects share one node and run in parallel.
    const banned = `${uniqueName("boese")}.example`;
    await page.getByLabel("Ban-Ziel").fill(banned);
    await page.getByRole("button", { name: "Bannen" }).click();
    const banRow = page.getByTestId("admin-ban-list").locator("li").filter({ hasText: banned });
    await expect(banRow).toBeVisible();
    await banRow.getByRole("button", { name: "Aufheben" }).click();
    await expect(page.getByTestId("admin-ban-list")).not.toContainText(banned);

    await page.getByRole("link", { name: "Audit-Log" }).click();
    await expect(page.getByTestId("admin-audit-list")).toContainText("admin.ban");
  });

  test("Reset the second factor of a locked-out user; the user sets it up again", async ({ browser, page, request }) => {
    test.setTimeout(90_000);
    const admin = await adminAccount(request);
    const victim = await registerViaApi(request, "locked");
    await loginAs(page, admin);
    await page.goto("/admin/users");
    await page.getByLabel("Nutzer suchen").fill(victim.username);
    const row = page.getByTestId("admin-user-list").locator("li").filter({ hasText: victim.username });
    await row.getByRole("button", { name: "Zweiten Faktor zurücksetzen" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`${victim.username}@localhost`);
    await dialog.getByLabel("Bestätigung").fill(victim.username);
    await dialog.getByRole("button", { name: "Zweiten Faktor zurücksetzen" }).click();
    await expect(row.getByTestId("reset-2fa-audit")).toContainText(`admin.second_factor_reset → ${victim.username}@localhost`);
    // All sessions of the user were revoked.
    const refresh = await request.post(`${NODE}/api/v1/auth/refresh`, { data: { refresh_token: victim.refresh } });
    expect(refresh.status()).toBe(401);
    await page.getByRole("link", { name: "Audit-Log" }).click();
    await expect(page.getByTestId("admin-audit-list")).toContainText("admin.second_factor_reset");

    // The user signs in and enrolls a new factor.
    const ctx = await browser.newContext({ ...test.info().project.use });
    const userPage = await ctx.newPage();
    await userPage.goto("/login");
    await userPage.getByLabel("Benutzername", { exact: true }).fill(victim.username);
    await userPage.getByLabel("Passwort", { exact: true }).fill(victim.password);
    await userPage.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(userPage.getByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeVisible();
    await enrollTotpInUi(userPage);
    await confirmRecoveryCodes(userPage);
    await confirmRecoveryKey(userPage);
    await expect(userPage.getByTestId("app-shell")).toBeVisible();
    await ctx.close();
  });

  test("Regular users do not see the node administration", async ({ page, request }) => {
    await adminAccount(request); // ensures the first account (bootstrap admin) is not the test user
    const user = await registerViaApi(request, "plain");
    expect(user.isNodeAdmin).toBeFalsy();
    await loginAs(page, user);
    await page.goto("/admin");
    await expect(page).not.toHaveURL(/\/admin/);
    await openNavIfMobile(page);
    await page.getByTestId("presence-menu-button").click();
    await expect(page.getByTestId("presence-menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Knotenverwaltung" })).toHaveCount(0);
    await page.goto("/settings/profile");
    await expect(page.getByTestId("settings-admin-link")).toHaveCount(0);
  });

  test("Forgot-password page and invalid reset link", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Passwort vergessen?" }).click();
    await page.getByLabel("Benutzername oder E-Mail").fill("niemand");
    await page.getByRole("button", { name: "Link senden" }).click();
    await expect(page.getByRole("status")).toContainText("unterwegs");
    await page.goto("/reset-password?token=kaputt");
    await page.getByLabel("Neues Passwort").fill("ganz-neues-passwort-1");
    await page.getByLabel("Passwort wiederholen").fill("ganz-neues-passwort-1");
    await page.getByRole("button", { name: "Passwort setzen" }).click();
    await expect(page.getByRole("alert")).toContainText(/ungültig|abgelaufen/);
  });
});
