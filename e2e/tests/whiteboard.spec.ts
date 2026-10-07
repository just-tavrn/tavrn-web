// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { openNavIfMobile, registerViaUi } from "./helpers";

// Whiteboard (design note 4.10, tavrn-protocol/WHITEBOARD.md): two users in an encrypted channel. The board is
// state-synced through encrypted ephemeral events; the owner's device is the source of truth.

const STILL = readFileSync(new URL("../fixtures/still.png", import.meta.url));

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  return page;
}

async function createRoomInUi(page: Page, name: string): Promise<string> {
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Raum erstellen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Erstellen" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  return page.url();
}

async function inviteLink(page: Page): Promise<string> {
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Einladen" }).click();
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.getByRole("button", { name: "Fertig" }).click();
  return link;
}

/** Alice with a new encrypted room and Bob as a member, both on the channel. Returns the channel URL. */
async function twoInARoom(browser: Browser, page: Page): Promise<{ bob: Page; channelUrl: string }> {
  page.on("dialog", (d) => void d.accept());
  await registerViaUi(page, { prefix: "wbalice", displayName: "Alice" });
  const channelUrl = await createRoomInUi(page, "Raidgilde");
  const link = await inviteLink(page);
  const bob = await newPage(browser);
  await registerViaUi(bob, { prefix: "wbbob", displayName: "Bob" });
  await bob.goto(link);
  await bob.getByRole("button", { name: "Beitreten" }).click();
  await expect(bob.getByTestId("channel-name")).toHaveText("allgemein");
  return { bob, channelUrl };
}

const board = (page: Page) => page.getByTestId("whiteboard-board");
const canvas = (page: Page) => page.getByTestId("whiteboard-canvas");

async function canvasPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await canvas(page).boundingBox())!;
  return [box.x + x, box.y + y];
}

/** Excalidraw's rectangle tool: drag from one point to another. */
async function drawRectangle(page: Page, from: [number, number], to: [number, number]) {
  await page.getByTestId("toolbar-rectangle").click({ force: true });
  const [x1, y1] = await canvasPoint(page, ...from);
  const [x2, y2] = await canvasPoint(page, ...to);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
}

