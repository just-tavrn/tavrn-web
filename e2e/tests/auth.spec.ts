// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { ADULT_DOB, NODE, addVirtualAuthenticator, confirmRecoveryCodes, confirmRecoveryKey, confirmWithPassword, confirmWithPasswordIfAsked, loginViaUi, nextTotpCode, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, uniqueName, logoutViaUi } from "./helpers";
import { scaled } from "./timeouts";

test.describe("Sign-in with a second factor", () => {
  test("Registration with TOTP: codes, recovery key, keys on the node", async ({ page, request }) => {
    const account = await registerViaUi(page);
    expect(account.recoveryCodes).toHaveLength(10);
    const keys = await (await request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json();
    expect(keys.identity_public_key).toBeTruthy();
    expect(keys.devices).toHaveLength(1);
    const token = await tokenOf(page);
    const count = await request.get(`${NODE}/api/v1/users/me/devices/${keys.devices[0].device_id}/key-packages`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await count.json()).count).toBe(20);
    const storage = await (await request.get(`${NODE}/api/v1/users/me/secret-storage`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(storage.items.map((i: { method: string }) => i.method)).toEqual(["recovery"]);
    // The pre-auth state is gone once the session exists.
    expect(await page.evaluate(() => sessionStorage.getItem("tavrn.preauth"))).toBeNull();
  });

  test("Sign-in with a TOTP code; an account without encryption sets it up afterwards", async ({ page, request }) => {
    const account = await registerViaApi(request, "totp");
    await page.goto("/login");
    await page.getByLabel("Benutzername", { exact: true }).fill(account.username);
    await page.getByLabel("Passwort", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Anmeldung bestätigen" })).toBeVisible();
    await page.getByLabel("6-stelliger Code", { exact: true }).fill("000000");
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Der Code ist falsch");
    // A reload keeps the step (pre-auth token in sessionStorage).
    await page.reload();
    await expect(page.getByRole("heading", { name: "Anmeldung bestätigen" })).toBeVisible();
    await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(account));
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await expect(page.getByTestId("encryption-title")).toHaveText("Dein Wiederherstellungsschlüssel");
    await expect(page.getByTestId("encryption-account")).toHaveText(`${account.username}@localhost`);
    await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
  });

  test("Sign-in with a recovery code", async ({ page, request }) => {
    const account = await registerViaApi(request, "rcode");
    await page.goto("/login");
    await page.getByLabel("Benutzername", { exact: true }).fill(account.username);
    await page.getByLabel("Passwort", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await page.getByRole("button", { name: "Wiederherstellungscode verwenden" }).click();
    await page.getByLabel("Wiederherstellungscode", { exact: true }).fill(account.recoveryCodes[0]!.toUpperCase());
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "mit einem Wiederherstellungscode angemeldet" })).toBeVisible();
    await expect(page.getByTestId("encryption-title")).toHaveText("Dein Wiederherstellungsschlüssel");
    const factors = await (await request.get(`${NODE}/api/v1/auth/factors`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).json();
    expect(factors.recovery_codes_left).toBe(9);
  });

  test("New device: unlock with the recovery key, without the key only restricted", async ({ browser, page, request }) => {
    test.setTimeout(scaled(90_000));
    const account = await registerViaUi(page);
    const other = await browser.newContext({ ...test.info().project.use });
    const page2 = await other.newPage();
    await loginViaUi(page2, account);
    await expect(page2.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
    await page2.getByTestId("recovery-key-input").fill("falsch falsch falsch");
    await page2.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page2.getByRole("alert")).toContainText("kein gültiger Wiederherstellungsschlüssel");
    // Degraded mode first, then unlock from the banner.
    await page2.getByTestId("skip-unlock").click();
    await expect(page2.getByTestId("e2ee-banner")).toContainText("noch nicht lesbar");
    await page2.getByTestId("e2ee-banner").getByRole("link", { name: "Entsperren" }).click();
    await page2.getByTestId("recovery-key-input").fill(account.recoveryWords);
    await page2.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page2.getByTestId("app-shell")).toBeVisible();
    await expect(page2.getByTestId("e2ee-banner")).toHaveCount(0);
    const keys = await (await request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json();
    expect(keys.devices).toHaveLength(2);
    await other.close();
  });

  test("Reset the identity when the recovery key is lost", async ({ browser, page, request }) => {
    test.setTimeout(scaled(90_000));
    const account = await registerViaUi(page);
    const before = (await (await request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json()).identity_public_key;
    const other = await browser.newContext({ ...test.info().project.use });
    const page2 = await other.newPage();
    await loginViaUi(page2, account);
    await page2.getByRole("button", { name: /Identität zurücksetzen/ }).click();
    await expect(page2.getByTestId("reset-warning")).toContainText("endgültig unlesbar");
    await page2.getByLabel("Passwort", { exact: true }).fill(account.password);
    await page2.getByRole("button", { name: "Weiter", exact: true }).click();
    await confirmRecoveryKey(page2, "Identität zurücksetzen");
    await expect(page2.getByTestId("app-shell")).toBeVisible();
    const keys = await (await request.get(`${NODE}/api/v1/users/${account.username}/keys`)).json();
    expect(keys.identity_public_key).not.toBe(before);
    expect(keys.identity_reset_at).toBeTruthy();
    expect(keys.devices).toHaveLength(1);
    await other.close();
  });

  test("Lock on close: a new tab asks for the recovery key", async ({ context, page }) => {
    test.setTimeout(scaled(90_000));
    const account = await registerViaUi(page);
    await page.goto("/settings/security");
    await expect(page.getByTestId("e2ee-status")).toHaveText(/Entsperrt/);
    await page.getByTestId("lock-on-close").check();
    await expect(page.getByRole("status").filter({ hasText: "sperrt sich jetzt" })).toBeVisible();
    const tab = await context.newPage();
    await tab.goto("/");
    await expect(tab.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
    await tab.getByTestId("recovery-key-input").fill(account.recoveryWords);
    await tab.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(tab.getByTestId("app-shell")).toBeVisible();
    // Switching it off again (navigating inside the app: a reload would lock again): the next tab opens directly.
    await openNavIfMobile(tab);
    await tab.getByRole("button", { name: "Benutzereinstellungen" }).click();
    await tab.getByRole("link", { name: "Sicherheit" }).click();
    await tab.getByTestId("lock-on-close").uncheck();
    await expect(tab.getByRole("status").filter({ hasText: "bleibt entsperrt" })).toBeVisible();
    const tab2 = await context.newPage();
    await tab2.goto("/settings/security");
    await expect(tab2.getByTestId("e2ee-status")).toHaveText(/Entsperrt/);
  });

  test("Signing out deletes the local keys", async ({ page }) => {
    await registerViaUi(page);
    const before = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    expect(before).toContain("tavrn-crypto");
    await page.goto("/");
    const width = page.viewportSize()?.width ?? 1280;
    if (width < 768) await page.getByTestId("nav-toggle").tap();
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);
    const left = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open("tavrn-crypto", 1);
          req.onsuccess = () => {
            const get = req.result.transaction("accounts").objectStore("accounts").count();
            get.onsuccess = () => resolve(get.result);
          };
        }),
    );
    expect(left).toBe(0);
  });
});

