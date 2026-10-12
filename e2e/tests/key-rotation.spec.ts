// SPDX-License-Identifier: Apache-2.0
// Identity key rotation with continuity (ENCRYPTION.md §9a, design note 4.13 item 13): rotate in the security settings
// with re-authentication, the user's second browser follows, a contact sees a soft notice instead of the warning;
// an identity reset still gives the warning.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, confirmWithPassword, loginViaUi, registerViaUi, tokenOf, type UiAccount } from "./helpers";
import { freshIdentityKey } from "./crypto-helpers";
import { scaled } from "./timeouts";

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

const message = (page: Page, text: string) => page.getByTestId("message").filter({ hasText: text });

async function api(page: Page, method: "get" | "post", path: string, data?: unknown) {
  const resp = await page.request[method](`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data });
  expect(resp.ok(), `${method} ${path}: ${await resp.text()}`).toBeTruthy();
  return resp.status() === 204 ? null : resp.json();
}

/** Friends both ways and a DM between the two; returns its id. */
async function dm(a: Page, b: Page, bUser: UiAccount): Promise<string> {
  await api(a, "post", "/users/me/friends/requests", { user: bUser.username });
  const list = await api(b, "get", "/users/me/friends");
  for (const r of list.incoming) await api(b, "post", `/users/me/friends/requests/${r.id}/accept`);
  const conversation = await api(a, "post", "/conversations", { kind: "dm", members: [bUser.address] });
  return conversation.id as string;
}

test.describe("Renewing the security key", () => {
  test("Renew with confirmation: the second browser carries on, the contact only sees a subtle notice; a reset warns", async ({ browser, page }) => {
    test.setTimeout(scaled(240_000));
    const alice = await registerViaUi(page, { prefix: "alice" });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    const conversation = await dm(page, bobPage, bob);

    // Alice's second browser, unlocked with the recovery key.
    const laptop = await newPage(browser);
    await loginViaUi(laptop, alice);
    await laptop.getByTestId("recovery-key-input").fill(alice.recoveryWords);
    await laptop.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(laptop.getByTestId("app-shell")).toBeVisible();

    await page.goto(`/conversations/${conversation}`);
    await send(page, "Vor dem Erneuern");
    await bobPage.goto(`/conversations/${conversation}`);
    await expect(message(bobPage, "Vor dem Erneuern")).toBeVisible({ timeout: 20_000 });
    await laptop.goto(`/conversations/${conversation}`);
    await expect(message(laptop, "Vor dem Erneuern")).toBeVisible({ timeout: 20_000 });

    // Alice rotates in the security settings; the page was loaded anew, so the node asks for a fresh confirmation.
    await page.goto("/settings/security");
    const section = page.getByTestId("identity-key-section");
    await expect(section).toContainText("Erneuere ihn");
    await expect(section.getByTestId("identity-reset-link")).toBeVisible();
    await section.getByTestId("identity-rotate").click();
    const dialog = page.getByTestId("identity-rotate-dialog");
    await expect(dialog).toContainText("setze ihn stattdessen zurück");
    await dialog.getByTestId("identity-rotate-confirm").click();
    await confirmWithPassword(page, alice.password);
    await expect(dialog).toHaveCount(0, { timeout: 20_000 });
    const keys = await api(page, "get", `/users/${alice.username}/keys`);
    expect(keys.identity_generation).toBe(1);
    expect(keys.continuity).toHaveLength(1);

    // Both browsers of Alice keep writing and reading, old and new messages.
    await page.goto(`/conversations/${conversation}`);
    await expect(message(page, "Vor dem Erneuern")).toBeVisible({ timeout: 20_000 });
    await send(page, "Nach dem Erneuern");
    await expect(message(laptop, "Nach dem Erneuern")).toBeVisible({ timeout: 20_000 });
    await expect(message(laptop, "Vor dem Erneuern")).toBeVisible();
    await send(laptop, "Vom zweiten Browser");
    await expect(message(bobPage, "Vom zweiten Browser")).toBeVisible({ timeout: 20_000 });
    await expect(laptop.getByTestId("undecryptable")).toHaveCount(0);

    // Bob: the new key is pinned with a soft notice (message and DM header), no warning, sending stays possible.
    await expect(message(bobPage, "Nach dem Erneuern")).toBeVisible();
    const soft = bobPage.getByTestId("key-rotated-badge");
    await expect(soft.first()).toBeVisible({ timeout: 20_000 });
    await expect(bobPage.getByTestId("key-changed-badge")).toHaveCount(0);
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);
    await send(bobPage, "Alles klar");
    await expect(message(page, "Alles klar")).toBeVisible({ timeout: 20_000 });
    await soft.first().click();
    await expect(bobPage.getByTestId("key-rotated-badge")).toHaveCount(0);

    // An identity reset instead: the warning, not the soft notice.
    const reset = await page.request.post(`${NODE}/api/v1/users/me/identity/reset`, {
      headers: { Authorization: `Bearer ${await tokenOf(page)}` },
      data: { identity_public_key: await freshIdentityKey(), password: alice.password },
    });
    expect(reset.status()).toBe(204);
    await expect(bobPage.getByTestId("key-changed-badge").first()).toBeVisible({ timeout: 20_000 });
    await expect(bobPage.getByTestId("key-rotated-badge")).toHaveCount(0);
    await bobPage.context().close();
    await laptop.context().close();
  });
});
