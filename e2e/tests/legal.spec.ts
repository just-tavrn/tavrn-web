// SPDX-License-Identifier: Apache-2.0
/**
 * Legal pages, terms and takedown notices (design note 4.14 items 1 and 2) on the legal node of the Playwright config:
 * the admin writes the imprint and the terms, the "Legal" link reaches the imprint in two clicks from the login page,
 * registration asks for the terms, a new version asks once, and a takedown notice goes from the public form through
 * the admin's decision to the uploader's statement of reasons and counter-notice. Phone and desktop.
 */
import { expect, test, type Page } from "@playwright/test";
import { confirmRecoveryCodes, confirmRecoveryKey, enrollTotpInUi, openNavIfMobile, uniqueName } from "./helpers";
import { LEGAL_NODE, LEGAL_WEB, acceptTerms, acceptTermsDialogIfShown, legalAdmin, loginOnLegal, publish, registerOnLegal, termsVersion } from "./legal-helpers";

/** Admin tabs scroll sideways on phones: open one by its test id. */
async function openAdminTab(page: Page, tab: string) {
  await page.getByTestId(`admin-tab-${tab}`).click();
}

test.describe("Legal", () => {
  test("The admin writes the imprint and the terms; the imprint is two clicks from the sign-in page", async ({ browser, page, request }) => {
    test.setTimeout(90_000);
    const admin = await legalAdmin(request);
    await acceptTerms(request, admin);
    const marker = uniqueName("betreiber");
    await loginOnLegal(page, admin);
    await page.goto(`${LEGAL_WEB}/admin/legal`);
    await acceptTermsDialogIfShown(page);
    await expect(page.getByTestId("legal-editor-imprint")).toBeVisible();
    await page.getByTestId("legal-markdown").fill(`# Impressum\n\nBetreiber e2e: ${marker}\n\n<script>window.pwned = 1</script>`);
    await page.getByTestId("legal-preview").click();
    await expect(page.getByTestId("legal-document")).toContainText(marker);
    await page.getByTestId("legal-publish").click();
    await expect(page.getByTestId("legal-doc-version")).toContainText("Version");
    await page.getByTestId("legal-kind").selectOption("terms");
    await page.getByTestId("legal-markdown").fill(`# Nutzungsbedingungen\n\nSei nett. ${marker}`);
    await page.getByTestId("legal-publish").click();
    await expect(page.getByTestId("legal-doc-version")).toContainText("Version");
    // The designated contact for notices.
    await page.getByTestId("legal-contact-name").fill("Betreiber GmbH");
    await page.getByTestId("legal-contact-email").fill("legal@example.org");
    await page.getByRole("button", { name: "Speichern" }).click();

    // Signed out: login page → "Rechtliches" → "Impressum".
    const guestContext = await browser.newContext({ ...test.info().project.use });
    const guest = await guestContext.newPage();
    await guest.goto(`${LEGAL_WEB}/login`);
    await guest.getByTestId("legal-footer-link").click();
    await guest.getByTestId("legal-index").getByRole("link", { name: /Impressum/ }).click();
    await expect(guest).toHaveURL(/\/legal\/imprint$/);
    await expect(guest.getByTestId("legal-document")).toContainText("Betreiber e2e:");
    expect(await guest.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    await expect(guest.getByTestId("legal-document").locator("script")).toHaveCount(0);
    await guestContext.close();
  });

  test("Registration requires the terms; a new version is asked for once", async ({ page, request }) => {
    test.setTimeout(120_000);
    const admin = await legalAdmin(request);
    if (!(await termsVersion(request))) await publish(request, admin, "terms", "# Nutzungsbedingungen\n\nSei nett.");
    const username = uniqueName("terms");
    const password = `passwort-${username}-xyz`;
    await page.goto(`${LEGAL_WEB}/login`);
    await page.getByRole("tab", { name: "Registrieren" }).click();
    await page.getByLabel("Benutzername", { exact: true }).fill(username);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await expect(page.getByRole("alert")).toContainText("Nutzungsbedingungen");
    await page.getByTestId("accept-terms").check();
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    // A parallel project may have published a newer version meanwhile: accept it again.
    const enroll = page.getByRole("heading", { name: "Zweiten Faktor einrichten" });
    await expect(enroll.or(page.getByRole("alert"))).toBeVisible({ timeout: 30_000 });
    if (!(await enroll.isVisible())) {
      await page.getByTestId("accept-terms").check();
      await page.getByRole("button", { name: "Konto erstellen" }).click();
    }
    await expect(enroll).toBeVisible();
    await enrollTotpInUi(page);
    await confirmRecoveryCodes(page);
    await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const accepted = await request.get(`${LEGAL_NODE}/api/v1/users/me/terms`, { headers: { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}").token as string)}` } });
    expect((await accepted.json()).accepted_version).toBeGreaterThanOrEqual(1);
    await acceptTermsDialogIfShown(page);

    // A new version: the dialog asks once; "Nicht jetzt" hides it for this version, accepting ends it.
    await publish(request, admin, "terms", `# Nutzungsbedingungen\n\nNeue Fassung ${uniqueName("v")}`);
    await page.reload();
    const dialog = page.getByTestId("terms-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Neue Fassung");
    await page.getByTestId("terms-decline").click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // The settings show the documents and the accepted version; accepting from a fresh version prompt.
    await publish(request, admin, "terms", `# Nutzungsbedingungen\n\nNoch eine Fassung ${uniqueName("v")}`);
    await page.reload();
    await expect(dialog).toBeVisible();
    await page.getByTestId("terms-accept").click();
    await expect(dialog).toHaveCount(0);
    await page.goto(`${LEGAL_WEB}/settings/legal`);
    await acceptTermsDialogIfShown(page);
    await expect(page.getByTestId("settings-legal-docs")).toContainText("Nutzungsbedingungen");
  });

  test("Report via the form, the admin removes the content, the uploader sees the reason and objects", async ({ browser, page, request }) => {
    test.setTimeout(120_000);
    const admin = await legalAdmin(request);
    const uploader = await registerOnLegal(request, "uploader");
    const room = await (await request.post(`${LEGAL_NODE}/api/v1/rooms`, { headers: { Authorization: `Bearer ${uploader.token}` }, data: { name: "Fotos" } })).json();
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await request.patch(`${LEGAL_NODE}/api/v1/rooms/${room.id}/channels/${channel.id}`, { headers: { Authorization: `Bearer ${uploader.token}` }, data: { encrypted: false } });
    const body = `Kopiertes Foto ${uniqueName("p")}`;
    const msg = await (await request.post(`${LEGAL_NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: { Authorization: `Bearer ${uploader.token}` }, data: { content: { type: "text", body } } })).json();
    const link = `${LEGAL_WEB}/rooms/${room.id}/channels/${channel.id}?message=${msg.id}`;
    const work = `Mein Foto ${uniqueName("w")}`;

    // The reporter needs no account.
    const reporterContext = await browser.newContext({ ...test.info().project.use });
    const reporter = await reporterContext.newPage();
    await reporter.goto(`${LEGAL_WEB}/legal`);
    await reporter.getByTestId("legal-notice-link").click();
    await expect(reporter.getByTestId("notice-form")).toBeVisible();
    await reporter.getByTestId("notice-work").fill(work);
    await reporter.getByTestId("notice-location").fill(link);
    await reporter.getByTestId("notice-name").fill("Rita Reporter");
    await reporter.getByTestId("notice-email").fill("rita@example.org");
    await reporter.getByTestId("notice-good-faith").check();
    await reporter.getByTestId("notice-accuracy").check();
    await reporter.getByTestId("notice-perjury").check();
    await reporter.getByTestId("notice-signature").fill("Rita Reporter");
    await reporter.getByTestId("notice-submit").click();
    await expect(reporter.getByTestId("notice-confirmation")).toBeVisible();
    const caseId = (await reporter.getByTestId("notice-case-id").textContent())!.trim();
    expect(caseId).toMatch(/^[0-9A-Z]{26}$/);
    await reporterContext.close();

    // The admin reviews the case with the content inline and removes it with a statement of reasons.
    // The other project's "new terms version" test may publish terms while this page is open: the dialog
    // then appears at any time and would swallow the clicks, so it is accepted whenever it shows up.
    await acceptTerms(request, admin);
    await loginOnLegal(page, admin);
    await page.addLocatorHandler(page.getByTestId("terms-dialog"), async () => {
      await page.getByTestId("terms-accept").click();
    });
    await page.goto(`${LEGAL_WEB}/admin`);
    await acceptTermsDialogIfShown(page);
    await openAdminTab(page, "notices");
    await page.getByTestId("notice-row").filter({ hasText: work }).click();
    await expect(page.getByTestId("notice-detail")).toBeVisible();
    await expect(page.getByTestId("notice-content-text")).toContainText(body);
    await page.getByTestId("notice-statement").fill("Der Beitrag kopiert ein geschütztes Foto.");
    await page.getByTestId("notice-reason").fill("Urheberrecht");
    await page.getByTestId("notice-run").click();
    await expect(page.getByTestId("notice-detail-state")).toHaveText("Maßnahme ergriffen");
    await expect(page.getByTestId("notice-trail")).toContainText("remove_content");

    // The uploader sees the statement of reasons and sends a counter-notice.
    await acceptTerms(request, uploader);
    const upContext = await browser.newContext({ ...test.info().project.use });
    const up = await upContext.newPage();
    await loginOnLegal(up, uploader);
    await up.addLocatorHandler(up.getByTestId("terms-dialog"), async () => {
      await up.getByTestId("terms-accept").click();
    });
    await up.goto(`${LEGAL_WEB}/`);
    await acceptTermsDialogIfShown(up);
    await openNavIfMobile(up);
    await up.getByTestId("presence-menu-button").click();
    await up.getByTestId("presence-legal").click();
    await expect(up).toHaveURL(/\/settings\/legal$/);
    const entry = up.getByTestId("my-notice").filter({ hasText: caseId });
    await expect(entry.getByTestId("statement-text")).toContainText("geschütztes Foto");
    await entry.getByTestId("counter-open").click();
    await up.getByTestId("counter-name").fill("Uwe Uploader");
    await up.getByTestId("counter-address").fill("Hauptstraße 1, Stadt");
    await up.getByTestId("counter-statement").fill("Das Foto habe ich selbst aufgenommen.");
    await up.getByTestId("counter-consent").check();
    await up.getByTestId("counter-signature").fill("Uwe Uploader");
    await up.getByTestId("counter-submit").click();
    await expect(entry).toContainText("Gegendarstellung gesendet");
    await upContext.close();

    // The admin sees the counter-notice.
    await page.reload();
    await acceptTermsDialogIfShown(page);
    await openAdminTab(page, "notices");
    await page.getByTestId("notice-row").filter({ hasText: work }).click();
    await expect(page.getByTestId("counter-notice")).toContainText("selbst aufgenommen");
  });
});
