// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, type Account } from "./helpers";

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
    test.setTimeout(90_000);
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
});
