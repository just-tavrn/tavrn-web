// SPDX-License-Identifier: Apache-2.0
// Folders in the room rail (docs/CLIENT.md "Room rail and folders"): the menus (right-click, long press on touch),
// expand and collapse, the mention badge of a collapsed folder, deleting; with a mouse, HTML5 drag and drop
// (Playwright's dragTo drives the browser's native drag events in Chromium). axe scans the rail with a folder
// collapsed and expanded (serious and critical WCAG violations fail, as in a11y.spec.ts).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, railName } from "./helpers";
import { isTouch, joinRoom, openContextMenu, postMessage } from "./menu-helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** axe on the rail only: serious and critical WCAG violations fail. */
async function scanRail(page: Page, screen: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include('[data-testid="room-rail"]').withTags(TAGS).analyze();
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id} @ ${screen}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

test.describe("Room rail folders", () => {
  test("create a folder from the rail's menu, move a room in, collapse and expand, the mention badge, delete it", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    await createRoomViaApi(request, alice.token, "Taverne");
    const guild = await createRoomViaApi(request, alice.token, "Gilde");
    await createRoomViaApi(request, alice.token, "Markt");
    await joinRoom(request, alice, guild.id, bob);
    const channelId = guild.channels.find((c: { kind: string }) => c.kind === "text").id as string;

    await loginAs(page, alice);
    await page.goto("/");
    await expect(page.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready");
    await openNavIfMobile(page);
    const rail = page.getByTestId("room-rail");
    await expect(rail.getByRole("link", { name: railName("Gilde") })).toBeVisible();

    // The empty rail's menu: a new folder with a name and a colour.
    await openContextMenu(page, rail.getByTestId("rail-end"));
    await page.getByTestId("rail-menu").getByRole("menuitem", { name: "Neuer Ordner…" }).click();
    const dialog = page.getByTestId("folder-dialog");
    await dialog.getByLabel("Name").fill("Gilden");
    await dialog.getByText("Violett").click();
    await dialog.getByRole("button", { name: "Ordner erstellen" }).click();
    const folder = rail.getByTestId("rail-folder-button");
    await expect(folder).toHaveAccessibleName("Ordner Gilden, 0 Räume");

    // A room's menu moves it into the folder (the room's own entries stay).
    await openContextMenu(page, rail.getByRole("link", { name: railName("Gilde") }));
    const roomMenu = page.getByTestId("room-menu");
    await expect(roomMenu.getByRole("menuitem", { name: "Raum verlassen" })).toBeVisible();
    await roomMenu.getByRole("menuitem", { name: "In Ordner verschieben" }).click();
    await page.getByTestId("context-submenu").getByRole("menuitem", { name: "Gilden" }).click();
    // (The room's system messages already count as unread: with the node's default level "all messages" as a
    // count, "Ordner Gilden, 1 Raum, 1 ungelesen"; with "only mentions" as "Ungelesene Nachrichten".)
    await expect(folder).toHaveAccessibleName(/^Ordner Gilden, 1 Raum(, Ungelesene Nachrichten|, \d+ ungelesen)?$/);
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await expect(rail.getByRole("link", { name: railName("Gilde") })).toHaveCount(0);
    await scanRail(page, "folder collapsed");

    // A mention in a room of the collapsed folder: the folder carries the mention badge.
    await postMessage(request, bob.token, channelId, `@${alice.username} Treffen?`, { mentions: [`${alice.username}@localhost`] });
    await expect(folder.getByTestId("rail-mention-badge")).toHaveText("1");
    await expect(folder).toHaveAccessibleName("Ordner Gilden, 1 Raum, 1 Erwähnungen");

    // Expand: the rooms follow as a nested list; collapse again.
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    const inside = rail.getByRole("list", { name: "Räume in Gilden" });
    await expect(inside.getByRole("link", { name: railName("Gilde") })).toBeVisible();
    await expect(inside.getByTestId("rail-mention-badge")).toHaveText("1");
    await scanRail(page, "folder expanded");
    await folder.click();
    await expect(inside).toHaveCount(0);

    // Kept on this device.
    await page.reload();
    await openNavIfMobile(page);
    await expect(rail.getByTestId("rail-folder-button")).toHaveAccessibleName(/^Ordner Gilden, 1 Raum/);

    // Delete: the room is back at the top level.
    await openContextMenu(page, rail.getByTestId("rail-folder-button"));
    await page.getByTestId("folder-menu").getByRole("menuitem", { name: "Ordner löschen" }).click();
    await expect(rail.getByTestId("rail-folder")).toHaveCount(0);
    await expect(rail.getByRole("link", { name: railName("Gilde") })).toBeVisible();
  });

  test("with a mouse: drop a room onto a room, onto a folder, out of it and between entries", async ({ page, request }) => {
    test.skip(isTouch(), "touch devices use the menus (nothing is draggable there)");
    const alice = await registerViaApi(request, "alice");
    for (const name of ["Ahorn", "Birke", "Eiche"]) await createRoomViaApi(request, alice.token, name);
    await loginAs(page, alice);
    await page.goto("/");
    await openNavIfMobile(page);
    const rail = page.getByTestId("room-rail");
    const link = (name: string) => rail.getByRole("link", { name, exact: true });
    const order = () => rail.getByTestId("rail-list").locator(":scope > li").evaluateAll((items) => items.map((li) => (li.getAttribute("data-testid") === "rail-folder" ? `[${li.querySelector("button")!.getAttribute("title")}]` : li.querySelector("a")!.getAttribute("aria-label"))));
    await expect.poll(order).toEqual(["Ahorn", "Birke", "Eiche"]);

    // A room onto the middle of another: a folder of both, named after its rooms until it gets a name.
    await link("Eiche").dragTo(link("Ahorn"));
    await expect.poll(order).toEqual(["[Ahorn, Eiche]", "Birke"]);
    const folder = rail.getByTestId("rail-folder-button");
    // Onto the folder: added.
    await link("Birke").dragTo(folder);
    await expect.poll(order).toEqual(["[Ahorn, Eiche, Birke]"]);
    // Out of the expanded folder onto the empty rail: back on the top level.
    await folder.click();
    await link("Ahorn").dragTo(rail.getByTestId("rail-end"));
    await expect.poll(order).toEqual(["[Eiche, Birke]", "Ahorn"]);
    // Onto the upper edge of the folder: placed before it (the drop indicator shows the place while dragging).
    await link("Ahorn").dragTo(folder, { targetPosition: { x: 24, y: 3 } });
    await expect.poll(order).toEqual(["Ahorn", "[Eiche, Birke]"]);
  });
});
