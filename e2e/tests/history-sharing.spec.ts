// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, openNavIfMobile, registerViaUi, tokenOf, openRoomInvite } from "./helpers";

// History for new members of encrypted channels (design note 4.13 item 11, ENCRYPTION.md §7b): the channel policy
// decides what the node serves from before a member's join, members' devices share the keys of older epochs
// through `…/history-keys` (never as messages), the new member checks them and keeps them in its key store.

const CRYPTO = { timeout: 30_000 };

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

/** Alice's encrypted room with two messages; returns room id, channel id and the room URL. */
async function roomWithHistory(page: Page, name: string) {
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Raum erstellen" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  await expect(page.getByTestId("encrypted-marker")).toBeVisible();
  const url = page.url();
  const roomId = url.split("/rooms/")[1]!.split("/")[0]!;
  const channelId = url.split("/channels/")[1]!;
  await send(page, "Alte Nachricht eins");
  await send(page, "Alte Nachricht zwei");
  return { url, roomId, channelId };
}

async function inviteLink(page: Page): Promise<string> {
  await openRoomInvite(page);
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.getByRole("button", { name: "Fertig" }).click();
  await closeDrawers(page);
  return link;
}

async function joinByLink(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole("button", { name: "Beitreten" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
}

async function setPolicy(page: Page, roomId: string, channelId: string, value: string) {
  const resp = await page.request.patch(`${NODE}/api/v1/rooms/${roomId}/channels/${channelId}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data: { history_for_new_members: value } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

async function getJson(page: Page, path: string) {
  const resp = await page.request.get(`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json();
}

test.describe("History for new members", () => {
  test("all: Bob reads older messages, the node only sees ciphertext, the keys stay in local storage", async ({ browser, page }) => {
    test.setTimeout(240_000);
    await registerViaUi(page, { prefix: "alice" });
    const { url, roomId, channelId } = await roomWithHistory(page, "Archiv");

    // The setting in the channel settings, with its explanation.
    await page.goto(`/rooms/${roomId}/settings/channels`);
    const editor = page.getByTestId("channel-editor");
    await expect(editor.getByText("Verlauf für neue Mitglieder")).toBeVisible();
    await expect(editor.getByText(/nimmt bereits geteilte Schlüssel nicht zurück/)).toBeVisible();
    await editor.getByTestId("history-policy").selectOption("all");
    await editor.getByTestId("history-policy-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Channel gespeichert" })).toBeVisible();
    await page.goto(`/rooms/${roomId}/settings/audit`);
    await expect(page.getByTestId("audit-list")).toContainText("channel.history_policy");

    await page.goto(url);
    await expect(message(page, "Alte Nachricht zwei")).toBeVisible();
    const link = await inviteLink(page);
    const stored = await getJson(page, `/conversations/${channelId}/messages`);
    const shareRequest = page.waitForRequest((r) => r.url().includes(`/conversations/${channelId}/history-keys`) && r.method() === "POST", CRYPTO);

    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    await joinByLink(bobPage, link);
    // Alice's device (online, holding the keys) shares; Bob checks the keys and reads the older messages.
    await expect(message(bobPage, "Alte Nachricht eins")).toBeVisible(CRYPTO);
    await expect(message(bobPage, "Alte Nachricht zwei")).toBeVisible();
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);
    await expect(bobPage.getByTestId("e2ee-history")).toHaveCount(0);

    // The share was ciphertext addressed to Bob, never a message.
    const body = (await shareRequest).postDataJSON() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ciphertext", "epoch_from", "epoch_to", "to_user"]);
    expect(body.to_user).toBe(bob.address);
    expect(String(body.ciphertext)).not.toContain("history_keys");
    expect(() => JSON.parse(String(body.ciphertext))).toThrow();
    const after = await getJson(page, `/conversations/${channelId}/messages`);
    // No message was added for the share (only Bob's join, a system message without a device).
    const userMessages = (list: { device_id?: string | null }[]) => list.filter((m) => !!m.device_id).length;
    expect(userMessages(after)).toBe(userMessages(stored));
    expect(JSON.stringify(after)).not.toContain("history_keys");
    expect(JSON.stringify(after)).not.toContain("Alte Nachricht");
    for (const m of after.filter((x: { device_id?: string | null }) => !!x.device_id)) expect(m.encrypted).toBe(true);
    // Bob acknowledged it: the node keeps nothing for him.
    await expect.poll(async () => (await getJson(bobPage, `/conversations/${channelId}/history-keys`)).items.length).toBe(0);
    // Nothing of the share shows up in Bob's message list.
    await expect(bobPage.getByTestId("message-list")).not.toContainText("history_keys");

    // The keys are in Bob's local key store: after a reload, without the backup and without shares, the
    // older messages are still readable.
    await bobPage.route("**/api/v1/users/me/backups**", (route) => route.abort());
    await bobPage.reload();
    await expect(message(bobPage, "Alte Nachricht eins")).toBeVisible(CRYPTO);
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);
    await bobPage.context().close();
  });

  test("Sharing person offline: notice for the new member, the keys arrive once they are back", async ({ browser, page }) => {
    test.setTimeout(240_000);
    await registerViaUi(page, { prefix: "alice" });
    const { url, roomId, channelId } = await roomWithHistory(page, "Später");
    await setPolicy(page, roomId, channelId, "all");
    await page.reload();
    const link = await inviteLink(page);
    await page.context().setOffline(true);

    const bobPage = await newPage(browser);
    await registerViaUi(bobPage, { prefix: "bob" });
    await joinByLink(bobPage, link);
    // Nobody online holds the keys yet: the older messages wait behind a notice.
    await expect(bobPage.getByTestId("e2ee-history")).toHaveText("Ältere Nachrichten werden entsperrt…", CRYPTO);
    await expect(message(bobPage, "Alte Nachricht eins")).toHaveCount(0);

    // Alice is back and opens the channel: her device shares, the notice goes, the history loads.
    await page.context().setOffline(false);
    await page.goto(url);
    await expect(message(bobPage, "Alte Nachricht eins")).toBeVisible(CRYPTO);
    await expect(bobPage.getByTestId("e2ee-history")).toHaveCount(0, CRYPTO);
    await bobPage.context().close();
  });

  test("since joining shows nothing older, one day shows the recent messages", async ({ browser, page }) => {
    test.setTimeout(240_000);
    await registerViaUi(page, { prefix: "alice" });
    const { roomId, channelId } = await roomWithHistory(page, "Grenzen");
    const link = await inviteLink(page);

    // Default `since_join`: the node does not even serve the older messages to Bob.
    const bobPage = await newPage(browser);
    await registerViaUi(bobPage, { prefix: "bob" });
    await joinByLink(bobPage, link);
    await send(bobPage, "Bob ist da");
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);
    await expect(message(bobPage, "Alte Nachricht")).toHaveCount(0);
    await expect(bobPage.getByTestId("e2ee-history")).toHaveCount(0);
    const forBob = await getJson(bobPage, `/conversations/${channelId}/messages`);
    expect(forBob.filter((m: { device_id?: string | null }) => !!m.device_id)).toHaveLength(1);
    expect((await getJson(bobPage, `/conversations/${channelId}/history-pending`)).items).toEqual([]);

    // `days:1`: Carol, joining now, gets the messages of the last day.
    await setPolicy(page, roomId, channelId, "days:1");
    const carolPage = await newPage(browser);
    await registerViaUi(carolPage, { prefix: "carol" });
    await joinByLink(carolPage, link);
    await expect(message(carolPage, "Alte Nachricht eins")).toBeVisible(CRYPTO);
    await expect(message(carolPage, "Bob ist da")).toBeVisible();
    await expect(carolPage.getByTestId("undecryptable")).toHaveCount(0);
    await bobPage.context().close();
    await carolPage.context().close();
  });
});
