// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startExampleBot } from "./bot-helpers";
import { NODE, createRoomViaApi, registerViaUi, tokenOf, uniqueName } from "./helpers";
import { scaled } from "./timeouts";

// The SDK bot runtime, phase 5 step 5 (tavrn-protocol/APPLICATIONS.md §3, §5, §11): the example bot
// (fixtures/echo-bot.ts, the echo-weather example of tavrn-js on the installed @tavrn/bot) runs as a child process against the e2e node, is installed through the add link's
// consent screen, joins the encrypted channel's group on its own, echoes a message that mentions it (with the BOT
// badge) and answers `/weather` picked from the `/` palette.

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const SEND_MESSAGES = 1n << 1n;

interface App {
  id: string;
  name: string;
  botUsername: string;
  secret: string;
}

async function createApp(request: APIRequestContext, token: string): Promise<App> {
  const name = uniqueName("Echo");
  const created = await request.post(`${NODE}/api/v1/applications`, { headers: auth(token), data: { name, public: false, requested_permissions: SEND_MESSAGES.toString() } });
  expect(created.status(), await created.text()).toBe(201);
  const app = await created.json();
  const t = await request.post(`${NODE}/api/v1/applications/${app.id}/tokens`, { headers: auth(token), data: { name: "example" } });
  expect(t.status(), await t.text()).toBe(201);
  return { id: app.id, name, botUsername: app.bot.username, secret: (await t.json()).secret };
}

function stop(child: ChildProcess | null) {
  if (child && child.exitCode === null) child.kill("SIGTERM");
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

test.describe("Bot runtime (APPLICATIONS.md §11 step 5)", () => {
  let bot: ChildProcess | null = null;
  test.afterEach(() => stop(bot));

  test("the example bot echoes in an encrypted channel and answers /weather from the palette", async ({ page, request }) => {
    test.setTimeout(scaled(180_000));
    const user = await registerViaUi(page, { prefix: "botfan" });
    const token = await tokenOf(page);
    const app = await createApp(request, token);
    bot = await startExampleBot(app, test.info().outputPath("bot"));
    const room = await createRoomViaApi(request, token, "Bot-Kneipe", "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    // New rooms keep bots out of encrypted channels unless the channel allows them (design note 4.7).
    const allow = await request.patch(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}`, { headers: auth(token), data: { bots_allowed: true } });
    expect(allow.status(), await allow.text()).toBe(200);

    // Install through the add link's consent screen (APPLICATIONS.md §4.1).
    await page.goto(`/add/${app.id}`);
    const consent = page.getByTestId("add-app-consent");
    await expect(consent.getByTestId("add-app-name")).toHaveText(app.name);
    await consent.locator(`[data-testid="add-app-room"][data-room="${room.id}"]`).getByRole("radio").check();
    await expect(consent.getByTestId("add-app-e2ee")).toBeVisible();
    await consent.getByTestId("add-app-install").click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/settings/applications`));

    // The browser creates the channel's group when it opens the channel; the bot joins by external commit.
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });
    await expect
      .poll(async () => (await (await request.get(`${NODE}/api/v1/conversations/${channel.id}/mls/group-info`, { headers: auth(token) })).json()).epoch, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("ghost-warning")).toHaveCount(0);

    // Echo: the bot answers a message that mentions it, encrypted, with the BOT badge.
    await send(page, `@${app.botUsername} Prost zusammen`);
    const echo = page.getByTestId("message").filter({ hasText: "Echo: Prost zusammen" });
    await expect(echo).toBeVisible({ timeout: 30_000 });
    await expect(echo.getByTestId("bot-badge")).toBeVisible();
    // The node only holds ciphertext.
    const stored = await (await request.get(`${NODE}/api/v1/conversations/${channel.id}/messages?limit=20`, { headers: auth(token) })).json();
    expect(JSON.stringify(stored)).not.toContain("Prost");

    // `/weather` from the palette: encrypted arguments, answered by the example bot's command handler.
    const box = page.getByLabel("Nachricht", { exact: true });
    await box.fill("/wea");
    const option = page.locator(`[data-testid="command-option"][data-source="app"][data-name="weather"]`);
    await expect(option).toBeVisible({ timeout: 15_000 });
    await expect(option.getByTestId("bot-badge")).toBeVisible();
    await option.click();
    await expect(box).toHaveValue("/weather ");
    await box.pressSequentially("Bonn");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    const reply = page.getByTestId("message").filter({ hasText: "Weather in Bonn:" });
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(reply).toContainText("canned forecast");
    await expect(reply.getByTestId("message-interaction")).toContainText("/weather");
    expect(user.address).toContain("@");
  });
});
