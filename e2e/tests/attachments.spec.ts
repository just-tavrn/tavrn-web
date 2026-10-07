// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.svgRan = true</script><rect width="10" height="10"/></svg>');
const PNG =Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.describe("Attachments, Markdown, reactions, pins", () => {
  test("Upload and send an image, render Markdown, react and pin", async ({ page, request }) => {
    const owner = await registerViaApi(request, "att");
    const room = await createRoomViaApi(request, owner.token, "Datei-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");

    await page.getByLabel("Datei auswählen").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("pending-uploads")).toContainText("pixel.png");
    await page.getByLabel("Nachricht", { exact: true }).fill("Schau **mal**: `code`");
    await page.keyboard.press("Enter");
    const message = page.getByTestId("message").filter({ hasText: "Schau" });
    await expect(message).toBeVisible();
    await expect(message.locator("strong")).toHaveText("mal");
    await expect(message.locator("code")).toHaveText("code");
    await expect(message.getByTestId("attachment-image").locator("img")).toBeVisible();
    await expect(page.getByTestId("pending-uploads")).toHaveCount(0);

    await message.hover();
    await message.getByRole("button", { name: "Reagieren" }).click();
    await page.getByRole("menuitem", { name: "🔥" }).click();
    await expect(message.getByRole("button", { name: "🔥 1" })).toHaveAttribute("aria-pressed", "true");
    await message.getByRole("button", { name: "🔥 1" }).click();
    await expect(message.getByTestId("reactions")).toHaveCount(0);

    await message.hover();
    await message.getByRole("button", { name: "Anpinnen", exact: true }).click();
    await expect(message.getByLabel("Angepinnt")).toBeVisible();
    await page.getByRole("button", { name: "Angepinnte Nachrichten" }).click();
    await expect(page.getByTestId("pin-panel")).toContainText("Schau");
  });

  test("SVG is only a download, never an embedded image (design note 4.12)", async ({ page, request }) => {
    const owner = await registerViaApi(request, "svg");
    const room = await createRoomViaApi(request, owner.token, "SVG-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await page.getByLabel("Datei auswählen").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: SVG });
    await expect(page.getByTestId("pending-uploads")).toContainText("logo.svg");
    await page.getByLabel("Nachricht", { exact: true }).fill("Ein Logo");
    await page.keyboard.press("Enter");
    const message = page.getByTestId("message").filter({ hasText: "Ein Logo" });
    const file = message.getByTestId("attachment-file");
    await expect(file).toContainText("logo.svg");
    await expect(message.getByTestId("attachment-image")).toHaveCount(0);
    await expect(message.locator("img")).toHaveCount(0);
    // A click on the row opens nothing; only the download icon saves the file.
    let popups = 0;
    page.on("popup", () => popups++);
    await file.click();
    const download = page.waitForEvent("download");
    await file.getByTestId("attachment-download").click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("logo.svg");
    expect(popups).toBe(0);
    // The node serves it as an attachment only.
    const blobs = await (await request.get(`${NODE}/api/v1/conversations/${room.channels.find((c: { kind: string }) => c.kind === "text").id}/messages`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
    const att = blobs.find((m: { attachments: unknown[] }) => m.attachments?.length).attachments[0];
    expect(att.mime).toBe("image/svg+xml");
    const resp = await request.get(`${NODE}/api/v1/blobs/${att.id}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(resp.headers()["content-disposition"]).toMatch(/^attachment/);
    expect(resp.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("A file type outside the node rules is rejected", async ({ page, request }) => {
    const owner = await registerViaApi(request, "att");
    const room = await createRoomViaApi(request, owner.token, "Typ-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await page.getByLabel("Datei auswählen").setInputFiles({ name: "script.sh", mimeType: "application/x-sh", buffer: Buffer.from("echo") });
    await expect(page.getByTestId("pending-uploads")).toContainText("nicht erlaubt");
    await expect(page.getByRole("button", { name: "Senden" })).toBeDisabled();
  });
});
