// SPDX-License-Identifier: Apache-2.0
// Polls and date polls (PROTOCOL.md §7g): a choice poll in an end-to-end encrypted channel voted on by two members
// (results, voters, a changed vote, closing early), and a date poll in a plaintext channel created with /poll (the
// calendar, all-day and timed slots, answers, the best slot, the grid of answers, votes refused after the close).
// axe-core checks the composer and the poll views; the phone project checks the calendar's layout.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, openRoomInvite, registerViaApi, registerViaUi } from "./helpers";
import { expectInsideViewport, joinRoom } from "./menu-helpers";
import { scaled } from "./timeouts";

/** No WCAG 2.2 AA violation inside `selector`. */
async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function createRoomInUi(page: Page, name: string): Promise<string> {
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Raum erstellen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Erstellen" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  return page.url();
}

async function inviteLink(page: Page): Promise<string> {
  await openRoomInvite(page);
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.getByRole("button", { name: "Fertig" }).click();
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (await overlay.isVisible()) await overlay.click({ position: { x: (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
  return link;
}

async function composerReady(page: Page) {
  await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: scaled(30_000) });
}

const pollIn = (page: Page, question: string) => page.getByTestId("poll").filter({ hasText: question });
const option = (poll: Locator, id: string) => poll.locator(`[data-testid="poll-option"][data-option="${id}"]`);

/** `YYYY-MM-DD` of the 10th and 11th of next month (always in the future, never today). */
function nextMonthDays(): [string, string] {
  const d = new Date();
  const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  const m = String(((d.getMonth() + 1) % 12) + 1).padStart(2, "0");
  return [`${y}-${m}-10`, `${y}-${m}-11`];
}

test.describe("Polls", () => {
  test("encrypted channel: a choice poll, two members vote, change the vote, the author closes it", async ({ browser, page }) => {
    test.setTimeout(scaled(240_000));
    await registerViaUi(page, { prefix: "alice" });
    const roomUrl = await createRoomInUi(page, "Umfrageraum");
    const link = await inviteLink(page);
    const bob = await newPage(browser);
    await registerViaUi(bob, { prefix: "bob" });
    await bob.goto(link);
    await bob.getByRole("button", { name: "Beitreten" }).click();
    await expect(bob.getByTestId("channel-name")).toHaveText("allgemein");

    await page.goto(roomUrl);
    await composerReady(page);
    await page.getByTestId("composer-plus").click();
    await page.getByTestId("plus-poll").click();
    const dialog = page.getByRole("dialog", { name: "Umfrage erstellen" });
    await dialog.getByLabel("Frage", { exact: true }).fill("Wohin gehen wir?");
    await dialog.getByLabel("Antwort 1", { exact: true }).fill("Küche");
    await dialog.getByLabel("Antwort 1", { exact: true }).press("Enter");
    await dialog.getByLabel("Antwort 2", { exact: true }).fill("Garten");
    await dialog.getByLabel("Antwort 3", { exact: true }).fill("Keller");
    await dialog.getByRole("button", { name: "Antwort 3 entfernen" }).click();
    await dialog.getByText("1 Tag", { exact: true }).click();
    await axe(page, "[data-testid='poll-composer']");
    await dialog.getByTestId("poll-create").click();
    await expect(dialog).toBeHidden();

    const poll = pollIn(page, "Wohin gehen wir?");
    await expect(poll).toBeVisible({ timeout: scaled(20_000) });
    await expect(poll.getByTestId("poll-kind")).toHaveText("📊 Umfrage");
    await expect(poll.getByTestId("poll-closes")).toHaveText(/^Endet in \d+ Stunden$/);
    await expect(poll.getByTestId("poll-voters")).toHaveText("0 Stimmen");

    // Bob reads the encrypted poll and votes.
    const bobPoll = pollIn(bob, "Wohin gehen wir?");
    await expect(bobPoll).toBeVisible({ timeout: scaled(30_000) });
    await option(bobPoll, "o2").getByRole("radio").check();
    await bobPoll.getByTestId("poll-vote").click();
    await expect(option(bobPoll, "o2")).toHaveAttribute("data-mine", "true");
    await expect(poll.getByTestId("poll-voters")).toHaveText("1 Stimme", { timeout: scaled(20_000) });
    await expect(option(poll, "o2").getByTestId("poll-count")).toHaveText("1 · 100 %");

    // Alice votes too; both see two votes.
    await option(poll, "o1").getByRole("radio").check();
    await poll.getByTestId("poll-vote").click();
    await expect(option(poll, "o1")).toHaveAttribute("data-mine", "true");
    await expect(bobPoll.getByTestId("poll-voters")).toHaveText("2 Stimmen", { timeout: scaled(20_000) });
    await expect(option(bobPoll, "o1").getByTestId("poll-option-voters")).toBeVisible();

    // Bob changes his vote.
    await option(bobPoll, "o1").getByRole("radio").check();
    await bobPoll.getByRole("button", { name: "Stimme ändern" }).click();
    await expect(option(poll, "o1").getByTestId("poll-count")).toHaveText("2 · 100 %", { timeout: scaled(20_000) });
    await expect(option(poll, "o2").getByTestId("poll-count")).toHaveText("0 · 0 %");
    await axe(page, "[data-testid='poll']");

    // The author closes the poll early: nobody can vote any more.
    page.on("dialog", (d) => void d.accept());
    await poll.getByTestId("poll-close-now").click();
    await expect(poll.getByTestId("poll-closed")).toBeVisible();
    await expect(bobPoll.getByTestId("poll-closed")).toBeVisible({ timeout: scaled(20_000) });
    await expect(bobPoll.getByTestId("poll-vote")).toHaveCount(0);
    await expect(option(bobPoll, "o1").getByRole("radio")).toBeDisabled();
    await bob.context().close();
  });

  test("plaintext channel: a date poll from /poll with two slots, answers, the best slot, closed against late votes", async ({ browser, page, request }) => {
    test.setTimeout(scaled(180_000));
    const alice = await registerViaApi(request, "alice");
    const bobAccount = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Terminraum");
    await joinRoom(request, alice, room.id, bobAccount);
    const channelId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "text")!.id;
    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    await composerReady(page);

    const box = page.getByLabel("Nachricht", { exact: true });
    await box.fill("/poll Teamessen?");
    await box.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Umfrage erstellen" });
    await expect(dialog.getByLabel("Frage", { exact: true })).toHaveValue("Teamessen?");
    await dialog.getByRole("radio", { name: /Terminumfrage/ }).check();
    const calendar = dialog.getByTestId("poll-calendar");
    await expect(calendar).toBeVisible();
    await dialog.getByRole("button", { name: "Nächster Monat" }).click();
    const [first, second] = nextMonthDays();
    await calendar.locator(`[data-day="${first}"]`).click();
    // The keyboard picks the second day: the next day, Enter.
    await calendar.locator(`[data-day="${first}"]`).press("ArrowRight");
    await expect(calendar.locator(`[data-day="${second}"]`)).toBeFocused();
    await calendar.locator(`[data-day="${second}"]`).press("Enter");
    await expect(calendar.locator(`[data-day="${second}"]`)).toHaveAttribute("aria-selected", "true");
    if ((page.viewportSize()?.width ?? 1280) < 768) {
      // Phones: the calendar fits the screen and its days are at least 44 px high.
      await expectInsideViewport(page, calendar);
      const cell = (await calendar.locator(`[data-day="${first}"]`).boundingBox())!;
      expect(cell.height).toBeGreaterThanOrEqual(44);
      expect(cell.width).toBeGreaterThanOrEqual(40);
    }
    const days = dialog.getByTestId("poll-day");
    await expect(days).toHaveCount(2);
    // The first day stays all day, the second gets an evening slot.
    await days.nth(1).getByText("Ganztägig").click();
    await days.nth(1).getByTestId("poll-time-start").fill("18:30");
    await expect(dialog.getByTestId("poll-zone")).toContainText("2 von 60 Terminen");
    await dialog.getByText("1 Woche", { exact: true }).click();
    await axe(page, "[data-testid='poll-composer']");
    await dialog.getByTestId("poll-create").click();
    await expect(dialog).toBeHidden();

    const poll = pollIn(page, "Teamessen?");
    await expect(poll).toBeVisible({ timeout: scaled(20_000) });
    await expect(poll.getByTestId("poll-kind")).toHaveText("📅 Terminumfrage");
    await expect(poll.getByTestId("poll-slot")).toHaveCount(2);
    await expect(poll.getByTestId("poll-slot").first()).toContainText("ganztägig");
    await expect(poll.getByTestId("poll-slot").nth(1)).toContainText("18:30");

    const bob = await newPage(browser);
    await loginAs(bob, bobAccount);
    await bob.goto(`/rooms/${room.id}/channels/${channelId}`);
    const bobPoll = pollIn(bob, "Teamessen?");
    await expect(bobPoll).toBeVisible({ timeout: scaled(20_000) });
    await bobPoll.locator('[data-slot="s1"]').locator("label", { hasText: "Ja" }).click();
    await bobPoll.locator('[data-slot="s2"]').locator("label", { hasText: "Vielleicht" }).click();
    await bobPoll.getByTestId("poll-vote").click();
    await expect(poll.getByTestId("poll-voters")).toHaveText("1 Stimme", { timeout: scaled(20_000) });

    await poll.locator('[data-slot="s1"]').locator("label", { hasText: "Ja" }).click();
    await poll.locator('[data-slot="s2"]').locator("label", { hasText: "Nein" }).click();
    await poll.getByTestId("poll-vote").click();
    await expect(poll.getByTestId("poll-voters")).toHaveText("2 Stimmen");
    await expect(poll.locator('[data-slot="s1"]')).toHaveAttribute("data-best", "true");
    await expect(poll.getByTestId("poll-best")).toContainText("Bester Termin");
    await expect(bobPoll.locator('[data-slot="s1"]').getByTestId("poll-slot-count")).toHaveText("✓ 2 · ? 0", { timeout: scaled(20_000) });
    await poll.getByTestId("poll-grid-toggle").click();
    const grid = poll.getByTestId("poll-grid");
    await expect(grid.getByRole("row")).toHaveCount(3);
    await axe(page, "[data-testid='poll']");

    // Closed early: the client takes no votes, and the node refuses retracting (and voting) afterwards.
    page.on("dialog", (d) => void d.accept());
    await poll.getByTestId("poll-close-now").click();
    await expect(bobPoll.getByTestId("poll-closed")).toBeVisible({ timeout: scaled(20_000) });
    await expect(bobPoll.getByTestId("poll-retract")).toHaveCount(0);
    const messageId = await page.getByTestId("message").filter({ has: poll }).getAttribute("data-message-id");
    const late = await request.delete(`${NODE}/api/v1/conversations/${channelId}/messages/${messageId}/poll/vote`, { headers: { Authorization: `Bearer ${bobAccount.token}` } });
    expect(late.status()).toBe(409);
    expect((await late.json()).code).toBe("poll.closed");
    await bob.context().close();
  });
});
