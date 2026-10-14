// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, type Account } from "./helpers";
import { scaled } from "./timeouts";

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function befriend(request: Page["request"], a: Account, b: Account) {
  await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${a.token}` }, data: { user: b.username } });
  const r = await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${b.token}` }, data: { user: a.username } });
  expect((await r.json()).status).toBe("accepted");
}

async function openMembers(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) !== "true") await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
}

/** Picks a status in the presence menu of the footer card. */
async function choose(page: Page, status: "online" | "dnd" | "invisible") {
  await openNavIfMobile(page);
  await page.getByTestId("presence-menu-button").click();
  await page.getByTestId(`presence-${status}`).click();
}

test.describe("Presence", () => {
  test("Status, custom status and invisible are visible live to friends and room members", async ({ browser, page, request }) => {
    test.setTimeout(scaled(90_000));
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    await befriend(request, alice, bob);
    const room = await createRoomViaApi(request, alice.token, "Lobby");
    const code = await inviteCode(request, alice.token, room.id);
    await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${bob.token}` }, data: {} });

    const bobPage = await newPage(browser);
    await loginAs(bobPage, bob);
    await bobPage.goto(`/rooms/${room.id}`);
    await loginAs(page, alice);
    await page.goto("/");

    await openMembers(bobPage);
    const aliceEntry = bobPage.getByTestId("member-list").getByTestId("profile-trigger").filter({ hasText: alice.username });
    const dot = aliceEntry.getByTestId("presence-dot");
    await expect(dot).toHaveAttribute("data-status", "online");

    // Do not disturb, seen by the friend in another browser.
    await choose(page, "dnd");
    await expect(page.getByTestId("presence-menu-button")).toHaveAttribute("data-status", "dnd");
    await expect(dot).toHaveAttribute("data-status", "dnd");

    // A custom status shows under the name.
    await page.getByTestId("presence-menu-button").click();
    await page.getByTestId("presence-custom").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Was gibt's?").fill("Im Raid bis 22 Uhr");
    await dialog.getByRole("button", { name: "Speichern" }).click();
    await expect(aliceEntry.getByTestId("member-status-line")).toHaveText("Im Raid bis 22 Uhr");

    // Invisible: offline for everyone else, but alice sees her real status.
    await choose(page, "invisible");
    await expect(dot).toHaveAttribute("data-status", "offline");
    await expect(aliceEntry.getByTestId("member-status-line")).toHaveCount(0);
    await expect(page.getByTestId("presence-menu-button")).toHaveAttribute("data-status", "invisible");

    // Back online; bob's friends page shows the dot too.
    await choose(page, "online");
    await expect(dot).toHaveAttribute("data-status", "online");
    await bobPage.goto("/friends");
    await expect(bobPage.getByTestId("friends-list").getByTestId("presence-dot")).toHaveAttribute("data-status", "online");
    await bobPage.context().close();
  });

  test("the account menu stays inside the sidebar without a horizontal scrollbar (tavrn-web#115)", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    await loginAs(page, alice);
    await page.goto("/");
    await expect(page.getByTestId("me-name")).toBeVisible();
    await openNavIfMobile(page);
    await page.getByTestId("presence-menu-button").click();
    const menu = page.getByTestId("presence-menu");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const sidebar = (await page.getByRole("complementary", { name: "Channels" }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(sidebar.x);
    expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 0.5);
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      const aside = document.querySelector("aside[aria-label=Channels]")!;
      return { page: d.scrollWidth - d.clientWidth, sidebar: aside.scrollWidth - aside.clientWidth };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.sidebar).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});
