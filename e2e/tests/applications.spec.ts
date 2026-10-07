// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi, uniqueName, type Account } from "./helpers";
import { openMembers } from "./menu-helpers";

// Applications and bots, phase 5 step 1 (tavrn-protocol/APPLICATIONS.md §1–§3): the owner side in the user settings,
// the token shown once, the BOT badge and "no bots" zones. Installations (step 2) are in app-install.spec.ts.

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The owner (a room manager) installs the bot (APPLICATIONS.md §4.2) with permission to write. */
async function botJoins(request: APIRequestContext, owner: Account, roomId: string, appId: string) {
  const installed = await request.post(`${NODE}/api/v1/rooms/${roomId}/applications`, { headers: auth(owner.token), data: { application: `localhost/${appId}`, permissions: "0" } });
  expect(installed.status(), await installed.text()).toBe(201);
}

/** Reads the secret from the shown-once dialog and closes it; the secret is gone from the page afterwards. */
async function takeSecret(page: import("@playwright/test").Page): Promise<string> {
  const field = page.getByTestId("token-secret");
  await expect(field).toBeVisible();
  const secret = await field.inputValue();
  expect(secret.split(".")).toHaveLength(3);
  await page.getByTestId("token-secret-done").click();
  await expect(page.getByTestId("token-secret")).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);
  return secret;
}

test.describe("Applications and bots (APPLICATIONS.md, phase 5 step 1)", () => {
  test("create an application, see the token once, reset it, BOT badge, no-bots zones, delete", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bot = uniqueName("wetter");
    const botAddress = `${bot}@localhost`;
    const room = await createRoomViaApi(request, owner.token, "Bot-Raum");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");

    await loginAs(page, owner);
    await page.goto("/settings/applications");
    await page.getByTestId("app-name").fill(bot);
    await page.getByTestId("app-create").click();
    const row = page.getByTestId("application-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("bot-badge")).toBeVisible();
    await expect(row).toContainText(botAddress);
    await expect(page.getByTestId("application-editor")).toBeVisible();

    // A token: the secret is shown exactly once.
    await page.getByTestId("token-name").fill("prod");
    await page.getByTestId("token-create").click();
    const first = await takeSecret(page);
    await expect(page.getByTestId("token-row")).toHaveCount(1);
    const me = await request.get(`${NODE}/api/v1/users/me`, { headers: auth(first) });
    expect(me.status()).toBe(200);
    expect((await me.json()).kind).toBe("bot");

    // Reset: a new secret, the old one stops working at once.
    await page.getByTestId("token-reset").click();
    const secret = await takeSecret(page);
    expect(secret).not.toBe(first);
    expect((await request.get(`${NODE}/api/v1/users/me`, { headers: auth(first) })).status()).toBe(401);
    expect((await request.get(`${NODE}/api/v1/users/me`, { headers: auth(secret) })).status()).toBe(200);

    // The bot joins the room and writes: the BOT badge in the member list and on its message.
    const apps = await request.get(`${NODE}/api/v1/applications`, { headers: auth(owner.token) });
    const appId = (await apps.json())[0].id as string;
    await botJoins(request, owner, room.id, appId);
    const sent = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: auth(secret), data: { content: { type: "text", body: "Morgen Sonne" } } });
    expect(sent.status()).toBe(201);
    await page.goto(`/rooms/${room.id}`);
    const message = page.getByTestId("message").filter({ hasText: "Morgen Sonne" });
    await expect(message.getByTestId("bot-badge")).toBeVisible();
    await openMembers(page);
    await expect(page.locator(`[data-testid="member-row"][data-address="${botAddress}"]`).getByTestId("bot-badge")).toBeVisible();

    // "No bots" on the channel: marked in the settings and the channel list, invisible to the bot.
    await page.goto(`/rooms/${room.id}/settings/channels?channel=${channel.id}`);
    await page.getByTestId("channel-no-bots").click();
    await expect(page.getByTestId("channel-no-bots")).toBeChecked();
    await expect(page.getByTestId("no-bots-icon").first()).toBeVisible();
    const seen = await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth(secret) });
    expect(seen.status()).toBe(200);
    expect((await seen.json()).channels.map((c: { id: string }) => c.id)).not.toContain(channel.id);
    expect((await request.get(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: auth(secret) })).status()).toBe(403);
    expect((await request.get(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: auth(owner.token) })).status()).toBe(200);

    // "No bots" for the whole room: the confirmation names the bots that leave.
    await page.goto(`/rooms/${room.id}/settings/overview`);
    await page.getByTestId("room-no-bots").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("1");
    await dialog.getByRole("button").last().click();
    await expect(page.getByTestId("room-no-bots")).toBeChecked();
    expect((await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth(secret) })).status()).toBe(403);

    // Delete the application: type its name to confirm; the token is dead, the list is empty.
    await page.goto("/settings/applications");
    await page.getByTestId("application-row").click();
    await page.getByTestId("app-delete").click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("textbox").fill(bot);
    await confirm.getByRole("button").last().click();
    await expect(page.getByTestId("application-row")).toHaveCount(0);
    expect((await request.get(`${NODE}/api/v1/users/me`, { headers: auth(secret) })).status()).toBe(401);
  });
});