async function typeText(page: Page, at: [number, number], text: string) {
  await page.getByTestId("toolbar-text").click({ force: true });
  const [x, y] = await canvasPoint(page, ...at);
  await page.mouse.click(x, y);
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

/** Opens a board action: inline on wide screens, in the "⋯" menu on narrower ones. */
async function action(page: Page, name: string) {
  const inline = page.getByRole("button", { name, exact: true });
  if (await inline.isVisible()) return inline.click();
  await page.getByRole("button", { name: "Whiteboard-Menü" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test.describe("Whiteboard", () => {
  test("presents live, gates editing, keeps scenes, takes a background, exports, shares and closes", async ({ browser, page }) => {
    test.skip(test.info().project.name !== "chromium", "the full flow runs on the desktop; phones are covered below");
    test.setTimeout(300_000);
    const { bob, channelUrl } = await twoInARoom(browser, page);

    // Alice opens the board from the channel header; Bob sees that a board is live and joins on demand.
    await page.goto(channelUrl);
    await page.getByTestId("whiteboard-button").click();
    await page.getByRole("button", { name: "Whiteboard öffnen" }).click();
    await expect(board(page)).toHaveAttribute("data-role", "owner");
    await expect(page.getByTestId("whiteboard-role")).toContainText("Du präsentierst");
    await expect(bob.getByTestId("whiteboard-button")).toHaveAttribute("data-live", "true", { timeout: 20_000 });
    await bob.getByTestId("whiteboard-button").click();
    await expect(bob.getByText("Alice präsentiert ein Whiteboard")).toBeVisible();
    await bob.getByRole("button", { name: "Whiteboard-Sitzung beitreten" }).click();
    await expect(board(bob)).toHaveAttribute("data-role", "viewer");
    await expect(canvas(bob)).toHaveAttribute("data-editable", "false");

    // Alice draws a rectangle and writes; Bob sees both live, but has no tools.
    await drawRectangle(page, [360, 140], [520, 240]);
    await typeText(page, [640, 180], "Raid um 20 Uhr");
    await expect(board(page)).toHaveAttribute("data-elements", "2");
    await expect(board(bob)).toHaveAttribute("data-elements", "2", { timeout: 20_000 });
    await expect(bob.getByTestId("whiteboard-texts")).toContainText("Raid um 20 Uhr");
    await expect(bob.getByTestId("toolbar-rectangle")).toHaveCount(0);
    await expect(page.getByTestId("whiteboard-role")).toContainText("1 schauen zu");

    // Open for everyone: Bob adds a shape, Alice gets it through her own re-broadcast.
    await action(page, "Wer bearbeiten darf");
    await page.getByRole("dialog").getByRole("button", { name: "Für alle öffnen" }).click();
    await expect(canvas(bob)).toHaveAttribute("data-editable", "true", { timeout: 20_000 });
    await expect(board(bob)).toHaveAttribute("data-role", "editor");
    await drawRectangle(bob, [380, 340], [500, 420]);
    await expect(board(page)).toHaveAttribute("data-elements", "3", { timeout: 20_000 });
    await expect(board(bob)).toHaveAttribute("data-elements", "3");
    // Lock again: Bob is a viewer once more.
    await page.getByRole("dialog").getByRole("button", { name: "Sperren" }).click();
    await expect(canvas(bob)).toHaveAttribute("data-editable", "false", { timeout: 20_000 });
    await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();

    // Scene library: save, clear the board, reload, load the scene again (for everyone).
    await action(page, "Szenen");
    await page.getByRole("dialog").getByLabel("Name der Szene").fill("Raidplan");
    await page.getByRole("dialog").getByRole("button", { name: "Szene speichern" }).click();
    await expect(page.getByTestId("scene-list")).toContainText("Raidplan");
    await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
    const [ex, ey] = await canvasPoint(page, 900, 500);
    await page.mouse.click(ex, ey);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await expect(board(page)).toHaveAttribute("data-elements", "0");
    await expect(board(bob)).toHaveAttribute("data-elements", "0", { timeout: 20_000 });
    await page.reload();
    await expect(board(page)).toHaveAttribute("data-role", "owner", { timeout: 30_000 });
    await action(page, "Szenen");
    await page.getByTestId("scene").filter({ hasText: "Raidplan" }).getByRole("button", { name: "Laden" }).click();
    await expect(board(page)).toHaveAttribute("data-elements", "3");
    await expect(board(bob)).toHaveAttribute("data-elements", "3", { timeout: 20_000 });
    await expect(bob.getByTestId("whiteboard-texts")).toContainText("Raid um 20 Uhr");

    // A background image through the media pipeline, inserted at the back for everyone.
    await action(page, "Hintergrund");
    await page.getByRole("dialog").getByLabel("Hintergrundbild").setInputFiles({ name: "map.png", mimeType: "image/png", buffer: STILL });
    await expect(board(page)).toHaveAttribute("data-images", "1", { timeout: 30_000 });
    await expect(board(bob)).toHaveAttribute("data-images", "1", { timeout: 30_000 });
    await expect(board(page)).toHaveAttribute("data-elements", "4");

    // Save as image: a PNG download.
    await action(page, "Als Bild speichern");
    const download = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("button", { name: "PNG", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/^whiteboard-.*\.png$/);

    // Share to channel: the PNG lands as an encrypted image attachment that both see.
    await action(page, "In Channel teilen");
    await page.getByRole("dialog").getByRole("button", { name: /# allgemein/ }).click();
    await expect(page.getByText("Bild in # allgemein geteilt")).toBeVisible({ timeout: 30_000 });
    for (const p of [page, bob]) {
      await p.getByRole("link", { name: "Zurück" }).click();
      const shared = p.getByTestId("message").filter({ hasText: "Whiteboard" });
      await expect(shared.getByTestId("attachment-image").locator("img")).toBeVisible({ timeout: 30_000 });
    }

    // Closing ends the session for the viewer.
    await page.getByTestId("whiteboard-button").click();
    await bob.getByTestId("whiteboard-button").click();
    await bob.getByRole("button", { name: "Whiteboard-Sitzung beitreten" }).click();
    await expect(board(bob)).toHaveAttribute("data-elements", "4", { timeout: 20_000 });
    await action(page, "Board schließen");
    await expect(bob.getByTestId("whiteboard-ended")).toHaveText("Das Whiteboard wurde geschlossen.", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Whiteboard öffnen" })).toBeVisible();
  });

  test("phones: open a board, join it, pan and zoom, view only", async ({ browser, page }) => {
    test.skip(test.info().project.name !== "mobile-android", "phone layout");
    test.setTimeout(240_000);
    const { bob, channelUrl } = await twoInARoom(browser, page);
    await page.goto(`${channelUrl}/whiteboard`);
    await page.getByRole("button", { name: "Whiteboard öffnen" }).click();
    await expect(board(page)).toHaveAttribute("data-role", "owner");
    // The board's actions collapse into a menu on phones.
    await expect(page.getByRole("button", { name: "Whiteboard-Menü" })).toBeVisible();
    await drawRectangle(page, [60, 120], [200, 220]);
    await expect(board(page)).toHaveAttribute("data-elements", "1");

    await bob.goto(`${channelUrl}/whiteboard`);
    await bob.getByRole("button", { name: "Whiteboard-Sitzung beitreten" }).click();
    await expect(board(bob)).toHaveAttribute("data-elements", "1", { timeout: 20_000 });
    await expect(canvas(bob)).toHaveAttribute("data-editable", "false");
    await expect(bob.getByTestId("toolbar-rectangle")).toHaveCount(0);

    // Pan (view mode drags the canvas) and zoom; the view is per device, the board unchanged.
    await expect(canvas(bob)).toHaveAttribute("data-zoom", "1.00");
    const scroll = await canvas(bob).getAttribute("data-scroll");
    const [x, y] = await canvasPoint(bob, 150, 300);
    await bob.mouse.move(x, y);
    await bob.mouse.down();
    await bob.mouse.move(x + 80, y + 120, { steps: 6 });
    await bob.mouse.up();
    await expect(canvas(bob)).not.toHaveAttribute("data-scroll", scroll ?? "");
    await bob.keyboard.down("Control");
    await bob.mouse.wheel(0, -300);
    await bob.keyboard.up("Control");
    await expect(canvas(bob)).not.toHaveAttribute("data-zoom", "1.00");
    await expect(board(page)).toHaveAttribute("data-elements", "1");
    await expect(board(bob)).toHaveAttribute("data-elements", "1");
  });
});
