// SPDX-License-Identifier: Apache-2.0
// Message components (tavrn-protocol/APPLICATIONS.md §5.10) with a real bot: fixtures/components-bot.ts runs on the
// installed @tavrn/bot against the e2e node and posts a raid card (buttons, a select, a link button) when mentioned.
// Sign up → an ephemeral reply under the card; Decline → the bot's error under the card; the class select → the card
// is updated in place; Note → the bot's modal → submit → a stored reply. The phone project checks that the card never
// overflows the message; axe-core scans the card and the open modal (WCAG 2.2 A/AA violations fail).
import type { ChildProcess } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { startExampleBot } from "./bot-helpers";
import { NODE, createRoomViaApi, registerViaUi, tokenOf, uniqueName } from "./helpers";
import { scaled } from "./timeouts";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const SEND_MESSAGES = 1n << 1n;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

interface App {
  id: string;
  name: string;
  botUsername: string;
  secret: string;
}

async function createApp(request: APIRequestContext, token: string): Promise<App> {
  const name = uniqueName("Raid");
  const created = await request.post(`${NODE}/api/v1/applications`, { headers: auth(token), data: { name, public: false, requested_permissions: SEND_MESSAGES.toString() } });
  expect(created.status(), await created.text()).toBe(201);
  const app = await created.json();
  const t = await request.post(`${NODE}/api/v1/applications/${app.id}/tokens`, { headers: auth(token), data: { name: "components" } });
  expect(t.status(), await t.text()).toBe(201);
  return { id: app.id, name, botUsername: app.bot.username, secret: (await t.json()).secret };
}

