// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, addVirtualAuthenticator, confirmRecoveryKey, confirmWithPassword, loginViaUi, nextTotpCode, registerViaUi, tokenOf } from "./helpers";
import { scaled } from "./timeouts";

test.describe("Security settings", () => {
  test("Factors, passkey with a name, protection of the last factor, codes and recovery key", async ({ browser, page, request, browserName }) => {
    test.skip(browserName !== "chromium", "adding a passkey needs the CDP virtual authenticator");
    test.setTimeout(scaled(120_000));
    await addVirtualAuthenticator(page);
    const account = await registerViaUi(page);
    await page.goto("/settings/security");
    const totpRow = page.getByTestId("totp-row");
    await expect(totpRow).toContainText("Aktiv");
    await expect(page.getByTestId("codes-left")).toHaveText("Noch 10 Codes übrig");
    await expect(page.getByTestId("passkey-list")).toContainText("Noch keine Passkeys");
    await expect(page.getByTestId("security-address")).toHaveText(account.address);

    // The only factor cannot be removed.
    await totpRow.getByRole("button", { name: "Entfernen" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Passwort", { exact: true }).fill(account.password);
    await dialog.getByRole("button", { name: "Entfernen" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Das ist dein letzter zweiter Faktor");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    // Add a named passkey.
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Testschlüssel");
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    // A new passkey is a sensitive change: confirmed once, then good for five minutes (no further dialogs below).
    await confirmWithPassword(page, account.password);
    const passkey = page.getByTestId("passkey-list").locator("li").filter({ hasText: "Testschlüssel" });
    await expect(passkey).toContainText("noch nie verwendet");
    await expect(passkey).toContainText("hinzugefügt");

    // Now the authenticator app can go; afterwards the passkey is the last factor.
    await totpRow.getByRole("button", { name: "Entfernen" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Passwort", { exact: true }).fill(account.password);
    await dialog.getByRole("button", { name: "Entfernen" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Authenticator-App entfernt" })).toBeVisible();
    await expect(totpRow).toContainText("Nicht eingerichtet");
    await page.getByRole("button", { name: "Testschlüssel entfernen" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Entfernen" }).click();
    await expect(dialog.getByRole("alert")).toContainText("letzter zweiter Faktor");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    // Set up the authenticator app again from the settings.
    await totpRow.getByRole("button", { name: "Einrichten" }).click();
    await expect(page.getByTestId("totp-qr")).toBeVisible();
    const fresh = { totpSecret: (await page.getByTestId("totp-secret").textContent())!.trim(), lastStep: 0 };
    await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(fresh));
    await page.getByRole("button", { name: "Aktivieren" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Authenticator-App aktiviert" })).toBeVisible();
    await expect(totpRow).toContainText("Aktiv");
    await page.getByRole("button", { name: "Testschlüssel entfernen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Entfernen" }).click();
    await expect(page.getByTestId("passkey-list")).toContainText("Noch keine Passkeys");

    // New recovery codes (password required).
    await page.getByRole("button", { name: "Neue Codes erzeugen" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Passwort", { exact: true }).fill(account.password);
    await dialog.getByRole("button", { name: "Erzeugen" }).click();
    await expect(dialog.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
    await dialog.getByLabel("Ich habe die Codes sicher aufbewahrt", { exact: true }).check();
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(page.getByTestId("codes-left")).toHaveText("Noch 10 Codes übrig");

    // New recovery key: re-wraps the same master secret; the old key stops working.
    await page.getByRole("button", { name: "Neuen Wiederherstellungsschlüssel erzeugen" }).click();
    dialog = page.getByRole("dialog");
    const newWords = await (async () => {
      await expect(dialog.getByTestId("recovery-key-words")).toBeVisible();
      return confirmRecoveryKey(page, "Neuen Schlüssel verwenden");
    })();
    expect(newWords).not.toBe(account.recoveryWords);
    await expect(page.getByRole("status").filter({ hasText: "Neuer Wiederherstellungsschlüssel gespeichert" })).toBeVisible();
    const identity = (await (await request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json()).identity_public_key;

    const other = await browser.newContext({ ...test.info().project.use });
    const page2 = await other.newPage();
    await loginViaUi(page2, { ...account, ...fresh });
    await page2.getByTestId("recovery-key-input").fill(account.recoveryWords);
    await page2.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page2.getByRole("alert")).toContainText("gehört nicht zu deinem Konto");
    await page2.getByTestId("recovery-key-input").fill(newWords);
    await page2.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page2.getByTestId("app-shell")).toBeVisible();
    // Same identity: no reset happened.
    expect((await (await request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json()).identity_public_key).toBe(identity);
    // The status first: a refused token names its code (tavrn-web#168: another test once expired every token).
    const res = await request.get(`${NODE}/api/v1/auth/factors`, { headers: { Authorization: `Bearer ${await tokenOf(page2)}` } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).totp).toBe(true);
    await other.close();
  });
});
