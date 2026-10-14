// SPDX-License-Identifier: Apache-2.0
// Room administration without refetch cascades (tavrn-web#153): the client writes the node's answer and the realtime
// payloads into its cached room, so one admin action costs at most one `GET /rooms/{id}` (role changes, which can
// move the viewer's own permissions, refetch once; channels, categories and overrides never), for the admin and for a
// member watching the room, and the result is on screen.
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { scaled } from "./timeouts";

/** Counts the page's `GET /api/v1/rooms/{roomId}` requests. */
function roomGets(page: Page, roomId: string) {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() === "GET" && new URL(req.url()).pathname === `/api/v1/rooms/${roomId}`) count++;
  });
  return () => count;
}

/** Runs `action` (which waits for its visible result), then waits past the refetch debounce; returns the room GETs. */
async function measure(gets: Array<() => number>, page: Page, action: () => Promise<void>): Promise<number[]> {
  const before = gets.map((g) => g());
  await action();
  await page.waitForTimeout(1500);
  return gets.map((g, i) => g() - before[i]!);
}

test("admin actions cost at most one room refetch, for the admin and a watching member", async ({ browser, page, request }) => {
  test.setTimeout(scaled(120_000));
  const owner = await registerViaApi(request, "own");
  const member = await registerViaApi(request, "mem");
  const room = await createRoomViaApi(request, owner.token, "Verwaltung");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const role = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/roles`, { headers: auth, data: { name: "Helfer", position: 1, permissions: "0" } })).json();
  const channel = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/channels`, { headers: auth, data: { kind: "text", name: "werkstatt" } })).json();
  const join = await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, owner.token, room.id)}/join`, { headers: { Authorization: `Bearer ${member.token}` }, data: {} });
  expect(join.ok()).toBeTruthy();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginAs(memberPage, member);
  await memberPage.goto(`/rooms/${room.id}`);
  await expect(memberPage.getByTestId("channel-name")).toBeVisible();
  const memberGets = roomGets(memberPage, room.id);

  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/roles`);
  await expect(page.getByTestId("role-list")).toBeVisible();
  const ownerGets = roomGets(page, room.id);
  const gets = [ownerGets, memberGets];

  // A role: saved, shown; one refetch at most (the role may change the viewer's own permissions).
  await page.getByTestId("role-list").getByRole("button", { name: "Helfer", exact: true }).click();
  await page.locator(`#role-${role.id}-ADD_REACTIONS`).check();
  const roleSave = await measure(gets, page, async () => {
    await page.getByTestId("role-editor").getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Rolle gespeichert" })).toBeVisible();
  });
  await expect(page.locator(`#role-${role.id}-ADD_REACTIONS`)).toBeChecked();
  expect(roleSave[0]).toBeLessThanOrEqual(1);
  expect(roleSave[1]).toBeLessThanOrEqual(1);

  // A category: no refetch at all; the member's sidebar learns it from the event.
  await page.goto(`/rooms/${room.id}/settings/channels`);
  await expect(page.getByRole("textbox", { name: "Neue Kategorie" })).toBeVisible();
  const ownerGetsChannels = roomGets(page, room.id);
  const gets2 = [ownerGetsChannels, memberGets];
  const category = await measure(gets2, page, async () => {
    await page.getByRole("textbox", { name: "Neue Kategorie" }).fill("Werkzeug");
    await page.getByRole("textbox", { name: "Neue Kategorie" }).press("Enter");
    await expect(page.getByTestId("category-permissions").filter({ hasText: "Werkzeug" })).toBeVisible();
  });
  expect(category).toEqual([0, 0]);

  // A channel override: no refetch.
  await page.locator("button", { hasText: "werkstatt" }).first().click();
  await page.getByTestId("override-tristate").locator("[data-permission='ADD_REACTIONS']").getByRole("radio", { name: /verbieten/ }).click();
  const override = await measure(gets2, page, async () => {
    await page.getByRole("button", { name: "Berechtigungen speichern", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Berechtigungen gespeichert" })).toBeVisible();
  });
  expect(override).toEqual([0, 0]);
  await expect(page.getByTestId("override-tristate").locator("[data-permission='ADD_REACTIONS']").getByRole("radio", { name: /verbieten/ })).toHaveAttribute("aria-checked", "true");

  // A channel from the sidebar dialog: no refetch; it shows up for the admin and the member.
  await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
  await expect(page.getByTestId("channel-name")).toHaveText("werkstatt");
  const ownerGetsRoom = roomGets(page, room.id);
  await openNavIfMobile(page);
  await page.getByRole("navigation", { name: "Channels" }).getByRole("button", { name: "Channel erstellen" }).click();
  await page.locator("input[name='channel_name']").fill("neu-hier");
  await openNavIfMobile(memberPage);
  const created = await measure([ownerGetsRoom, memberGets], page, async () => {
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen", exact: true }).click();
    await openNavIfMobile(page);
    await expect(page.getByTestId("channel-row").filter({ hasText: "neu-hier" })).toBeVisible();
    await expect(memberPage.getByTestId("channel-row").filter({ hasText: "neu-hier" })).toBeVisible();
  });
  expect(created).toEqual([0, 0]);
  await memberContext.close();
});
