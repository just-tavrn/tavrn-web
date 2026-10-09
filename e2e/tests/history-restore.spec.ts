// SPDX-License-Identifier: Apache-2.0
// History restore after a key reset (protocol ENCRYPTION.md §7b "History after a key reset"): a member who reset their
// security key does not get the old messages automatically; they ask, a member with `restore_history` approves (which
// shares the keys from their device) or denies with a reason, and the welcome channel records the decision. The banner
// and the History requests page are scanned with axe (serious and critical WCAG violations fail).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, confirmRecoveryKey, loginViaUi, openNavIfMobile, openRoomInvite, registerViaUi, tokenOf, type UiAccount } from "./helpers";

const CRYPTO = { timeout: 30_000 };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

async function closeDrawers(page: Page) {
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (!(await overlay.isVisible())) return;
  const members = (await page.getByTestId("members-drawer").getAttribute("data-open")) === "true";
  await overlay.click({ position: { x: members ? 8 : (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
}

async function send(page: Page, text: string) {
  await closeDrawers(page);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 15_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(message(page, text)).toBeVisible();
}

async function getJson(page: Page, path: string) {
  const resp = await page.request.get(`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json();
}

/** Serious and critical WCAG violations of the current page fail the test. */
async function scan(page: Page, screen: string) {
  await page.waitForTimeout(400);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.impact} ${v.id} @ ${screen}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

/**
 * Alice's encrypted room (default policy `since_join`) with a message from before Bob's join; Bob joins, greets (so
 * that his device is in the group before Alice writes) and reads two of Alice's messages, then loses his device and
 * resets his key on a new one. Returns Bob's new page.
 */
async function resetScenario(browser: Browser, page: Page, name: string) {
  await registerViaUi(page, { prefix: "alice" });
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Raum erstellen" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  await expect(page.getByTestId("encrypted-marker")).toBeVisible();
  const url = page.url();
  const roomId = url.split("/rooms/")[1]!.split("/")[0]!;
  await send(page, "Vor Bobs Beitritt");
  await openRoomInvite(page);
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.getByRole("button", { name: "Fertig" }).click();
  await closeDrawers(page);

  const bobPage = await newPage(browser);
  const bob: UiAccount = await registerViaUi(bobPage, { prefix: "bob" });
  await bobPage.goto(link);
  await bobPage.getByRole("button", { name: "Beitreten" }).click();
  await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");
  await send(bobPage, "Hallo von Bob");
  await expect(message(page, "Hallo von Bob")).toBeVisible(CRYPTO);
  await send(page, "Für Bob vor dem Reset");
  await send(page, "Noch eine für Bob");
  await expect(message(bobPage, "Für Bob vor dem Reset")).toBeVisible(CRYPTO);
  await expect(message(bobPage, "Noch eine für Bob")).toBeVisible(CRYPTO);
  await bobPage.context().close();

  // Bob lost his device and his recovery key: a reset on a new device.
  const bob2 = await newPage(browser);
  await loginViaUi(bob2, bob);
  await bob2.getByRole("button", { name: /Identität zurücksetzen/ }).click();
  await bob2.getByLabel("Passwort", { exact: true }).fill(bob.password);
  await bob2.getByRole("button", { name: "Weiter", exact: true }).click();
  await confirmRecoveryKey(bob2, "Identität zurücksetzen");
  await expect(bob2.getByTestId("app-shell")).toBeVisible();
  await bob2.goto(url);
  await expect(bob2.getByTestId("channel-name")).toHaveText("allgemein");
  return { url, roomId, bob, bob2 };
}

async function welcomeEntries(page: Page, roomId: string) {
  const room = await getJson(page, `/rooms/${roomId}`);
  const welcome = room.channels.find((c: { kind: string }) => c.kind === "system").id as string;
  await page.goto(`/rooms/${roomId}/channels/${welcome}`);
  return page.getByTestId("restore-event");
}

test.describe("History restore after a key reset", () => {
  test("the member asks, the owner verifies and approves, the member reads the old messages again", async ({ browser, page }) => {
    test.setTimeout(300_000);
    const { roomId, bob, bob2 } = await resetScenario(browser, page, "Archiv");

    // Nothing from before the reset comes back by itself: the banner explains it and offers the request.
    const banner = bob2.getByTestId("history-restore-banner");
    await expect(banner).toBeVisible(CRYPTO);
    await expect(banner).toContainText("Deine älteren verschlüsselten Nachrichten sind gesperrt");
    await send(bob2, "Bob nach dem Reset");
    await expect(message(bob2, "Für Bob vor dem Reset")).toHaveCount(0);
    await expect(message(bob2, "Noch eine für Bob")).toHaveCount(0);
    await scan(bob2, "history restore banner");
    await banner.getByTestId("history-restore-ask").click();
    await banner.getByTestId("history-restore-message").fill("Ich bin es, ruf mich an");
    await banner.getByTestId("history-restore-send").click();
    await expect(banner.getByTestId("history-restore-status")).toContainText("Warte auf die Moderation");

    // Alice is notified and decides in the room settings.
    await expect(page.getByTestId("history-request-toast")).toBeVisible(CRYPTO);
    await page.goto(`/rooms/${roomId}/settings/history`);
    const card = page.getByTestId("history-request");
    await expect(card).toContainText(bob.address);
    await expect(card.getByTestId("history-request-message")).toHaveText("Ich bin es, ruf mich an");
    await expect(page.getByTestId("history-verify-advice")).toBeVisible();
    await expect(card.getByTestId("history-plan")).toBeVisible(CRYPTO);
    await scan(page, "history requests");
    await expect(card.getByTestId("history-approve")).toBeDisabled();
    await card.getByTestId("history-verified").check();
    await card.getByTestId("history-approve").click();
    await expect(page.getByTestId("history-requests-empty")).toBeVisible(CRYPTO);

    // Bob's history from his join on is readable again; what was before his join stays out (since_join).
    await expect(message(bob2, "Für Bob vor dem Reset")).toBeVisible(CRYPTO);
    await expect(message(bob2, "Noch eine für Bob")).toBeVisible(CRYPTO);
    await expect(bob2.getByTestId("history-restore-banner")).toHaveCount(0);
    // Only Bob's own greeting stays unverifiable: its device's attestation went with the old key (ENCRYPTION.md §9).
    await expect(bob2.getByTestId("undecryptable")).toHaveCount(1, CRYPTO);
    await expect(message(bob2, "Vor Bobs Beitritt")).toHaveCount(0);

    // The security log names the decision.
    const entries = await welcomeEntries(bob2, roomId);
    await expect(entries.filter({ hasText: "wiederhergestellt" })).toHaveCount(1, CRYPTO);
    await bob2.context().close();
  });

  test("a denied request keeps the history locked and tells the member why", async ({ browser, page }) => {
    test.setTimeout(300_000);
    const { url, roomId, bob2 } = await resetScenario(browser, page, "Tresor");
    const banner = bob2.getByTestId("history-restore-banner");
    await banner.getByTestId("history-restore-ask").click();
    await banner.getByTestId("history-restore-send").click();
    await expect(banner.getByTestId("history-restore-status")).toBeVisible();

    await page.goto(`/rooms/${roomId}/settings/history`);
    const card = page.getByTestId("history-request");
    await card.getByTestId("history-deny-open").click();
    await card.getByTestId("history-deny-reason").fill("Bitte erst anrufen");
    await card.getByTestId("history-deny").click();
    await expect(page.getByTestId("history-requests-empty")).toBeVisible(CRYPTO);

    await expect(banner.getByTestId("history-restore-denied")).toContainText("Bitte erst anrufen", CRYPTO);
    await expect(message(bob2, "Für Bob vor dem Reset")).toHaveCount(0);
    // The welcome channel records the denial without the reason.
    const entries = await welcomeEntries(bob2, roomId);
    await expect(entries.filter({ hasText: "abgelehnt" })).toHaveCount(1, CRYPTO);
    await expect(entries).not.toContainText("Bitte erst anrufen");
    await bob2.goto(url);
    await expect(bob2.getByTestId("history-restore-banner")).toBeVisible(CRYPTO);
    await bob2.context().close();
  });
});
