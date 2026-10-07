// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, adminAccount, createRoomViaApi, loginAs, registerViaApi, uniqueName } from "./helpers";

// Entitlements and admin API tokens (design note 4.13 item 1) and the room's attachment retention (item 2).
test.describe("Quotas and admin API tokens", () => {
  test("Create a plan, grant it with an expiry, edit and delete the grant", async ({ page, request }) => {
    test.setTimeout(90_000);
    const admin = await adminAccount(request);
    const user = await registerViaApi(request, "abo");
    await loginAs(page, admin);
    await page.goto("/admin/entitlements");
    await expect(page.getByRole("heading", { name: "Pläne" })).toBeVisible();

    // A plan with one limit.
    const plan = uniqueName("gold");
    const planForm = page.getByLabel("Name des Plans").locator("xpath=ancestor::form");
    await page.getByLabel("Name des Plans").fill(plan);
    await planForm.getByLabel("Grenze hinzufügen …").selectOption("rooms.max_owned");
    await planForm.getByLabel(/Eigene Räume/).fill("20");
    await planForm.getByRole("button", { name: "Plan anlegen" }).click();
    const planRow = page.getByTestId("plan-list").locator("li").filter({ hasText: plan });
    await expect(planRow).toContainText("Eigene Räume: 20");

    // A grant of the plan plus an override, valid for a year.
    const grantForm = page.getByTestId("grant-create");
    await grantForm.getByLabel("Empfänger").fill(`user:${user.username}`);
    await grantForm.getByLabel("Plan").selectOption({ label: plan });
    await grantForm.getByLabel("Grenze hinzufügen …").selectOption("emoji.max_personal");
    await grantForm.getByLabel(/Persönliche Emojis/).fill("50");
    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const local = `${nextYear.getFullYear()}-${String(nextYear.getMonth() + 1).padStart(2, "0")}-${String(nextYear.getDate()).padStart(2, "0")}T12:00`;
    await grantForm.getByLabel("Läuft ab").fill(local);
    await grantForm.getByLabel("Notiz").fill("Abo E2E");
    await grantForm.getByRole("button", { name: "Freigabe anlegen" }).click();
    await page.getByLabel("Nach Empfänger filtern").fill(`user:${user.username}`);
    await page.getByRole("button", { name: "Filtern", exact: true }).click();
    const grantRow = page.getByTestId("grant-list").locator("li").filter({ hasText: `${user.username}@localhost` });
    await expect(grantRow).toContainText(plan);
    await expect(grantRow).toContainText("Persönliche Emojis: 50");
    await expect(grantRow).toContainText("Abo E2E");
    await expect(grantRow).toContainText("bis ");

    // The node applies it.
    const effective = await request.get(`${NODE}/api/v1/admin/entitlements/effective?user=${user.username}`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const values = (await effective.json()).values;
    expect(values["rooms.max_owned"]).toBe(20);
    expect(values["emoji.max_personal"]).toBe(50);
    await page.getByLabel("Nutzer", { exact: true }).fill(user.username);
    await page.getByRole("button", { name: "Anzeigen" }).click();
    await expect(page.getByTestId("effective-values")).toContainText("Eigene Räume");

    // Edit: remove the expiry, change the note.
    await grantRow.getByRole("button", { name: "Bearbeiten" }).click();
    const editor = page.getByTestId("grant-editor");
    await editor.getByLabel("Läuft ab").fill("");
    await editor.getByLabel("Notiz").fill("Abo E2E verlängert");
    await editor.getByRole("button", { name: "Speichern" }).click();
    const updated = page.getByTestId("grant-list").locator("li").filter({ hasText: "Abo E2E verlängert" });
    await expect(updated).toContainText("ohne Ablauf");

    // A plan in use cannot be deleted; after the grant is gone it can.
    await planRow.getByRole("button", { name: "Löschen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Löschen" }).click();
    await expect(page.getByRole("dialog")).toContainText("Freigaben");
    await page.getByRole("dialog").getByRole("button", { name: "Abbrechen" }).click();
    await updated.getByRole("button", { name: "Löschen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Löschen" }).click();
    await expect(page.getByTestId("grant-list")).not.toContainText("Abo E2E verlängert");
    await planRow.getByRole("button", { name: "Löschen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Löschen" }).click();
    await expect(page.getByTestId("plan-list")).not.toContainText(plan);

    await page.goto("/admin/audit");
    await expect(page.getByTestId("admin-audit-list")).toContainText("entitlements.grant_delete");
  });

  test("Create an API token, see the secret once, use it for admin routes only, revoke it", async ({ page, request }) => {
    test.setTimeout(90_000);
    const admin = await adminAccount(request);
    await loginAs(page, admin);
    await page.goto("/admin/tokens");
    const name = uniqueName("billing");
    await page.getByLabel("Name des Tokens").fill(name);
    await page.getByRole("checkbox", { name: /users:read/ }).check();
    await page.getByRole("button", { name: "Token erzeugen" }).click();
    const secret = (await page.getByTestId("admin-token-secret-value").textContent())!.trim();
    expect(secret).toMatch(/^tavrn_adm_[0-9A-Z]{26}\./);

    const auth = { Authorization: `Bearer ${secret}` };
    expect((await request.get(`${NODE}/api/v1/admin/entitlements/plans`, { headers: auth })).status()).toBe(200);
    expect((await request.get(`${NODE}/api/v1/admin/users?limit=1`, { headers: auth })).status()).toBe(200);
    expect((await request.get(`${NODE}/api/v1/admin/overview`, { headers: auth })).status()).toBe(403);
    expect((await request.get(`${NODE}/api/v1/users/me`, { headers: auth })).status()).toBe(401);

    // The secret is shown once: gone after "Done" and after a reload; the list shows the last use.
    await page.getByRole("button", { name: "Fertig" }).click();
    await expect(page.getByTestId("admin-token-secret")).toHaveCount(0);
    await page.reload();
    const row = page.getByTestId("admin-token-list").locator("li").filter({ hasText: name });
    await expect(row).toContainText("users:read");
    await expect(row).toContainText("zuletzt benutzt");
    await expect(page.locator("body")).not.toContainText(secret.split(".")[1]!);

    await row.getByRole("button", { name: "Widerrufen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Widerrufen" }).click();
    await expect(page.getByTestId("admin-token-list")).not.toContainText(name);
    expect((await request.get(`${NODE}/api/v1/admin/entitlements/plans`, { headers: auth })).status()).toBe(401);
  });

  test("Room setting: delete attachments after N days", async ({ page, request }) => {
    const owner = await registerViaApi(request, "retention");
    const room = await createRoomViaApi(request, owner.token, "Aufbewahrung");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/overview`);
    await expect(page.getByRole("heading", { name: "Aufbewahrung von Anhängen" })).toBeVisible();
    await expect(page.getByTestId("retention-effective")).toHaveText("Anhänge werden behalten.");
    await page.getByTestId("retention-days").fill("14");
    await page.getByTestId("retention-days").locator("xpath=ancestor::form").getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByTestId("retention-effective")).toHaveText("Anhänge werden nach 14 Tagen gelöscht.");
    const detail = await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect((await detail.json()).attachment_retention_days).toBe(14);
  });
});