// Passkeys use Chromium's CDP virtual authenticator (also in the mobile-android project, which is
// Chromium). With `hasPrf` the authenticator evaluates the PRF extension, so these specs cover the
// PRF secret storage entry and the passkey unlock; on a Chromium without PRF they fall back to the
// recovery key and record that in the "prf" annotation.
test.describe("Passkeys (Chromium, virtual authenticator)", () => {
  test("Registration with a passkey, sign-out, sign-in with the passkey only", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "CDP virtual authenticator is Chromium only");
    test.setTimeout(scaled(90_000));
    const { prf: prfOption } = await addVirtualAuthenticator(page);
    const username = uniqueName("pk");
    const password = `passwort-${username}-xyz`;
    await page.goto("/login");
    await page.getByRole("tab", { name: "Registrieren" }).click();
    await page.getByLabel("Benutzername", { exact: true }).fill(username);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
    await page.getByLabel("Geburtsdatum", { exact: true }).fill(ADULT_DOB);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await page.getByTestId("choose-passkey").click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Virtueller Schlüssel");
    await page.getByRole("button", { name: "Passkey erstellen" }).click();
    await expect(page.getByRole("heading", { name: "Deine Wiederherstellungscodes" })).toBeVisible();
    await confirmRecoveryCodes(page);
    const words = await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    const token = await tokenOf(page);
    const factors = await (await request.get(`${NODE}/api/v1/auth/factors`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(factors.totp).toBe(false);
    expect(factors.webauthn).toHaveLength(1);
    expect(factors.webauthn[0].name).toBe("Virtueller Schlüssel");
    const storage = await (await request.get(`${NODE}/api/v1/users/me/secret-storage`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const prf = factors.webauthn[0].prf_supported && storage.items.some((i: { method: string }) => i.method.startsWith("passkey:"));
    test.info().annotations.push({ type: "prf", description: prf ? "virtual authenticator supports PRF: passkey unlock covered" : `no PRF in this Chromium (hasPrf option accepted: ${prfOption}); passkey login covered without PRF unlock` });

    // Sign out (wipes the local keys), then passkey-only login.
    await page.goto("/");
    if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId("nav-toggle").tap();
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);
    await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
    if (prf) {
      // The PRF output of the same ceremony unlocks the secret storage.
      await expect(page.getByTestId("app-shell")).toBeVisible();
    } else {
      await expect(page.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
      await page.getByTestId("recovery-key-input").fill(words);
      await page.getByRole("button", { name: "Entsperren", exact: true }).click();
      await expect(page.getByTestId("app-shell")).toBeVisible();
    }
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
    // Signing out deleted the local keys and with them the device (PROTOCOL.md §5b); it stays verifiable as retired.
    const keys = await (await request.get(`${NODE}/api/v1/users/${username}/keys`)).json();
    expect(keys.devices).toHaveLength(1);
    expect(keys.retired).toHaveLength(1);
  });

  test("Add a passkey in the settings and use it as the second factor after the password", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "CDP virtual authenticator is Chromium only");
    test.setTimeout(scaled(90_000));
    await addVirtualAuthenticator(page);
    const account = await registerViaUi(page);
    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Zweitschlüssel");
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await confirmWithPassword(page, account.password);
    const item = page.getByTestId("passkey-list").locator("li").filter({ hasText: "Zweitschlüssel" });
    await expect(item).toBeVisible();
    const prf = (await item.textContent())!.includes("entsperrt Nachrichten");

    await page.goto("/");
    await openNavIfMobile(page);
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("Benutzername", { exact: true }).fill(account.username);
    await page.getByLabel("Passwort", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Anmeldung bestätigen" })).toBeVisible();
    await page.getByRole("button", { name: "Passkey verwenden" }).click();
    if (!prf) {
      await page.getByTestId("recovery-key-input").fill(account.recoveryWords);
      await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    }
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
    const me = await request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
    expect(me.ok()).toBeTruthy();
  });

  /** Adds a passkey named `name` in Settings → Security (open) and returns its list item. */
  async function addPasskeyInSettings(page: Page, name: string, password: string) {
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await confirmWithPasswordIfAsked(page, password);
    const item = page.getByTestId("passkey-list").locator("li").filter({ hasText: name });
    await expect(item).toBeVisible();
    return item;
  }

  test("A second passkey unlocks the messages as well: first one removed, lock on close, reload, unlock with the second", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "CDP virtual authenticator is Chromium only");
    test.setTimeout(scaled(120_000));
    const first = await addVirtualAuthenticator(page);
    test.skip(!first.prf, "this Chromium's virtual authenticator has no PRF: nothing to unlock with");
    const account = await registerViaUi(page);
    await page.goto("/settings/security");
    await expect(page.getByTestId("e2ee-status")).toHaveText(/Entsperrt/);
    const one = await addPasskeyInSettings(page, "Erster Schlüssel", account.password);
    await expect(one).toContainText("entsperrt Nachrichten");
    // Another authenticator (a passkey added later, on another device): its entry is written right away as well.
    await first.remove();
    await addVirtualAuthenticator(page);
    const two = await addPasskeyInSettings(page, "Zweiter Schlüssel", account.password);
    await expect(two).toContainText("entsperrt Nachrichten");
    const headers = { Authorization: `Bearer ${await tokenOf(page)}` };
    const entriesOf = async () => ((await (await request.get(`${NODE}/api/v1/users/me/secret-storage`, { headers })).json()).items as Array<{ method: string }>).map((i) => i.method).filter((m) => m.startsWith("passkey:"));
    expect(await entriesOf()).toHaveLength(2);
    // Removing the first passkey removes its entry (the node does that with the credential).
    await page.getByRole("button", { name: "Erster Schlüssel entfernen" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Entfernen" }).click();
    await expect(one).toHaveCount(0);
    const factors = await (await request.get(`${NODE}/api/v1/auth/factors`, { headers })).json();
    expect(factors.webauthn.map((c: { name: string }) => c.name)).toEqual(["Zweiter Schlüssel"]);
    expect(await entriesOf()).toEqual([`passkey:${factors.webauthn[0].id}`]);
    // Lock on close, reload: the second passkey alone unlocks.
    await page.getByTestId("lock-on-close").check();
    await expect(page.getByRole("status").filter({ hasText: "sperrt sich jetzt" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
    await page.getByRole("button", { name: "Mit Passkey entsperren" }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
  });

  test("A passkey added on a locked device is enabled for the message unlock later", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "CDP virtual authenticator is Chromium only");
    test.setTimeout(scaled(120_000));
    const authenticator = await addVirtualAuthenticator(page);
    test.skip(!authenticator.prf, "this Chromium's virtual authenticator has no PRF: nothing to enable");
    const account = await registerViaUi(page);
    await page.goto("/settings/security");
    await page.getByTestId("lock-on-close").check();
    await expect(page.getByRole("status").filter({ hasText: "sperrt sich jetzt" })).toBeVisible();
    // Locked after the reload; continue without the messages and add the passkey: no wrap can be written.
    await page.reload();
    await expect(page.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
    await page.getByTestId("skip-unlock").click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.goto("/settings/security");
    await expect(page.getByTestId("e2ee-status")).toHaveText(/Gesperrt/);
    const item = await addPasskeyInSettings(page, "Später aktiviert", account.password);
    await expect(item).toContainText("noch nicht aktiviert");
    const enable = item.getByRole("button", { name: "Nachrichten-Entsperrung aktivieren: Später aktiviert" });
    await expect(enable).toBeDisabled();
    await expect(item).toContainText("Entsperre zuerst");
    const headers = { Authorization: `Bearer ${await tokenOf(page)}` };
    const before = await (await request.get(`${NODE}/api/v1/users/me/secret-storage`, { headers })).json();
    expect(before.items.some((i: { method: string }) => i.method.startsWith("passkey:"))).toBe(false);
    // Unlock this device with the recovery key, then enable: one PRF assertion, the entry is stored.
    await page.getByTestId("e2ee-status").getByRole("link", { name: "Entsperren" }).click();
    await page.getByTestId("recovery-key-input").fill(account.recoveryWords);
    await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page.getByTestId("e2ee-status")).toHaveText(/Entsperrt/);
    const unlocked = page.getByTestId("passkey-list").locator("li").filter({ hasText: "Später aktiviert" });
    await unlocked.getByRole("button", { name: "Nachrichten-Entsperrung aktivieren: Später aktiviert" }).click();
    await confirmWithPasswordIfAsked(page, account.password);
    await expect(unlocked).toContainText("entsperrt Nachrichten");
    await expect(unlocked.getByRole("button", { name: /aktivieren/ })).toHaveCount(0);
    const factors = await (await request.get(`${NODE}/api/v1/auth/factors`, { headers })).json();
    const after = await (await request.get(`${NODE}/api/v1/users/me/secret-storage`, { headers })).json();
    expect(after.items.map((i: { method: string }) => i.method)).toContain(`passkey:${factors.webauthn[0].id}`);
    // Lock on close is still on: the reload locks again (this device chose to continue without the messages earlier,
    // so the app opens locked instead of asking), and the enabled passkey unlocks.
    await page.reload();
    await expect(page.getByTestId("e2ee-status")).toHaveText(/Gesperrt/);
    await page.getByTestId("e2ee-status").getByRole("link", { name: "Entsperren" }).click();
    await expect(page.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
    await page.getByRole("button", { name: "Mit Passkey entsperren" }).click();
    await expect(page.getByTestId("e2ee-status")).toHaveText(/Entsperrt/);
  });
});
