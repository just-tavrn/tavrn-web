// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, loginViaUi, openNavIfMobile, openRoomInvite, registerViaUi, tokenOf } from "./helpers";

// End-to-end encrypted files channels (tavrn-protocol/FILES.md §8): Alice creates one (encrypted by default), uploads
// a file and makes a folder; Bob, a second member, reads the names, downloads the file and finds it with the search on
// his device; Bob's second device without keys sees "Your files" and deletes his upload by ownership; deleting the
// channel needs the typed name and says what happens to the files. The node only ever holds ciphertext.

const CRYPTO = { timeout: 30_000 };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

/** axe on a part of the page: serious and critical WCAG violations fail. */
async function axe(page: Page, selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const row = (page: Page, name: string) => page.getByTestId("file-row").filter({ has: page.locator('[data-testid="file-open"]', { hasText: name }) });

async function api(page: Page, path: string) {
  const resp = await page.request.get(`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json();
}

test.describe("Encrypted files channels", () => {
  test("create encrypted, upload, folder, a member downloads and finds it, a locked device deletes own files, typed deletion", async ({ browser, page }) => {
    test.setTimeout(240_000);
    const alice = await registerViaUi(page, { prefix: "fea" });
    // Alice's room (its text channel is encrypted) and an encrypted files channel created in the dialog.
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Tresor-Raum");
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    const roomId = page.url().split("/rooms/")[1]!.split("/")[0]!;
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Channel erstellen" }).click();
    const create = page.getByRole("dialog");
    await create.getByLabel("Art").selectOption("files");
    await create.getByLabel("Name", { exact: true }).fill("Tresor");
    const toggle = create.getByTestId("files-encrypted-toggle");
    await expect(toggle).toBeChecked();
    await expect(create).toContainText("Lässt sich später nicht ändern.");
    await create.getByRole("button", { name: "Erstellen" }).click();
    await openNavIfMobile(page);
    const link = page.locator('[data-testid="channel-row"][data-kind="files"]').getByRole("link");
    await expect(link.locator('[data-testid="channel-lock"]')).toBeVisible();
    await link.click();
    await expect(page.getByTestId("files-view")).toBeVisible();
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByTestId("files-banner")).toHaveCount(0);
    const channelId = page.url().split("/channels/")[1]!.split("?")[0]!;

    // A folder and a file inside it, a file at the top.
    await page.getByTestId("files-new-folder").click();
    await page.getByTestId("files-name-input").fill("Projekte");
    await page.getByTestId("files-name-submit").click();
    await expect(row(page, "Projekte")).toBeVisible(CRYPTO);
    await page.getByTestId("files-upload-input").setInputFiles([{ name: "bauplan.png", mimeType: "image/png", buffer: PNG }]);
    await expect(row(page, "bauplan.png")).toBeVisible(CRYPTO);
    await row(page, "Projekte").getByTestId("file-open").click();
    await expect(page.getByTestId("files-breadcrumbs")).toContainText("Projekte");
    await page.getByTestId("files-upload-input").setInputFiles([{ name: "geheimplan.txt", mimeType: "text/plain", buffer: Buffer.from("Streng geheim: Lagerfeuer um acht") }]);
    await expect(row(page, "geheimplan.txt")).toBeVisible(CRYPTO);
    await axe(page, '[data-testid="files-view"]');

    // The node holds no name or content: listings carry records only.
    const top = await api(page, `/rooms/${roomId}/channels/${channelId}/files`);
    expect(JSON.stringify(top)).not.toContain("bauplan");
    expect(JSON.stringify(top)).not.toContain("Projekte");
    expect(top.entries.every((e: { name: string; record: string }) => e.name === "" && typeof e.record === "string")).toBe(true);

    // Bob joins and reads the files on his device.
    await openRoomInvite(page);
    await page.getByRole("button", { name: "Link erzeugen" }).click();
    const invite = await page.getByTestId("invite-link").inputValue();
    await page.getByRole("button", { name: "Fertig" }).click();
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "feb" });
    await bobPage.goto(invite);
    await bobPage.getByRole("button", { name: "Beitreten" }).click();
    await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");
    const filesUrl = `/rooms/${roomId}/channels/${channelId}`;
    await bobPage.goto(filesUrl);
    await expect(row(bobPage, "bauplan.png")).toBeVisible(CRYPTO);
    await row(bobPage, "Projekte").getByTestId("file-open").click();
    await expect(row(bobPage, "geheimplan.txt")).toBeVisible(CRYPTO);
    const [download] = await Promise.all([
      bobPage.waitForEvent("download"),
      (async () => {
        await row(bobPage, "geheimplan.txt").getByTestId("file-menu-button").click();
        await bobPage.getByTestId("files-menu").getByRole("menuitem", { name: "Herunterladen" }).click();
      })(),
    ]);
    expect(download.suggestedFilename()).toBe("geheimplan.txt");
    const path = await download.path();
    const fs = await import("node:fs");
    expect(fs.readFileSync(path!, "utf8")).toBe("Streng geheim: Lagerfeuer um acht");

    // The search on Bob's device finds the file by name (local index, "Files" group) and opens it in its folder.
    await bobPage.waitForTimeout(2500);
    await bobPage.goto(`/rooms/${roomId}`);
    await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");
    await bobPage.getByTestId("search-open").click();
    await bobPage.getByTestId("search-input").fill("geheimplan");
    await bobPage.getByTestId("search-submit").click();
    const hit = bobPage.getByTestId("search-file-result").filter({ hasText: "geheimplan.txt" });
    await expect(hit).toBeVisible(CRYPTO);
    await expect(hit).toContainText("Projekte");
    await hit.click();
    await expect(bobPage.getByTestId("files-view")).toBeVisible();
    await expect(bobPage.getByTestId("files-breadcrumbs")).toContainText("Projekte", CRYPTO);
    await expect(row(bobPage, "geheimplan.txt")).toHaveAttribute("aria-selected", "true");

    // Bob uploads a file of his own; a second device of Bob without keys can still delete it.
    await bobPage.goto(filesUrl);
    await bobPage.getByTestId("files-upload-input").setInputFiles([{ name: "bobs-notiz.txt", mimeType: "text/plain", buffer: Buffer.from("von Bob") }]);
    await expect(row(bobPage, "bobs-notiz.txt")).toBeVisible(CRYPTO);
    const locked = await newPage(browser);
    await loginViaUi(locked, bob);
    await locked.getByRole("button", { name: "Ohne Entschlüsselung fortfahren" }).click();
    await expect(locked.getByTestId("app-shell")).toBeVisible();
    await locked.goto(filesUrl);
    const panel = locked.getByTestId("your-files");
    await expect(panel).toBeVisible(CRYPTO);
    await expect(locked.getByTestId("your-files-summary")).toContainText("Deine Dateien: 1 Eintrag,");
    await expect(locked.getByTestId("file-row")).toHaveCount(0);
    await axe(locked, '[data-testid="your-files"]');
    await locked.getByTestId("your-files-all").check();
    await locked.getByTestId("your-files-delete").click();
    await locked.getByRole("dialog").getByRole("button", { name: "Löschen" }).click();
    await expect(locked.getByTestId("your-files-row")).toHaveCount(0, CRYPTO);
    await expect(row(page, "bobs-notiz.txt")).toHaveCount(0, CRYPTO);
    await locked.context().close();
    await bobPage.context().close();

    // Deleting the channel: typed confirmation, what happens to the files.
    await page.goto(`/rooms/${roomId}/settings/channels?channel=${channelId}`);
    await expect(page.getByTestId("files-encryption-fixed")).toContainText("Ende-zu-Ende-verschlüsselt.");
    await page.getByRole("button", { name: "Channel löschen" }).click();
    const dialog = page.getByRole("dialog");
    const facts = dialog.getByTestId("files-deletion-facts");
    await expect(facts).toContainText("Gespeichert auf diesem Node.");
    await expect(facts).toContainText("Alle Dateien werden endgültig gelöscht.");
    await expect(facts).toContainText("2 Dateien, 1 Ordner");
    await expect(dialog.getByTestId("files-keep-external")).toHaveCount(0);
    await axe(page, '[role="dialog"]');
    const confirm = dialog.getByRole("button", { name: "Endgültig löschen" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill("tresor");
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    void alice;
  });
});
