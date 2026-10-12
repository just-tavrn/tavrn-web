// SPDX-License-Identifier: Apache-2.0
// E-mail confirmation (PROTOCOL.md §5a.3): the page of the mailed link, the confirmation mail sent again from the
// sign-in, and the registration's notice about the link. The e2e node runs with TAVRN_EMAIL=optional and logs mails
// without SMTP, so the token of a real mail is not reachable here: the confirmed state is covered by Vitest
// (VerifyEmailPage.test.tsx), the refusal of an unconfirmed sign-in (a `required` node) by a routed answer.
import { expect, test } from "@playwright/test";
import { ADULT_DOB, confirmRecoveryCodes, enrollTotpInUi, uniqueName } from "./helpers";

test.describe("E-mail confirmation", () => {
  test("the link's page: an invalid link and a page without a link lead to the sign-in", async ({ page }) => {
    await page.goto("/verify-email?token=not-a-real-token");
    await expect(page.getByRole("heading", { name: "Link ungültig" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("Der Link ist ungültig oder abgelaufen. Melde dich an, um einen neuen anzufordern.");
    await page.getByRole("link", { name: "Anmelden", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/verify-email");
    await expect(page.getByRole("heading", { name: "E-Mail-Adresse bestätigen" })).toBeVisible();
    await expect(page.getByText(/Öffne den Link aus der Bestätigungsmail/)).toBeVisible();
  });

  test("registration with an e-mail address names the address the link went to; the sign-in sends it again", async ({ page, browser, baseURL }) => {
    const username = uniqueName("mail");
    const password = `passwort-${username}-xyz`;
    const email = `${username}@example.org`;
    await page.goto("/login");
    await page.getByRole("tab", { name: "Registrieren" }).click();
    await page.getByLabel("Benutzername", { exact: true }).fill(username);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
    await page.getByLabel("Geburtsdatum", { exact: true }).fill(ADULT_DOB);
    await page.getByLabel("E-Mail (optional)", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await expect(page.getByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeVisible();
    await enrollTotpInUi(page);
    await expect(page.getByRole("heading", { name: "Deine Wiederherstellungscodes" })).toBeVisible();
    await expect(page.getByTestId("email-confirmation-notice")).toHaveText(
      `Wir haben einen Bestätigungslink an ${email} gesendet. Mit einer bestätigten Adresse kannst du ein vergessenes Passwort zurücksetzen.`,
    );
    await confirmRecoveryCodes(page);
    await expect(page.getByTestId("wizard-steps")).toContainText("Schritt 4 von 4");

    // A node with TAVRN_EMAIL=required refuses the password sign-in until the address is confirmed: that answer is
    // routed, the mail sent again goes to the real node (204 for every account, a new link for this one).
    const fresh = await browser.newContext({ baseURL, locale: "de-DE" });
    const signIn = await fresh.newPage();
    await signIn.route("**/api/v1/auth/login", (route) =>
      route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Forbidden", status: 403, code: "auth.email_unverified", detail: "Please verify the email address first" }) }),
    );
    await signIn.goto("/login");
    await signIn.getByLabel("Benutzername", { exact: true }).fill(username);
    await signIn.getByLabel("Passwort", { exact: true }).fill(password);
    await signIn.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(signIn.getByRole("alert")).toContainText("Deine E-Mail-Adresse ist noch nicht bestätigt");
    const resent = signIn.waitForResponse((r) => r.url().endsWith("/api/v1/auth/verify-email/resend"));
    await signIn.getByRole("button", { name: "Bestätigungsmail erneut senden" }).click();
    expect((await resent).status()).toBe(204);
    await expect(signIn.getByTestId("confirmation-resent")).toContainText("ein neuer Link unterwegs");
    await fresh.close();
  });
});
