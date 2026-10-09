// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";

// Files channels (design note 4.13 item 9, tavrn-protocol/FILES.md): the whole browser flow in the web client.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const row = (page: Page, name: string) => page.getByTestId("file-row").filter({ has: page.locator(`[data-testid="file-open"]`, { hasText: name }) });

async function rowMenu(page: Page, name: string, item: string) {
  await row(page, name).getByTestId("file-menu-button").click();
  await page.getByTestId("files-menu").getByRole("menuitem", { name: item }).click();
}

test.describe("File channels", () => {
  test("create, upload, folders, rename, move, search, view, download, delete", async ({ page, request }) => {
    const owner = await registerViaApi(request, "files");
    const room = await createRoomViaApi(request, owner.token, "Ablage-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");

    // Create the files channel in the UI.
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Channel erstellen" }).click();
    const create = page.getByRole("dialog");
    await create.getByLabel("Art").selectOption("files");
    await create.getByLabel("Name", { exact: true }).fill("Ablage");
    // End-to-end encryption is the default for files channels; this test covers the unencrypted kind.
    await expect(create.getByTestId("files-encrypted-toggle")).toBeChecked();
    await create.getByTestId("files-encrypted-toggle").uncheck();
    await create.getByRole("button", { name: "Erstellen" }).click();
    await openNavIfMobile(page);
    const link = page.locator('[data-testid="channel-row"][data-kind="files"]').getByRole("link");
    await expect(link).toContainText("ablage");
    await expect(link.locator('[data-testid="channel-unlocked"]')).toBeVisible();
    await link.click();
    await expect(page.getByTestId("files-view")).toBeVisible();
    await expect(page.getByTestId("channel-name")).toHaveText("ablage");
    // Permanent banner, empty state, storage meter.
    await expect(page.getByTestId("files-banner")).toContainText("nicht Ende-zu-Ende-verschlüsselt");
    await expect(page.getByTestId("files-banner-external")).toHaveCount(0);
    await expect(page.getByTestId("files-empty")).toBeVisible();
    await expect(page.getByTestId("files-usage-text")).toContainText("0 B");
    // Phones: list only (no grid toggle).
    const phone = (page.viewportSize()?.width ?? 1280) < 768;
    await expect(page.getByTestId("files-view-toggle")).toHaveCount(phone ? 0 : 1);

    // Upload with the button (hidden input) and show progress until done.
    await page.getByTestId("files-upload-input").setInputFiles([
      { name: "pixel.png", mimeType: "image/png", buffer: PNG },
      { name: "notizen.txt", mimeType: "text/plain", buffer: Buffer.from("Einkaufsliste: Brot") },
    ]);
    await expect(row(page, "pixel.png")).toBeVisible();
    await expect(row(page, "notizen.txt")).toBeVisible();
    await expect(page.getByTestId("upload-item")).toHaveCount(2);
    await expect(page.getByTestId("upload-item").and(page.locator('[data-status="done"]'))).toHaveCount(2);
    await expect(page.getByTestId("files-usage-text")).not.toContainText("0 B");

    // New folder.
    await page.getByTestId("files-new-folder").click();
    await page.getByTestId("files-name-input").fill("Dokumente");
    await page.getByTestId("files-name-submit").click();
    await expect(page.getByTestId("file-row").first()).toHaveAttribute("data-name", "Dokumente");

    // Rename through the context menu.
    await rowMenu(page, "notizen.txt", "Umbenennen");
    await page.getByTestId("files-name-input").fill("liste.txt");
    await page.getByTestId("files-name-submit").click();
    await expect(row(page, "liste.txt")).toBeVisible();
    await expect(row(page, "notizen.txt")).toHaveCount(0);

    // Move into the folder with the move dialog.
    await rowMenu(page, "liste.txt", "Verschieben …");
    const move = page.getByTestId("files-move-dialog");
    await move.locator('[data-testid="move-folder"][data-name="Dokumente"]').click();
    await move.getByTestId("files-move-here").click();
    await expect(row(page, "liste.txt")).toHaveCount(0);

    // Open the folder: breadcrumbs and the moved file.
    await row(page, "Dokumente").getByTestId("file-open").click();
    await expect(page.getByTestId("files-breadcrumbs")).toContainText("Dokumente");
    await expect(row(page, "liste.txt")).toBeVisible();
    await page.getByTestId("files-crumb").first().click();
    await expect(row(page, "pixel.png")).toBeVisible();

    // Search across the channel.
    await page.getByTestId("files-search").fill("LISTE");
    await expect(page.getByTestId("files-search-results")).toBeVisible();
    await expect(page.getByTestId("file-row")).toHaveCount(1);
    await expect(row(page, "liste.txt")).toBeVisible();
    await page.getByTestId("files-search").fill("gibtsnicht");
    await expect(page.getByTestId("files-empty")).toBeVisible();
    await page.getByTestId("files-search").fill("");
    await expect(row(page, "pixel.png")).toBeVisible();

    // Images open in the media viewer.
    await row(page, "pixel.png").getByTestId("file-open").click();
    await expect(page.getByTestId("media-viewer")).toBeVisible();
    await expect(page.getByTestId("viewer-image")).toBeVisible();
    await page.getByTestId("viewer-close").click();
    await expect(page.getByTestId("media-viewer")).toHaveCount(0);

    // Download through the menu.
    const download = page.waitForEvent("download");
    await rowMenu(page, "pixel.png", "Herunterladen");
    expect((await download).suggestedFilename()).toBe("pixel.png");

    // The node serves downloads as attachments, never sniffed.
    const channelId = new URL(page.url()).pathname.split("/").pop()!;
    const list = await (await request.get(`${NODE}/api/v1/rooms/${room.id}/channels/${channelId}/files`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
    const png = list.entries.find((e: { name: string }) => e.name === "pixel.png");
    const resp = await request.get(`${NODE}/api/v1/rooms/${room.id}/channels/${channelId}/files/${png.id}/download`, { headers: { Authorization: `Bearer ${owner.token}`, Range: "bytes=0-7" } });
    expect(resp.status()).toBe(206);
    expect(resp.headers()["content-disposition"]).toMatch(/^attachment/);
    expect(resp.headers()["x-content-type-options"]).toBe("nosniff");

    // Delete the folder with everything inside (confirmation).
    await rowMenu(page, "Dokumente", "Löschen");
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByTestId("files-delete-text")).toContainText("Dokumente");
    await confirm.getByRole("button", { name: "Löschen" }).click();
    await expect(row(page, "Dokumente")).toHaveCount(0);
    await expect(page.getByTestId("file-row")).toHaveCount(1);
    await expect(page.getByTestId("files-meter")).toContainText("1 Dateien, 0 Ordner");
  });

  test("Dragging in uploads, keyboard and multi-selection, storage in the channel settings", async ({ page, request }) => {
    const owner = await registerViaApi(request, "filesdnd");
    const room = await createRoomViaApi(request, owner.token, "Drop-Raum");
    const auth = { Authorization: `Bearer ${owner.token}` };
    const ch = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/channels`, { headers: auth, data: { kind: "files", name: "drop", encrypted: false } })).json();
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${ch.id}`);
    await expect(page.getByTestId("files-view")).toBeVisible();
    // The channel's rights are loaded (a real drag repeats dragover; the test sends it once).
    await expect(page.getByTestId("files-upload-button")).toBeVisible();

    // Drag and drop of files from the desktop.
    const data = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["a"], "eins.txt", { type: "text/plain" }));
      dt.items.add(new File(["bb"], "zwei.txt", { type: "text/plain" }));
      dt.items.add(new File(["ccc"], "drei.txt", { type: "text/plain" }));
      return dt;
    });
    await page.getByTestId("files-list").dispatchEvent("dragover", { dataTransfer: data });
    await expect(page.getByTestId("files-drop-zone")).toBeVisible();
    await page.getByTestId("files-list").dispatchEvent("drop", { dataTransfer: data });
    await expect(page.getByTestId("file-row")).toHaveCount(3);

    // Keyboard: focus the list, move, extend with Shift, delete the selection.
    const list = page.getByTestId("files-list");
    await list.focus();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("file-row").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator('[data-testid="file-row"][aria-selected="true"]')).toHaveCount(2);
    await expect(page.getByTestId("files-meter")).toContainText("2 ausgewählt");
    await page.keyboard.press("Delete");
    await page.getByRole("dialog").getByRole("button", { name: "Löschen" }).click();
    await expect(page.getByTestId("file-row")).toHaveCount(1);
    await expect(page.getByTestId("file-row")).toHaveAttribute("data-name", "zwei.txt");

    // Channel settings: storage section (external storage is off on the test node), no encryption toggle.
    await page.goto(`/rooms/${room.id}/settings/channels?channel=${ch.id}`);
    const storage = page.getByTestId("files-storage");
    await expect(storage).toBeVisible();
    await expect(storage.getByTestId("files-storage-kind")).toHaveValue("internal");
    await expect(storage.locator('option[value="webdav"]')).toBeDisabled();
    await expect(page.getByTestId("encrypted-toggle")).toHaveCount(0);
    await expect(page.getByTestId("files-encryption-fixed")).toContainText("Nicht Ende-zu-Ende-verschlüsselt.");
  });
});
