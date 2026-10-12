// SPDX-License-Identifier: Apache-2.0
// Upload policy in the client (PROTOCOL.md §7a, permissions.md "Upload categories", docs/CLIENT.md "File types"):
// a role limited to images cannot attach a text file, a channel override allows documents again; an uploaded program
// is only saved after the warning ("This file can run programs on your computer"). The editors and the dialog are
// checked with axe.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";
import { B, FEDERATION_BROWSER, NODE_B, WEB_B, chromiumOnly, loginOn } from "./federation-helpers";
import { scaled } from "./timeouts";

async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

// The download warning runs on b.test, which allows executables (playwright.config.ts); its web origin needs the full
// Chromium build.
test.use(FEDERATION_BROWSER);
chromiumOnly();

const NOTES = { name: "notizen.txt", mimeType: "text/plain", buffer: Buffer.from("Hallo") };

test("a role limited to images cannot attach a text file; a channel override allows documents again", async ({ browser, page, request }) => {
  test.setTimeout(scaled(120_000));
  const owner = await registerViaApi(request, "upo");
  const member = await registerViaApi(request, "upm");
  const room = await createRoomViaApi(request, owner.token, "Dateitypen");
  const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const code = (await (await request.post(`${NODE}/api/v1/rooms/${room.id}/invites`, { headers: auth, data: {} })).json()).code as string;
  expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${member.token}` }, data: {} })).ok()).toBeTruthy();
  const team = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/categories`, { headers: auth, data: { name: "Team" } })).json();
  const role = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/roles`, { headers: auth, data: { name: "Zeichner", position: 1, permissions: "0" } })).json();
  expect((await request.patch(`${NODE}/api/v1/rooms/${room.id}/members/${member.userId}`, { headers: auth, data: { roles: [role.id] } })).ok()).toBeTruthy();

  // The owner limits the role to images in the role editor.
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/roles`);
  await page.getByTestId("role-list").getByRole("button", { name: "Zeichner", exact: true }).click();
  const uploads = page.getByTestId("role-uploads");
  await expect(uploads.getByRole("checkbox", { name: /Nicht festgelegt/ })).toBeChecked();
  await uploads.getByRole("checkbox", { name: /Nicht festgelegt/ }).uncheck();
  for (const name of ["Audio", "Videos", "Dokumente", "Archive", "Andere Dateien"]) await uploads.getByRole("checkbox", { name, exact: true }).uncheck();
  await expect(uploads.getByRole("checkbox", { name: "Bilder", exact: true })).toBeChecked();
  await axe(page, "[data-testid='role-uploads']");
  await page.getByTestId("role-editor").getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rolle gespeichert" })).toBeVisible();

  // The member cannot attach a text file.
  const ctx = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: test.info().project.name.includes("mobile"), hasTouch: test.info().project.name.includes("mobile") });
  const memberPage = await ctx.newPage();
  await loginAs(memberPage, member);
  await memberPage.goto(`/rooms/${room.id}/channels/${channel.id}`);
  await memberPage.getByLabel("Datei auswählen").setInputFiles(NOTES);
  await expect(memberPage.getByTestId("upload-error")).toContainText("Dokumente dürfen hier nicht hochgeladen werden");

  // The channel allows documents for the role again; the editor shows the result for the role.
  await page.goto(`/rooms/${room.id}/settings/channels?channel=${channel.id}`);
  const editor = page.getByTestId("channel-editor");
  await editor.getByRole("combobox", { name: "Rolle" }).selectOption({ label: "Zeichner" });
  const block = editor.getByTestId("upload-overrides");
  await expect(block.getByTestId("inherited-upload-documents")).toHaveText("Geerbt: von den Rollen verboten");
  await block.getByRole("radio", { name: "Dokumente: erlauben" }).click();
  await expect(block.getByTestId("upload-effective")).toHaveText("Ergebnis für Zeichner: Bilder, Dokumente");
  await editor.getByRole("button", { name: "Berechtigungen speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Berechtigungen gespeichert" })).toBeVisible();
  await axe(page, "[data-testid='channel-editor']");
  await page.locator(`[data-testid='category-permissions'][data-category='${team.id}']`).click();
  await expect(page.getByTestId("category-editor").getByTestId("upload-overrides")).toBeVisible();
  await axe(page, "[data-testid='category-editor']");

  // Now the text file goes through.
  await memberPage.reload();
  await memberPage.getByLabel("Datei auswählen").setInputFiles(NOTES);
  await expect(memberPage.getByTestId("pending-uploads")).toContainText("notizen.txt");
  await expect(memberPage.getByTestId("upload-error")).toHaveCount(0);
  await memberPage.getByLabel("Nachricht", { exact: true }).fill("Die Notizen");
  await memberPage.keyboard.press("Enter");
  await expect(memberPage.getByTestId("message").filter({ hasText: "Die Notizen" })).toContainText("notizen.txt");
  await ctx.close();
});

test.describe("download warning", () => {
  test("an uploaded program asks before it is saved: cancel saves nothing, \"Download anyway\" saves", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    const owner = await registerViaApi(request, "exe", NODE_B);
    const room = await createRoomViaApi(request, owner.token, "Programme", "invite", { base: NODE_B });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await loginOn(page, WEB_B, owner, { domain: B, remote: false });
    await page.goto(`${WEB_B}/rooms/${room.id}/channels/${channel.id}`);
    // A tiny fake Windows program (an MZ header).
    await page.getByLabel("Datei auswählen").setInputFiles({ name: "setup.exe", mimeType: "application/x-msdownload", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) });
    await expect(page.getByTestId("pending-uploads")).toContainText("setup.exe");
    await expect(page.getByTestId("upload-error")).toHaveCount(0);
    await page.getByLabel("Nachricht", { exact: true }).fill("Das Programm");
    await page.keyboard.press("Enter");
    const message = page.getByTestId("message").filter({ hasText: "Das Programm" });
    await expect(message).toContainText("setup.exe");

    let downloads = 0;
    page.on("download", () => downloads++);
    await message.getByTestId("attachment-download").click();
    const dialog = page.getByRole("dialog", { name: "Diese Datei kann Programme auf deinem Computer ausführen" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("download-warning-name")).toHaveText("setup.exe");
    await expect(dialog.getByTestId("download-warning-kind")).toHaveText("Windows-Programm");
    // Cancel is the default (focused) action.
    await expect(dialog.getByTestId("download-warning-cancel")).toBeFocused();
    await axe(page, "[role='dialog']");
    await dialog.getByTestId("download-warning-cancel").click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);

    await message.getByTestId("attachment-download").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("download-warning-anyway").click();
    expect((await download).suggestedFilename()).toBe("setup.exe");
    expect(downloads).toBe(1);
  });
});
