// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startExampleBot } from "./bot-helpers";
import { NODE, createRoomViaApi, registerViaUi, tokenOf, uniqueName } from "./helpers";

// Bots and encrypted channels (design note 4.7, decided 2026-10-06; APPLICATIONS.md §3.5, §3.6): in a new room the example
// bot stays out of the encrypted channel until the channel's settings allow bots, then joins on its own; switching it
// off removes the bot's leaf. The welcome channel shows both changes; the room overview has the switch with its
// explanation, the role editor the "Manage applications" permission.

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const SEND_MESSAGES = 1n << 1n;

interface App {
  id: string;
  name: string;
  botUsername: string;
  secret: string;
}

async function createApp(request: APIRequestContext, token: string): Promise<App> {
  const name = uniqueName("Leser");
  const created = await request.post(`${NODE}/api/v1/applications`, { headers: auth(token), data: { name, public: false, requested_permissions: SEND_MESSAGES.toString() } });
  expect(created.status(), await created.text()).toBe(201);
  const app = await created.json();
  const t = await request.post(`${NODE}/api/v1/applications/${app.id}/tokens`, { headers: auth(token), data: { name: "example" } });
  expect(t.status(), await t.text()).toBe(201);
  return { id: app.id, name, botUsername: app.bot.username, secret: (await t.json()).secret };
}

/** The channel's MLS epoch as the owner sees it (0 = only the group's creator). */
async function epoch(request: APIRequestContext, token: string, channelId: string): Promise<number> {
  const resp = await request.get(`${NODE}/api/v1/conversations/${channelId}/mls/group-info`, { headers: auth(token) });
  return resp.ok() ? ((await resp.json()).epoch as number) : -1;
}

async function setBotsAllowed(page: Page, roomId: string, channelId: string, on: boolean) {
  await page.goto(`/rooms/${roomId}/settings/channels?channel=${channelId}`);
  const toggle = page.getByTestId("channel-bots-allowed");
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked({ checked: !on });
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: on });
}

test.describe("Bots in encrypted channels (design note 4.7)", () => {
  let bot: ChildProcess | null = null;
  test.afterEach(() => {
    if (bot && bot.exitCode === null) bot.kill("SIGTERM");
  });

  test("a new room keeps the bot out of the encrypted channel until the channel allows bots; the security log shows it", async ({ page, request }) => {
    test.setTimeout(180_000);
    await registerViaUi(page, { prefix: "botwave" });
    const token = await tokenOf(page);
    const app = await createApp(request, token);
    bot = await startExampleBot(app, test.info().outputPath("bot"));
    const room = await createRoomViaApi(request, token, "Geheimbund", "invite", { encrypted: true });
    expect(room.bots_in_encrypted_channels).toBe("per_channel");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const welcome = room.channels.find((c: { kind: string }) => c.kind === "system");
    const install = await request.post(`${NODE}/api/v1/rooms/${room.id}/applications`, { headers: auth(token), data: { application: `localhost/${app.id}`, permissions: SEND_MESSAGES.toString() } });
    expect(install.status(), await install.text()).toBe(201);

    // The browser creates the channel's group; the installed bot cannot join it.
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => epoch(request, token, channel.id), { timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(3000);
    expect(await epoch(request, token, channel.id)).toBe(0);
    const row = page.locator(`[data-testid="channel-row"][data-channel="${channel.id}"]`);
    await expect(row.getByTestId("bots-allowed-icon")).toHaveCount(0);
    await expect(row.getByTestId("no-bots-icon")).toHaveCount(0);

    // "Bots allowed" in the channel settings: the bot joins on its own.
    await setBotsAllowed(page, room.id, channel.id, true);
    await expect.poll(() => epoch(request, token, channel.id), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await page.goto(`/rooms/${room.id}/channels/${welcome.id}`);
    const added = page.locator('[data-testid="bot-event"][data-event="added"]');
    await expect(added).toBeVisible({ timeout: 20_000 });
    await expect(added).toContainText("verschlüsselten Channel #allgemein");
    await expect(added.getByTestId("bot-badge")).toBeVisible();
    await expect(page.locator(`[data-testid="channel-row"][data-channel="${channel.id}"]`).getByTestId("bots-allowed-icon")).toBeVisible();

    // Off again: the owner's browser removes the bot's leaf (it is no longer entitled); the log names the reason.
    await setBotsAllowed(page, room.id, channel.id, false);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });
    await expect
      .poll(
        async () => {
          const msgs = await (await request.get(`${NODE}/api/v1/conversations/${welcome.id}/messages?limit=50`, { headers: auth(token) })).json();
          return (msgs as Array<{ content: { type: string; reason?: string } }>).find((m) => m.content.type === "system.bot_removed")?.content.reason ?? null;
        },
        { timeout: 45_000 },
      )
      .toBe("bots_not_allowed");
    await page.goto(`/rooms/${room.id}/channels/${welcome.id}`);
    const removed = page.locator('[data-testid="bot-event"][data-event="removed"]');
    await expect(removed).toBeVisible({ timeout: 20_000 });
    await expect(removed).toHaveAttribute("data-reason", "bots_not_allowed");
    await expect(removed).toContainText("Bots sind in diesem Channel nicht mehr erlaubt");
  });

  test("the room switch explains the setting, and the role editor shows Manage applications", async ({ page, request }) => {
    await registerViaUi(page, { prefix: "botroom" });
    const token = await tokenOf(page);
    const room = await createRoomViaApi(request, token, "Schaltzentrale", "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");

    await page.goto(`/rooms/${room.id}/settings/overview`);
    const toggle = page.getByTestId("room-bots-encrypted");
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId("room-bots-encrypted-state")).toContainText("außer seine Einstellungen sagen „Bots erlaubt“");
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("room-bots-encrypted-state")).toContainText("Bots dürfen jedem verschlüsselten Channel beitreten");
    const detail = await (await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth(token) })).json();
    expect(detail.bots_in_encrypted_channels).toBe("allowed");
    expect(detail.channels.find((c: { id: string }) => c.id === channel.id).no_bots_effective).toBe(false);
    // In an "allowed" room the channel settings have no "Bots allowed" toggle.
    await page.goto(`/rooms/${room.id}/settings/channels?channel=${channel.id}`);
    await expect(page.getByTestId("channel-no-bots")).toBeVisible();
    await expect(page.getByTestId("channel-bots-allowed")).toHaveCount(0);
    await page.goto(`/rooms/${room.id}/settings/overview`);
    await page.getByTestId("room-bots-encrypted").click();
    await expect(page.getByTestId("room-bots-encrypted")).toBeChecked();

    // The role editor: "Anwendungen verwalten" with its hint, never for @everyone.
    await page.goto(`/rooms/${room.id}/settings/roles`);
    await page.getByTestId("role-list").getByRole("button", { name: "@everyone" }).click();
    const label = page.locator("label").filter({ has: page.locator('input[id$="-MANAGE_APPLICATIONS"]') });
    await expect(label).toContainText("Anwendungen verwalten");
    await expect(label.getByTestId("perm-hint-MANAGE_APPLICATIONS")).toContainText("Rollen verwalten");
    await expect(label).toHaveAttribute("data-restricted", "true");
    // The room's "Applications" tab is there for the owner.
    await page.goto(`/rooms/${room.id}/settings/applications`);
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/settings/applications`));
  });
});
