// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { openNavIfMobile, registerViaUi, tokenOf, openRoomInvite, newPage, message, closePages } from "./helpers";
import { A, B, FEDERATION_BROWSER, NODE_A, WEB_A, WEB_B, chromiumOnly } from "./federation-helpers";
import { scaled } from "./timeouts";

test.afterEach(closePages);

test.use(FEDERATION_BROWSER);

// History for new members across nodes (ENCRYPTION.md §7b): the history-keys routes live on the node that hosts
// the conversation, shares are addressed by user address, a member of another node gets them through its
// federated session there.
const CRYPTO = { timeout: scaled(30_000) };

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled(CRYPTO);
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(message(page, text)).toBeVisible();
}

test.describe("History for new members across nodes", () => {
  chromiumOnly();

  test('Room on A with the "all" policy: Bob from B joins and reads older messages', async ({ browser, page }) => {
    test.setTimeout(scaled(240_000));
    await registerViaUi(page, { prefix: "fha", web: WEB_A, domain: A });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "fhb", web: WEB_B, domain: B });

    // Alice's encrypted room on a.test with history before Bob's join.
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    const roomName = `Chronik ${bob.username.slice(-5)}`;
    await page.getByRole("dialog").getByLabel("Name").fill(roomName);
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    const roomId = page.url().split("/rooms/")[1]!.split("/")[0]!;
    const channelId = page.url().split("/channels/")[1]!;
    await send(page, "Vor Bobs Beitritt auf A");
    const patch = await page.request.patch(`${NODE_A}/api/v1/rooms/${roomId}/channels/${channelId}`, {
      headers: { Authorization: `Bearer ${await tokenOf(page)}` },
      data: { history_for_new_members: "all" },
    });
    expect(patch.ok(), await patch.text()).toBeTruthy();

    // Direct invite by address: it travels to Bob's home node b.test.
    await openRoomInvite(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Eine Person direkt einladen").fill(bob.address);
    await dialog.getByRole("button", { name: "Einladung senden" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Einladung an ${bob.address} gesendet` })).toBeVisible();
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    const invite = bobPage.getByTestId("invite-list").getByTestId("invite").filter({ hasText: roomName });
    await expect(invite).toBeVisible(CRYPTO);
    await invite.getByRole("button", { name: "Annehmen" }).click();
    await expect(bobPage).toHaveURL(new RegExp(`/n/${A}/rooms/[0-9A-Z]+/channels/${channelId}`), CRYPTO);
    await expect(bobPage.getByTestId("encrypted-marker")).toBeVisible();

    // Alice's device shares the keys through a.test; Bob (of b.test) checks them and reads the older message.
    await expect(message(bobPage, "Vor Bobs Beitritt auf A")).toBeVisible(CRYPTO);
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);
    await send(bobPage, "Hallo aus b.test");
    await expect(message(page, "Hallo aus b.test")).toBeVisible(CRYPTO);

    // a.test stores ciphertext only and nothing waits for Bob any more.
    const stored = await (await page.request.get(`${NODE_A}/api/v1/conversations/${channelId}/messages`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).json();
    expect(JSON.stringify(stored)).not.toContain("Vor Bobs Beitritt");
    expect(JSON.stringify(stored)).not.toContain("history_keys");
    const pending = await (await page.request.get(`${NODE_A}/api/v1/conversations/${channelId}/history-pending`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).json();
    expect(pending.items).toEqual([]);
    await bobPage.context().close();
  });
});
