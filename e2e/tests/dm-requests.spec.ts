// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, type Account } from "./helpers";

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

async function openMembers(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) !== "true") await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
}

/** Opens the profile card of `username` from the member list of the room. */
async function openProfile(page: Page, roomId: string, username: string) {
  await page.goto(`/rooms/${roomId}`);
  await openMembers(page);
  await page.getByTestId("member-list").getByTestId("profile-trigger").filter({ hasText: username }).click();
  return page.getByTestId("profile-popover");
}

async function join(request: Page["request"], token: string, code: string) {
  const r = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${token}` }, data: {} });
  expect(r.ok()).toBeTruthy();
}

test.describe("Message requests", () => {
  test("Non-friend from a shared room: request, read, accept, regular DM; decline with block and note", async ({ browser, page, request }) => {
    test.setTimeout(240_000);
    const alice = await registerViaUi(page, { prefix: "alice" });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    const room = await createRoomViaApi(request, await tokenOf(page), "Treffpunkt");
    const code = await inviteCode(request, await tokenOf(page), room.id);
    await join(request, await tokenOf(bobPage), code);

    // Alice writes to bob from his profile card; for bob it is a message request.
    const card = await openProfile(page, room.id, bob.username);
    await card.getByTestId("profile-message").click();
    await expect(page.getByTestId("conversation-name")).toHaveText(bob.username);
    await send(page, "Hallo Bob, wir kennen uns aus dem Treffpunkt");

    await bobPage.goto("/");
    await openNavIfMobile(bobPage);
    await expect(bobPage.getByTestId("requests-count")).toHaveText("1");
    // Requests raise no unread count in the DM list.
    await expect(bobPage.getByTestId("dm-list")).not.toContainText(alice.username);
    await bobPage.getByTestId("requests-link").click();
    const item = bobPage.getByTestId("request").filter({ hasText: alice.address });
    await expect(item.getByTestId("request-shared")).toContainText("Treffpunkt");
    await item.getByTestId("request-open").click();
    await expect(message(bobPage, "wir kennen uns aus dem Treffpunkt")).toBeVisible({ timeout: 20_000 });
    await expect(bobPage.getByLabel("Nachricht", { exact: true })).toBeDisabled();
    await bobPage.getByTestId("request-banner").getByTestId("request-accept").click();
    await expect(bobPage).toHaveURL(/\/conversations\/[0-9A-Z]{26}$/);
    await send(bobPage, "Klar, hallo Alice!");
    await expect(message(page, "Klar, hallo Alice!")).toBeVisible({ timeout: 20_000 });

    // A second request (carol, over the API) is declined and blocked with a private note.
    const carol = await registerViaApi(request, "carol");
    await join(request, carol.token, code);
    const created = await request.post(`${NODE}/api/v1/conversations`, { headers: { Authorization: `Bearer ${carol.token}` }, data: { kind: "dm", members: [bob.username] } });
    expect(created.status()).toBe(201);
    await bobPage.goto("/requests");
    const carolItem = bobPage.getByTestId("request").filter({ hasText: `${carol.username}@localhost` });
    await carolItem.getByTestId("request-block").click();
    await bobPage.getByRole("dialog").getByLabel("Private Notiz (optional)").fill("Werbung");
    await bobPage.getByTestId("block-confirm").click();
    await expect(bobPage.getByTestId("request")).toHaveCount(0);
    await bobPage.goto("/settings/privacy");
    const blocked = bobPage.getByTestId("blocked-user").filter({ hasText: `${carol.username}@localhost` });
    await expect(blocked.getByTestId("blocked-reason")).toHaveText("Notiz: Werbung");
    await blocked.getByTestId("unblock").click();
    await expect(bobPage.getByTestId("blocked-user")).toHaveCount(0);
    await bobPage.context().close();
  });

  test("Friends only: notice with a friend request including a message, a regular DM after accepting", async ({ page, request }) => {
    test.setTimeout(180_000);
    const alice = await registerViaUi(page, { prefix: "alice" });
    const dave: Account = await registerViaApi(request, "dave");
    const auth = { Authorization: `Bearer ${dave.token}` };
    expect((await request.patch(`${NODE}/api/v1/users/me`, { headers: auth, data: { dm_policy: "friends" } })).ok()).toBeTruthy();
    const room = await createRoomViaApi(request, await tokenOf(page), "Gilde");
    await join(request, dave.token, await inviteCode(request, await tokenOf(page), room.id));

    const card = await openProfile(page, room.id, dave.username);
    await card.getByTestId("profile-message").click();
    const notice = card.getByTestId("dm-refused");
    await expect(notice).toContainText("nimmt Direktnachrichten nur von Freunden an");
    await notice.getByLabel("Nachricht (optional)").fill("Alice aus der Gilde");
    await notice.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Anfrage an" })).toBeVisible();

    const friends = await (await request.get(`${NODE}/api/v1/users/me/friends`, { headers: auth })).json();
    expect(friends.incoming[0].message).toBe("Alice aus der Gilde");
    expect(friends.incoming[0].user.address).toBe(alice.address);
    await request.post(`${NODE}/api/v1/users/me/friends/requests/${friends.incoming[0].id}/accept`, { headers: auth });

    const again = await openProfile(page, room.id, dave.username);
    await again.getByTestId("profile-message").click();
    await expect(page.getByTestId("conversation-name")).toHaveText(dave.username);
    const conv = await (await request.get(`${NODE}/api/v1/conversations`, { headers: auth })).json();
    expect(conv[0].pending).toEqual([]);
  });
});
