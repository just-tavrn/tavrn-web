// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, addVirtualAuthenticator, createRoomViaApi, loginAs, loginViaApi, openNavIfMobile, registerViaApi, registerViaUi } from "./helpers";
import { scaled } from "./timeouts";

test.describe("User settings", () => {
  test("Switching the language localizes the interface and the default channels", async ({ page, request }) => {
    const account = await registerViaApi(request, "lang");
    const room = await createRoomViaApi(request, account.token, "Sprach-Raum");
    await loginAs(page, account);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Benutzereinstellungen" }).click();
    await page.getByRole("link", { name: "Sprache" }).click();
    await page.getByTestId("locale-switch").selectOption("en");
    await expect(page.getByRole("heading", { name: "User settings" })).toBeVisible();
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("general");
    await openNavIfMobile(page);
    await expect(page.getByRole("link", { name: "Voice" })).toBeVisible();
  });

  test("Change the display name and password, manage devices", async ({ page, request }) => {
    const account = await registerViaApi(request, "sett");
    await loginViaApi(request, account, "Zweitgerät");
    await loginAs(page, account);
    await page.goto("/settings/profile");
    await expect(page.getByTestId("address-field")).toBeDisabled();
    await expect(page.getByTestId("address-field")).toHaveValue(`${account.username}@localhost`);
    await page.getByLabel("Anzeigename").fill("Neuer Name");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Profil gespeichert" })).toBeVisible();
    await openNavIfMobile(page);
    await expect(page.getByTestId("me-name")).toHaveText("Neuer Name");

    await page.goto("/settings/devices");
    const list = page.getByTestId("device-list");
    await expect(list.locator("li")).toHaveCount(2);
    await expect(list.locator('[data-current="true"]')).toContainText("dieses Gerät");
    // Removing a device needs a fresh confirmation (sudo mode, PROTOCOL.md §5c): this session has none.
    await page.getByRole("button", { name: "Zweitgerät entfernen" }).click();
    const reauth = page.getByTestId("reauth-dialog");
    await expect(reauth).toContainText("Diese Änderung braucht eine frische Bestätigung");
    await reauth.getByTestId("reauth-password").fill("falsch-falsch-1");
    await reauth.getByTestId("reauth-submit").click();
    await expect(reauth.getByRole("alert")).toBeVisible();
    await reauth.getByTestId("reauth-password").fill(account.password);
    await reauth.getByTestId("reauth-submit").click();
    await expect(reauth).toHaveCount(0);
    await expect(list.locator("li")).toHaveCount(1);

    await page.goto("/settings/security");
    await page.getByLabel("Aktuelles Passwort").fill(account.password);
    await page.getByLabel("Neues Passwort").fill("ganz-neues-passwort-1");
    await page.getByLabel("Passwort wiederholen").fill("ganz-neues-passwort-2");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("alert")).toContainText("stimmen nicht überein");
    await page.getByLabel("Passwort wiederholen").fill("ganz-neues-passwort-1");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Passwort geändert" })).toBeVisible();
    const login = await request.post(`${NODE}/api/v1/auth/login`, { data: { username: account.username, password: "ganz-neues-passwort-1" } });
    expect(login.ok()).toBeTruthy();
  });

  test("A passkey confirms security-relevant changes after a reload", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "CDP virtual authenticator is Chromium only");
    test.setTimeout(scaled(120_000));
    await addVirtualAuthenticator(page);
    const account = await registerViaUi(page, { prefix: "sudo" });
    // The login's confirmation lives in memory only: after the page load the first passkey needs the password.
    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Erster");
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    const first = page.getByTestId("reauth-dialog");
    await expect(first.getByTestId("reauth-passkey")).toHaveCount(0); // no passkey yet
    await first.getByTestId("reauth-password").fill(account.password);
    await first.getByTestId("reauth-submit").click();
    await expect(page.getByTestId("passkey-list").locator("li").filter({ hasText: "Erster" })).toBeVisible();
    await expect(page.getByTestId("reauth-dialog")).toHaveCount(0);

    // After a reload the confirmation is gone (memory only): removing a device asks again, the passkey confirms.
    await loginViaApi(request, { ...account, token: "", refresh: "", userId: "", isNodeAdmin: false, deviceId: "" }, "Altgerät");
    await page.goto("/settings/devices");
    const list = page.getByTestId("device-list");
    await expect(list.locator("li")).toHaveCount(2);
    await page.getByRole("button", { name: "Altgerät entfernen" }).click();
    const reauth = page.getByTestId("reauth-dialog");
    await expect(reauth.getByTestId("reauth-password")).toBeVisible();
    await reauth.getByTestId("reauth-passkey").click();
    await expect(reauth).toHaveCount(0);
    await expect(list.locator("li")).toHaveCount(1);

    // Within the same five minutes (no reload) the next sensitive change needs no second confirmation.
    await page.getByRole("link", { name: "Sicherheit" }).click();
    await page.getByRole("button", { name: "Erster entfernen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Entfernen" }).click();
    await expect(page.getByTestId("passkey-list")).toContainText("Noch keine Passkeys");
    await expect(page.getByTestId("reauth-dialog")).toHaveCount(0);
  });
});