/** No WCAG 2.2 A/AA violation inside `selector`. */
async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Nothing of the message sticks out of it, and the page itself never scrolls sideways. */
async function expectNoOverflow(page: Page, message: Locator) {
  const sizes = await message.evaluate((el) => {
    const area = el.querySelector<HTMLElement>("[data-testid=message-components]")!;
    const box = el.getBoundingClientRect();
    const controls = [...area.querySelectorAll<HTMLElement>("button")].map((b) => b.getBoundingClientRect());
    return {
      bubble: { scroll: el.scrollWidth, client: el.clientWidth },
      area: { scroll: area.scrollWidth, client: area.clientWidth },
      outside: controls.filter((r) => r.left < box.left - 0.5 || r.right > box.right + 0.5).length,
      page: { scroll: document.documentElement.scrollWidth, width: window.innerWidth },
    };
  });
  expect(sizes.bubble.scroll).toBeLessThanOrEqual(sizes.bubble.client);
  expect(sizes.area.scroll).toBeLessThanOrEqual(sizes.area.client);
  expect(sizes.outside).toBe(0);
  expect(sizes.page.scroll).toBeLessThanOrEqual(sizes.page.width);
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

test.describe("Message components (APPLICATIONS.md §5.10)", () => {
  let bot: ChildProcess | null = null;
  test.afterEach(() => {
    if (bot && bot.exitCode === null) bot.kill("SIGTERM");
  });

  test("buttons, a select and a modal of a bot's message, inside the message on every screen", async ({ page, request }) => {
    test.setTimeout(scaled(180_000));
    const user = await registerViaUi(page, { prefix: "raider" });
    const local = user.address.split("@")[0]!;
    const token = await tokenOf(page);
    const app = await createApp(request, token);
    bot = await startExampleBot(app, test.info().outputPath("bot"), "fixtures/components-bot.ts");
    const room = await createRoomViaApi(request, token, "Raid-Kneipe");

    // Install through the add link's consent screen (APPLICATIONS.md §4.1).
    await page.goto(`/add/${app.id}`);
    const consent = page.getByTestId("add-app-consent");
    await consent.locator(`[data-testid="add-app-room"][data-room="${room.id}"]`).getByRole("radio").check();
    await consent.getByTestId("add-app-install").click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/settings/applications`));

    await page.goto(`/rooms/${room.id}`);
    await send(page, `@${app.botUsername} raid please`);
    const card = page.getByTestId("message").filter({ hasText: "Raid on Friday 20:00" }).filter({ has: page.getByTestId("message-components") });
    await expect(card).toBeVisible({ timeout: scaled(30_000) });
    await expect(card.getByTestId("bot-badge")).toBeVisible();
    const signup = card.getByRole("button", { name: "Sign up" });
    await expect(signup).toHaveAttribute("data-style", "success");
    await expect(card.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-disabled", "true");
    await expect(card.getByRole("button", { name: /Guide/ })).toHaveAttribute("aria-haspopup", "dialog");
    // The long label is cut with an ellipsis and keeps its full text as the tooltip.
    const note = card.getByRole("button", { name: /Note for the raid lead/ });
    await expect(note).toHaveAttribute("title", "Note for the raid lead with a rather long label");
    await expectNoOverflow(page, card);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `test-results/components/${test.info().project.name}-card.png`, animations: "disabled" });
    await axe(page, `[data-message-id="${await card.getAttribute("data-message-id")}"]`);

    // Sign up → an ephemeral reply under the card, only for this user.
    await signup.click();
    const notices = card.getByTestId("message-notices");
    await expect(notices.getByTestId("interaction-ephemeral")).toContainText(`You are signed up, ${local}.`, { timeout: scaled(15_000) });
    await expect(notices).toContainText("Nur du siehst das");
    const stored = await (await request.get(`${NODE}/api/v1/conversations/${room.channels.find((c: { kind: string }) => c.kind === "text").id}/messages?limit=20`, { headers: auth(token) })).json();
    expect(JSON.stringify(stored)).not.toContain("You are signed up");

    // Decline → the bot's error under the card.
    await card.getByRole("button", { name: "Decline" }).click();
    await expect(notices.getByTestId("interaction-error")).toContainText("Declining is not possible any more.", { timeout: scaled(15_000) });

    // The class select (a listbox) → the bot updates the card in place.
    const trigger = card.getByTestId("component-select-trigger");
    await trigger.click();
    const list = card.getByRole("listbox", { name: "Your class" });
    await expect(list).toBeFocused();
    await expect(list.getByRole("option", { name: /Tank/ })).toContainText("Holds the line in front");
    await expectNoOverflow(page, card);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const updated = page.getByTestId("message").filter({ hasText: "class: healer" });
    await expect(updated).toBeVisible({ timeout: scaled(15_000) });
    await expect(updated.getByTestId("message-components")).toBeVisible();
    await expect(updated).toContainText("bearbeitet");

    // The link button asks first and names the full URL.
    await updated.getByRole("button", { name: /Guide/ }).click();
    const link = page.getByRole("dialog", { name: "Externen Link öffnen?" });
    await expect(link.getByTestId("component-link-url")).toHaveText("https://guide.example/raid");
    await link.getByRole("button", { name: "Abbrechen" }).click();
    await expect(link).toBeHidden();

    // Note → the bot's modal → submit → a stored reply that names the user and the application.
    await updated.getByRole("button", { name: /Note for the raid lead/ }).click();
    const dialog = page.getByRole("dialog", { name: "A note for the raid lead" });
    await expect(dialog).toBeVisible({ timeout: scaled(15_000) });
    await expect(dialog.getByTestId("bot-badge")).toBeVisible();
    const field = dialog.getByLabel("Note");
    await expect(field).toBeFocused();
    // Required and empty: the error is said at the field, nothing is sent.
    await dialog.getByTestId("component-modal-submit").click();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await axe(page, '[role="dialog"]');
    await field.fill("Bringing food");
    await dialog.getByTestId("component-modal-submit").click();
    await expect(dialog).toBeHidden({ timeout: scaled(15_000) });
    const reply = page.getByTestId("message").filter({ hasText: `Note from ${local}: Bringing food` });
    await expect(reply).toBeVisible({ timeout: scaled(15_000) });
    await expect(reply.getByTestId("message-interaction")).toHaveAttribute("data-kind", "component");
  });
});
