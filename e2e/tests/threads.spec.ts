// SPDX-License-Identifier: Apache-2.0
// Threads, forum and announcement channels (PROTOCOL.md §7e): a thread round trip in an encrypted channel with a
// second member (titles and messages stay ciphertext on the node), a forum post with tags and the tag filter, the
// announcement gating, and the thread panel's navigation on phones.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, type Account } from "./helpers";
import { joinRoom, openContextMenu, postMessage } from "./menu-helpers";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

/** No serious or critical WCAG 2.2 AA violation on the current screen (as a11y.spec.ts checks). */
async function expectAccessible(page: Page) {
  await page.waitForTimeout(400);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(bad).toEqual([]);
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/** The composer inside `scope` (the channel or the thread panel). */
async function send(scope: Locator, _page: Page, text: string) {
  const box = scope.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

const panel = (page: Page) => page.getByTestId("thread-panel");
const channelArea = (page: Page) => page.getByTestId("channel-page").locator("> div").first();

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
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Einladen" }).click();
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.getByRole("button", { name: "Fertig" }).click();
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (await overlay.isVisible()) await overlay.click({ position: { x: (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
  return link;
}

async function channel(request: import("@playwright/test").APIRequestContext, owner: Account, roomId: string, data: Record<string, unknown>) {
  const resp = await request.post(`${NODE}/api/v1/rooms/${roomId}/channels`, { headers: auth(owner.token), data: { encrypted: false, ...data } });
  if (!resp.ok()) throw new Error(`channel: ${resp.status()} ${await resp.text()}`);
  return (await resp.json()) as { id: string };
}

test.describe("Threads", () => {
  test("encrypted channel: reply in a thread, the second member reads and answers; the node sees only ciphertext", async ({ browser, page }) => {
    test.setTimeout(180_000);
    await registerViaUi(page, { prefix: "alice" });
    const roomUrl = await createRoomInUi(page, "Fadenraum");
    const link = await inviteLink(page);
    const bob = await newPage(browser);
    await registerViaUi(bob, { prefix: "bob" });
    await bob.goto(link);
    await bob.getByRole("button", { name: "Beitreten" }).click();
    await expect(bob.getByTestId("channel-name")).toHaveText("allgemein");

    await page.goto(roomUrl);
    await send(page.getByTestId("channel-page"), page, "Wann ist das Release?");
    const root = page.getByTestId("message").filter({ hasText: "Wann ist das Release?" });
    await expect(root).toBeVisible();
    await openContextMenu(page, root);
    await page.getByRole("menuitem", { name: "Im Thread antworten" }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByTestId("thread-title")).toHaveText("Wann ist das Release?");
    await expect(page).toHaveURL(/\/threads\/[0-9A-Z]{26}$/);
    // The root message opens the thread; the thread's composer writes into it.
    await expect(panel(page).getByTestId("message").filter({ hasText: "Wann ist das Release?" })).toBeVisible();
    await send(panel(page), page, "Am Freitag");
    await expect(panel(page).getByTestId("message").filter({ hasText: "Am Freitag" })).toBeVisible();
    if (isPhone(page)) {
      // Phones: the thread is full screen, the back button returns to the channel.
      await expect(channelArea(page)).toBeHidden();
      await panel(page).getByTestId("thread-close").click();
      await expect(channelArea(page)).toBeVisible();
    } else {
      // The channel itself never shows thread messages.
      await expect(channelArea(page).getByTestId("message").filter({ hasText: "Am Freitag" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await expect(panel(page)).toHaveCount(0);
    const indicator = page.getByTestId("thread-indicator");
    await expect(indicator).toContainText("1 Antwort");

    // Bob sees the summary under the root, opens the thread and reads the decrypted messages.
    const bobIndicator = bob.getByTestId("thread-indicator");
    await expect(bobIndicator).toContainText("1 Antwort", { timeout: 20_000 });
    await bobIndicator.click();
    await expect(panel(bob).getByTestId("thread-title")).toHaveText("Wann ist das Release?");
    await expect(panel(bob).getByTestId("message").filter({ hasText: "Am Freitag" })).toBeVisible({ timeout: 20_000 });
    await send(panel(bob), bob, "Passt mir");
    await expect(panel(bob).getByTestId("thread-follow")).toHaveText("Gefolgt");

    // Alice follows her thread: the answer counts on the threads button and opens from the list.
    await expect(indicator).toContainText("2 Antworten", { timeout: 20_000 });
    await expect(page.getByTestId("threads-unread")).toHaveText("1");
    await page.getByTestId("threads-button").click();
    await page.getByTestId("thread-row").filter({ hasText: "Wann ist das Release?" }).click();
    await expect(panel(page).getByTestId("message").filter({ hasText: "Passt mir" })).toBeVisible();
    await expect(page.getByTestId("threads-unread")).toHaveCount(0);

    // The node holds the title and the messages as ciphertext only.
    const token = await tokenOf(page);
    const roomId = /rooms\/([0-9A-Z]{26})/.exec(page.url())![1]!;
    const channelId = /channels\/([0-9A-Z]{26})/.exec(page.url())![1]!;
    const list = await (await page.request.get(`${NODE}/api/v1/rooms/${roomId}/channels/${channelId}/threads`, { headers: auth(token) })).json();
    expect(list.items[0].encrypted).toBe(true);
    expect(JSON.stringify(list)).not.toContain("Release");
    const messages = await (await page.request.get(`${NODE}/api/v1/conversations/${channelId}/messages?thread=${list.items[0].id}`, { headers: auth(token) })).json();
    expect(messages.length).toBe(2);
    expect(JSON.stringify(messages)).not.toMatch(/Freitag|Passt/);
  });

  test("followed threads of rooms not opened since the start notify from the start", async ({ page, request }) => {
    test.setTimeout(90_000);
    const bob = await registerViaApi(request, "tfb");
    const alice = await registerViaApi(request, "tfa");
    const room = await createRoomViaApi(request, bob.token, "Folgeraum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await joinRoom(request, bob, room.id, alice);
    const root = await postMessage(request, bob.token, channelId, "Planung fürs Treffen");
    const created = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channelId}/threads`, { headers: auth(bob.token), data: { title: "Planung", root_message_id: root.id } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const thread = (await created.json()) as { id: string };
    // Alice writes in the thread elsewhere: she follows it.
    await postMessage(request, alice.token, channelId, "Ich bin dabei", { thread_id: thread.id });

    // Alice starts the client on the home view; the room is not opened. Its followed threads load in the background.
    const followed = page.waitForResponse((r) => r.url().endsWith(`/rooms/${room.id}/followed-threads`) && r.ok());
    await loginAs(page, alice);
    await page.goto("/");
    await expect(page.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready");
    await followed;
    // @everyone inside a thread reaches its followers only (PROTOCOL.md §7e): Alice is one.
    await postMessage(request, bob.token, channelId, "@everyone Treffen um drei", { thread_id: thread.id, mentions_everyone: true });
    const toast = page.getByTestId("notify-toast-mention");
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText("Treffen um drei");
    await expect(toast).toContainText("Folgeraum");
  });

  test("forum: a post with title, message and tags; the tag filter and the post card", async ({ page, request }) => {
    test.setTimeout(120_000);
    const alice = await registerViaApi(request, "alice");
    const room = await createRoomViaApi(request, alice.token, "Forumraum");
    const forum = await channel(request, alice, room.id, { kind: "forum", name: "hilfe" });
    const tags = await request.patch(`${NODE}/api/v1/rooms/${room.id}/channels/${forum.id}`, { headers: auth(alice.token), data: { tags: [{ name: "Fehler", emoji: "🐛" }, { name: "Idee" }] } });
    expect(tags.ok()).toBeTruthy();
    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/channels/${forum.id}`);
    await expect(page.getByTestId("forum-view")).toBeVisible();
    await expect(page.getByTestId("unencrypted-banner")).toBeVisible();
    await expect(page.getByTestId("forum-empty")).toBeVisible();

    await page.getByTestId("forum-new-post").click();
    const dialog = page.getByTestId("forum-post-dialog");
    await dialog.getByTestId("forum-post-title-input").fill("Absturz beim Start");
    await dialog.getByTestId("forum-post-body").fill("Die App stürzt beim Öffnen ab.");
    await dialog.getByTestId("forum-post-tag-option").filter({ hasText: "Fehler" }).click();
    await dialog.getByTestId("forum-post-submit").click();
    // The new post opens in the thread panel with its first message.
    await expect(panel(page).getByTestId("thread-title")).toHaveText("Absturz beim Start");
    await expect(panel(page).getByTestId("message").filter({ hasText: "Die App stürzt" })).toBeVisible();
    await expectAccessible(page);
    await send(panel(page), page, "Welche Version?");
    await panel(page).getByTestId("thread-close").click();

    const card = page.getByTestId("forum-post").filter({ hasText: "Absturz beim Start" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("forum-post-tag")).toHaveText("🐛 Fehler");
    await expect(card).toContainText("Die App stürzt beim Öffnen ab.");
    await expect(card).toContainText("1 Antwort");
    await expectAccessible(page);
    await page.getByTestId("forum-tag-filter").filter({ hasText: "Idee" }).click();
    await expect(page.getByTestId("forum-post")).toHaveCount(0);
    await page.getByTestId("forum-tag-filter").filter({ hasText: "Fehler" }).click();
    await expect(card).toBeVisible();
    await page.getByTestId("forum-tag-all").click();
    await expect(card).toBeVisible();
    // Forum channels take posts only.
    const loose = await request.post(`${NODE}/api/v1/conversations/${forum.id}/messages`, { headers: auth(alice.token), data: { content: { type: "text", body: "lose" } } });
    expect((await loose.json()).code).toBe("message.thread_required");
  });

  test("announcement channel: members cannot post, but react and reply in threads", async ({ page, request }) => {
    test.setTimeout(120_000);
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Neuigkeiten");
    const news = await channel(request, alice, room.id, { kind: "announcement", name: "ankündigungen" });
    await joinRoom(request, alice, room.id, bob);
    await postMessage(request, alice.token, news.id, "Version 1.0 ist da");
    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}/channels/${news.id}`);
    await expect(page.getByTestId("composer-note")).toContainText("schreiben nur Moderatoren");
    await expect(page.getByLabel("Nachricht", { exact: true })).toHaveCount(0);
    const announcement = page.getByTestId("message").filter({ hasText: "Version 1.0 ist da" });
    await openContextMenu(page, announcement);
    await page.getByRole("menuitem", { name: "Im Thread antworten" }).click();
    await expect(panel(page).getByTestId("thread-title")).toHaveText("Version 1.0 ist da");
    await send(panel(page), page, "Glückwunsch!");
    await expect(panel(page).getByTestId("message").filter({ hasText: "Glückwunsch!" })).toBeVisible();
    // The node refuses Bob's own announcements.
    const refused = await request.post(`${NODE}/api/v1/conversations/${news.id}/messages`, { headers: auth(bob.token), data: { content: { type: "text", body: "auch ich" } } });
    expect((await refused.json()).code).toBe("message.announcement_forbidden");
  });
});
