// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { ADULT_DOB, addVirtualAuthenticator, confirmRecoveryCodes, confirmRecoveryKey, nextTotpCode, openNavIfMobile, registerViaApi, uniqueName, logoutViaUi } from "./helpers";
import { A, B, FEDERATION_BROWSER, NODE_A, WEB_A, WEB_B, chromiumOnly } from "./federation-helpers";

test.use(FEDERATION_BROWSER);

// Signing in on node B's web client with an account of node A (FEDERATION.md §8): the direct flow
// (password and TOTP against A's API, cross-origin) and the connect flow (A's own web client, here with a
// passkey on A's origin). Both end in B's app with the full address of A shown.
test.describe("Signing in with an account of another node", () => {
  chromiumOnly();

  test("Direct: password and TOTP against the home node", async ({ page, request }) => {
    test.setTimeout(120_000);
    const alice = await registerViaApi(request, "fdirect", NODE_A);
    await page.goto(`${WEB_B}/login`);
    await expect(page.getByTestId("node-name")).toContainText(`(${B})`);
    await page.getByTestId("remote-login-open").click();
    await page.getByLabel("Deine Adresse", { exact: true }).fill(`${alice.username}@${A}`);
    await page.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(page.getByTestId("remote-home")).toHaveText(`Anmeldung bei ${A}`);
    await expect(page.getByTestId("remote-warning")).toContainText(B);
    await page.getByLabel("Passwort", { exact: true }).fill(alice.password);
    await page.getByRole("button", { name: "Mit Passwort anmelden", exact: true }).click();
    // Passkeys of A cannot be used on B's origin: only TOTP and recovery codes are offered.
    await expect(page.getByRole("button", { name: "Passkey verwenden" })).toHaveCount(0);
    await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(alice));
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();

    // A new account without encryption keys sets them up here; keys and secret storage live on A.
    await expect(page.getByTestId("encryption-title")).toHaveText("Dein Wiederherstellungsschlüssel");
    await expect(page.getByTestId("encryption-account")).toHaveText(`${alice.username}@${A}`);
    await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await openNavIfMobile(page);
    await expect(page.getByTestId("me-address")).toHaveText(`${alice.username}@${A}`);
    const keys = await (await request.get(`${NODE_A}/api/v1/users/${alice.username}/keys`)).json();
    expect(keys.identity_public_key).toBeTruthy();

    // A home session for A plus a federated session for B (the node of this web client).
    const stored = await page.evaluate(() => ({ auth: JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}"), nodes: JSON.parse(localStorage.getItem("tavrn.nodes") ?? "{}") }));
    expect(stored.auth.home.domain).toBe(A);
    expect(stored.auth.user.address).toBe(`${alice.username}@${A}`);
    expect(Object.keys(stored.nodes)).toEqual([B]);
    expect(stored.nodes[B].user.address).toBe(`${alice.username}@${A}`);
  });

  test("Connect flow: passkey in the web client of the home node", async ({ page, request }) => {
    test.setTimeout(150_000);
    const { prf } = await addVirtualAuthenticator(page);
    // An account on A with a passkey as its only factor, created in A's own web client.
    const username = uniqueName("fpk");
    const password = `passwort-${username}-xyz`;
    await page.goto(`${WEB_A}/login`);
    await page.getByRole("tab", { name: "Registrieren" }).click();
    await page.getByLabel("Benutzername", { exact: true }).fill(username);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
    await page.getByLabel("Geburtsdatum", { exact: true }).fill(ADULT_DOB);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await page.getByTestId("choose-passkey").click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Schlüssel A");
    await page.getByRole("button", { name: "Passkey erstellen" }).click();
    await confirmRecoveryCodes(page);
    const words = await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await openNavIfMobile(page);
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);

    // On B: sign in with the account of A through A's web client.
    await page.goto(`${WEB_B}/login`);
    await page.getByTestId("remote-login-open").click();
    await page.getByLabel("Deine Adresse", { exact: true }).fill(`${username}@${A}`);
    await page.getByRole("button", { name: "Weiter", exact: true }).click();
    await page.getByTestId("remote-connect").click();
    await expect(page).toHaveURL(new RegExp(`^${WEB_A}/login\\?next=`));
    await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
    // A unlocks with the PRF passkey right away, or asks for the recovery key.
    const connectTitle = page.getByTestId("connect-title");
    const recoveryInput = page.getByTestId("recovery-key-input");
    await expect(connectTitle.or(recoveryInput)).toBeVisible();
    if (await recoveryInput.isVisible()) {
      await page.getByTestId("recovery-key-input").fill(words);
      await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    }
    await expect(connectTitle).toHaveText("Bei einem anderen Web-Client anmelden?");
    await expect(page.getByTestId("connect-text")).toContainText(`${username}@${A}`);
    await expect(page.getByTestId("connect-text")).toContainText(new URL(WEB_B).host);
    await page.getByTestId("connect-allow").click();

    // Back on B: the code is exchanged, then the encryption is unlocked with the recovery key (a
    // passkey of A cannot unlock on B's origin, and the page says so).
    await expect(page).toHaveURL(new RegExp(`^${WEB_B}/encryption`));
    await expect(page.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren");
    await expect(page.getByTestId("encryption-account")).toHaveText(`${username}@${A}`);
    await expect(page.getByTestId("prf-origin-note")).toContainText(A);
    await page.getByTestId("recovery-key-input").fill(words);
    await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
    await openNavIfMobile(page);
    await expect(page.getByTestId("me-address")).toHaveText(`${username}@${A}`);
    test.info().annotations.push({ type: "prf", description: prf ? "PRF accepted by the virtual authenticator" : "no PRF: unlocked with the recovery key on A" });

  });
});
