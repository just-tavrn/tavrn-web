// SPDX-License-Identifier: Apache-2.0
// Polls and date polls (PROTOCOL.md §7g): a choice poll in an end-to-end encrypted channel voted on by two members
// (results after voting, "Change vote" with the form prefilled, voters, closing early), a date poll in a plaintext
// channel created with /poll (the calendar, all-day and timed slots, answers, the results grid with the best slot,
// a changed vote, the grid of answers, votes refused after the close) and a date poll with many slots (the compact
// results grid, keyboard, the phone layout). axe-core checks the composer, the vote form and the results; the phone
// project checks the calendar's and the grid's layout. Screenshots for review: test-results/pollsux/.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { pollHash, pollVoteContent, type Poll } from "@tavrn/e2ee";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, openRoomInvite, registerViaApi, registerViaUi, newPage, closePages } from "./helpers";
import { expectInsideViewport, joinRoom } from "./menu-helpers";
import { scaled } from "./timeouts";

test.afterEach(closePages);

/** No WCAG 2.2 AA violation inside `selector`. */
async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
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
const cell = (poll: Locator, slot: string) => poll.locator(`[data-testid="poll-cell"][data-slot="${slot}"]`);
const slotRow = (poll: Locator, slot: string) => poll.locator(`[data-testid="poll-slot"][data-slot="${slot}"]`);

/** A screenshot of `poll` for the owner's review (test-results/pollsux/<project>-<name>.png). */
async function shot(poll: Locator, name: string) {
  // A tall window, so the whole poll fits into the message list (the bars above it would cover its top).
  const page = poll.page();
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 2200 });
  await poll.scrollIntoViewIfNeeded();
  await poll.screenshot({ path: `test-results/pollsux/${test.info().project.name}-${name}.png`, animations: "disabled" });
  await page.setViewportSize(size);
}

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

    // After voting both see the results with the own vote marked, no form.
    await expect(poll).toHaveAttribute("data-view", "results");
    await expect(poll.getByRole("radio")).toHaveCount(0);
    await expect(option(poll, "o1").getByTestId("poll-mine")).toHaveText("Deine Stimme");
    await axe(page, "[data-testid='poll']");
    await shot(poll, "choice-results");

    // Bob changes his vote: the form opens with his vote checked; "Keep" returns, "Save" stores the new one.
    await expect(bobPoll).toHaveAttribute("data-view", "results");
    await bobPoll.getByRole("button", { name: "Stimme ändern" }).click();
    await expect(option(bobPoll, "o2").getByRole("radio")).toBeChecked();
    await expect(bobPoll.getByTestId("poll-retract")).toBeVisible();
    await axe(bob, "[data-testid='poll']");
    await shot(bobPoll, "choice-form");
    await bobPoll.getByRole("button", { name: "Behalten" }).click();
    await expect(bobPoll).toHaveAttribute("data-view", "results");
    await bobPoll.getByRole("button", { name: "Stimme ändern" }).click();
    await option(bobPoll, "o1").getByRole("radio").check();
    await bobPoll.getByRole("button", { name: "Speichern" }).click();
    await expect(bobPoll).toHaveAttribute("data-view", "results");
    await expect(option(bobPoll, "o1")).toHaveAttribute("data-mine", "true");
    await expect(option(poll, "o1").getByTestId("poll-count")).toHaveText("2 · 100 %", { timeout: scaled(20_000) });
    await expect(option(poll, "o2").getByTestId("poll-count")).toHaveText("0 · 0 %");

    // The author closes the poll early: nobody can vote any more.
    page.on("dialog", (d) => void d.accept());
    await poll.getByTestId("poll-close-now").click();
    await expect(poll.getByTestId("poll-closed")).toBeVisible();
    await expect(bobPoll.getByTestId("poll-closed")).toBeVisible({ timeout: scaled(20_000) });
    await expect(bobPoll.getByTestId("poll-vote")).toHaveCount(0);
    await expect(bobPoll.getByTestId("poll-change")).toHaveCount(0);
    await expect(bobPoll.getByRole("radio")).toHaveCount(0);
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
    await slotRow(bobPoll, "s1").locator("label", { hasText: "Ja" }).click();
    await slotRow(bobPoll, "s2").locator("label", { hasText: "Vielleicht" }).click();
    await bobPoll.getByTestId("poll-vote").click();
    await expect(bobPoll).toHaveAttribute("data-view", "results");
    await expect(poll.getByTestId("poll-voters")).toHaveText("1 Stimme", { timeout: scaled(20_000) });

    // Alice has not voted yet: the form (one group per day), axe-checked.
    await expect(poll).toHaveAttribute("data-view", "form");
    await axe(page, "[data-testid='poll']");
    await slotRow(poll, "s1").locator("label", { hasText: "Ja" }).click();
    await slotRow(poll, "s2").locator("label", { hasText: "Nein" }).click();
    await poll.getByTestId("poll-vote").click();
    await expect(poll.getByTestId("poll-voters")).toHaveText("2 Stimmen");
    await expect(poll).toHaveAttribute("data-view", "results");
    await expect(cell(poll, "s1")).toHaveAttribute("data-best", "true");
    await expect(cell(poll, "s1")).toHaveAttribute("data-mine", "yes");
    await expect(poll.getByTestId("poll-best")).toContainText("Bester Termin");
    await expect(cell(bobPoll, "s1")).toHaveAccessibleName(/2 ja, 0 vielleicht, 0 nein\. bester Termin\. deine Antwort: Ja/, { timeout: scaled(20_000) });
    // A cell opens the answers of its slot.
    await cell(poll, "s1").click();
    await expect(poll.getByTestId("poll-slot-detail")).toContainText("Ja (2)");
    await poll.getByTestId("poll-grid-toggle").click();
    const grid = poll.getByTestId("poll-grid");
    await expect(grid.getByRole("row")).toHaveCount(3);
    await axe(page, "[data-testid='poll']");

    // Bob changes his vote: the form shows his answers, saved he sees the results again.
    await bobPoll.getByRole("button", { name: "Stimme ändern" }).click();
    await expect(slotRow(bobPoll, "s1").getByTestId("poll-answer-yes")).toBeChecked();
    await expect(slotRow(bobPoll, "s2").getByTestId("poll-answer-maybe")).toBeChecked();
    await slotRow(bobPoll, "s2").locator("label", { hasText: "Ja" }).click();
    await bobPoll.getByRole("button", { name: "Speichern" }).click();
    await expect(bobPoll).toHaveAttribute("data-view", "results");
    await expect(cell(poll, "s2")).toHaveAccessibleName(/1 ja, 0 vielleicht, 1 nein/, { timeout: scaled(20_000) });

    // Closed early: the client takes no votes, and the node refuses retracting (and voting) afterwards.
    page.on("dialog", (d) => void d.accept());
    await poll.getByTestId("poll-close-now").click();
    await expect(bobPoll.getByTestId("poll-closed")).toBeVisible({ timeout: scaled(20_000) });
    await expect(bobPoll.getByTestId("poll-retract")).toHaveCount(0);
    await expect(bobPoll.getByTestId("poll-change")).toHaveCount(0);
    const messageId = await page.getByTestId("message").filter({ has: poll }).getAttribute("data-message-id");
    const late = await request.delete(`${NODE}/api/v1/conversations/${channelId}/messages/${messageId}/poll/vote`, { headers: { Authorization: `Bearer ${bobAccount.token}` } });
    expect(late.status()).toBe(409);
    expect((await late.json()).code).toBe("poll.closed");
    await bob.context().close();
  });
});

