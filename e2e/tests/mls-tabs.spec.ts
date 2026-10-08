// SPDX-License-Identifier: Apache-2.0
// Two tabs of one browser on the same account and device share one MLS state (docs/CLIENT.md "Several tabs"): one
// tab owns it (a Web Lock), the other forwards its state-changing calls to it. Without that the second tab, whose
// state predates the DM, would join once more with the same device and throw the first tab out of the group.
// Asserted through the existing test ids (no `e2ee-rejoined`, no `undecryptable`, no `ghost-warning`) and the
// browser's own lock list.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, openNavIfMobile, registerViaUi, tokenOf, type UiAccount } from "./helpers";

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 15_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

async function befriend(a: Page, b: Page, bob: UiAccount) {
  const auth = async (p: Page) => ({ Authorization: `Bearer ${await tokenOf(p)}` });
  expect((await a.request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: await auth(a), data: { user: bob.username } })).ok()).toBeTruthy();
  const list = await (await b.request.get(`${NODE}/api/v1/users/me/friends`, { headers: await auth(b) })).json();
  for (const r of list.incoming) await b.request.post(`${NODE}/api/v1/users/me/friends/requests/${r.id}/accept`, { headers: await auth(b) });
}

/** The MLS locks of this browser context: who holds the state, who waits for it. */
async function mlsLocks(page: Page): Promise<{ held: string[]; pending: string[] }> {
  return page.evaluate(async () => {
    const q = await navigator.locks.query();
    const mls = (l: LockInfo) => !!l.name?.startsWith("tavrn-mls|");
    return { held: (q.held ?? []).filter(mls).map((l) => l.clientId ?? ""), pending: (q.pending ?? []).filter(mls).map((l) => l.clientId ?? "") };
  });
}

async function noTrouble(...pages: Page[]) {
  for (const p of pages) {
    await expect(p.getByTestId("e2ee-rejoined")).toHaveCount(0);
    await expect(p.getByTestId("undecryptable")).toHaveCount(0);
    await expect(p.getByTestId("ghost-warning")).toHaveCount(0);
  }
}

test.describe("Several tabs of one browser", () => {
  test("two tabs share the MLS state of a DM: both send and read, no rejoin, the second takes over when the first closes", async ({ browser, page }) => {
    test.setTimeout(180_000);
    await registerViaUi(page, { prefix: "alice" });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    await befriend(page, bobPage, bob);

    // The second tab of the same browser starts before the DM exists (its session manager opens at start).
    const tab2 = await page.context().newPage();
    await tab2.goto("/");
    await expect(tab2.getByTestId("app-shell")).toBeVisible();
    await expect.poll(async () => (await mlsLocks(tab2)).pending.length, { timeout: 15_000 }).toBe(1);
    const before = await mlsLocks(page);
    expect(before.held).toHaveLength(1);

    // Tab 1 opens the DM and writes first: the group is created and Bob's device added.
    await page.goto("/friends");
    await page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await send(page, "Aus dem ersten Tab");
    const dmUrl = page.url();

    // Tab 2 opens the same DM in the app (no reload: its state is older than the group) and writes too.
    await openNavIfMobile(tab2);
    await tab2.getByTestId("dm-list").getByRole("link", { name: new RegExp(bob.username) }).click();
    await expect(message(tab2, "Aus dem ersten Tab")).toBeVisible({ timeout: 20_000 });
    await send(tab2, "Aus dem zweiten Tab");
    await expect(message(page, "Aus dem zweiten Tab")).toBeVisible();

    // Bob reads both and answers; both tabs read the answer.
    await bobPage.goto(dmUrl.replace(/^https?:\/\/[^/]+/, ""));
    await expect(message(bobPage, "Aus dem ersten Tab")).toBeVisible({ timeout: 20_000 });
    await expect(message(bobPage, "Aus dem zweiten Tab")).toBeVisible();
    await send(bobPage, "Hallo, ihr beiden");
    await expect(message(page, "Hallo, ihr beiden")).toBeVisible();
    await expect(message(tab2, "Hallo, ihr beiden")).toBeVisible();
    await noTrouble(page, tab2, bobPage);

    // The first tab (the owner) closes: the second one takes the lock over and goes on alone.
    await page.close();
    await expect.poll(async () => mlsLocks(tab2), { timeout: 15_000 }).toEqual({ held: [expect.any(String)], pending: [] });
    await send(tab2, "Nach dem Schließen");
    await expect(message(bobPage, "Nach dem Schließen")).toBeVisible();
    await send(bobPage, "Angekommen");
    await expect(message(tab2, "Angekommen")).toBeVisible();
    await noTrouble(tab2, bobPage);
    await bobPage.context().close();
  });
});