test.describe("Date poll results", () => {
  // The slots are written in UTC; the browser shows them in UTC, so the rows read as written.
  test.use({ timezoneId: "UTC" });

  test("many slots: the compact grid (days × times), the best slots, keyboard, the phone layout", async ({ page, request }) => {
    test.setTimeout(scaled(180_000));
    const alice = await registerViaApi(request, "alice");
    const others = await Promise.all(["bob", "carol", "dave"].map((p) => registerViaApi(request, p)));
    const room = await createRoomViaApi(request, alice.token, "Terminraster");
    for (const o of others) await joinRoom(request, alice, room.id, o);
    const channelId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "text")!.id;
    // Five evenings with three times each and an all-day Saturday-like day: 16 slots.
    const [first] = nextMonthDays();
    const day = (n: number) => `${first.slice(0, 8)}${String(10 + n).padStart(2, "0")}`;
    const slots: { id: string; start: string; end?: string; all_day?: boolean }[] = [];
    for (let d = 0; d < 5; d++) for (const time of ["18:00", "19:30", "21:00"]) slots.push({ id: `s${slots.length + 1}`, start: `${day(d)}T${time}:00Z` });
    slots.push({ id: "s16", start: `${day(5)}T00:00:00Z`, all_day: true });
    const content = { type: "poll", kind: "date", question: "Wann proben wir?", slots, results_visible: "always", votes_visible: "public" };
    const posted = await request.post(`${NODE}/api/v1/conversations/${channelId}/messages`, { headers: { Authorization: `Bearer ${alice.token}` }, data: { content } });
    expect(posted.ok()).toBeTruthy();
    const messageId = (await posted.json()).id as string;
    const hash = await pollHash(content);
    const { type: _type, ...poll } = content;
    const answers: Record<string, "yes" | "maybe" | "no">[] = [
      { s5: "yes", s8: "yes", s2: "maybe", s11: "no", s16: "maybe" },
      { s5: "yes", s8: "maybe", s2: "yes", s14: "yes", s16: "no" },
      { s5: "yes", s8: "yes", s3: "no", s16: "yes" },
    ];
    for (const [i, o] of others.entries()) {
      const vote = pollVoteContent(poll as unknown as Poll, messageId, hash, { answers: answers[i]! });
      const put = await request.put(`${NODE}/api/v1/conversations/${channelId}/messages/${messageId}/poll/vote`, { headers: { Authorization: `Bearer ${o.token}` }, data: { content: vote } });
      expect(put.ok(), await put.text()).toBeTruthy();
    }

    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    const view = pollIn(page, "Wann proben wir?");
    await expect(view).toBeVisible({ timeout: scaled(20_000) });
    await expect(view.getByTestId("poll-voters")).toHaveText("3 Stimmen", { timeout: scaled(20_000) });
    // Not voted: the form, grouped by day (six groups), 44 px answers.
    await expect(view).toHaveAttribute("data-view", "form");
    await expect(view.getByTestId("poll-day-group")).toHaveCount(6);
    const answer = (await slotRow(view, "s5").locator("label", { hasText: "Ja" }).boundingBox())!;
    expect(answer.height).toBeGreaterThanOrEqual(44);
    await shot(view, "date-form");
    // A look at the results before voting.
    await view.getByTestId("poll-show-results").click();
    await expect(view).toHaveAttribute("data-view", "results");
    await view.getByTestId("poll-change").click();
    await slotRow(view, "s5").locator("label", { hasText: "Ja" }).click();
    await slotRow(view, "s8").locator("label", { hasText: "Nein" }).click();
    await slotRow(view, "s16").locator("label", { hasText: "Vielleicht" }).click();
    await view.getByTestId("poll-vote").click();
    await expect(view).toHaveAttribute("data-view", "results");

    // The grid: six day columns, the all-day row and three times; the best slot summarised and marked.
    const grid = view.getByRole("grid", { name: "Ergebnisse von Wann proben wir?" });
    await expect(grid.getByRole("columnheader")).toHaveCount(7);
    await expect(grid.getByRole("rowheader")).toHaveText(["ganztägig", "18:00", "19:30", "21:00"]);
    await expect(grid.getByTestId("poll-cell")).toHaveCount(16);
    await expect(view.getByTestId("poll-best-slot")).toHaveCount(1);
    await expect(view.getByTestId("poll-best")).toContainText("19:30");
    await expect(cell(view, "s5")).toHaveAttribute("data-best", "true");
    await expect(cell(view, "s5")).toHaveAccessibleName(/4 ja, 0 vielleicht, 0 nein\. bester Termin\. deine Antwort: Ja/);
    await expect(cell(view, "s8")).toHaveAttribute("data-mine", "no");
    // The grid is one tab stop on the best slot; arrows move, Enter opens the answers.
    await expect(cell(view, "s5")).toHaveAttribute("tabindex", "0");
    await cell(view, "s5").focus();
    await page.keyboard.press("ArrowRight");
    await expect(cell(view, "s8")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(cell(view, "s7")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(view.getByTestId("poll-slot-detail")).toContainText("Ja (0)");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(view.getByTestId("poll-slot-detail")).toContainText("Nein (1)");
    await expect(view.getByTestId("poll-slot-detail")).toContainText("Deine Antwort: Nein");
    // Compact: four rows of cells, far less than a list of 16 slots.
    const box = (await view.getByTestId("poll-results").boundingBox())!;
    expect(box.height).toBeLessThan(300);
    for (const c of await grid.getByTestId("poll-cell").all()) expect((await c.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await axe(page, "[data-testid='poll']");
    await shot(view, "date-results");

    if ((page.viewportSize()?.width ?? 1280) < 768) {
      // Phones: the grid scrolls sideways inside the poll, the times stay in view.
      const results = view.getByTestId("poll-results");
      await expectInsideViewport(page, results);
      expect(await results.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await results.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
      const header = (await grid.getByRole("rowheader").first().boundingBox())!;
      expect(header.x).toBeGreaterThanOrEqual(box.x - 1);
      await shot(view, "date-results-scrolled");
    }
    await page.screenshot({ path: `test-results/pollsux/${test.info().project.name}-date-page.png` });
  });
});
