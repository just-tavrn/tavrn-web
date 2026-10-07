// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, openNavIfMobile, registerViaUi } from "./helpers";
import { createGroup, cryptoAccountViaApi, sendEncrypted, type CryptoAccount } from "./crypto-helpers";
import { openContextMenu } from "./menu-helpers";

// "Keep the full history on this device" (design note 4.4): the client pages the whole history of an encrypted
// channel in the background into the local encrypted index; turned off, the bounded window applies again.
// The window is shortened to 30 seconds for this spec through the development-only override
// `tavrn.dev.searchWindowDays` (production builds always keep 90 days).

const WINDOW_SECONDS = 30;

/** Processes the conversation's handshake log in the test process's client (the browser joined meanwhile). */
async function catchUp(request: APIRequestContext, account: CryptoAccount, conversationId: string) {
  const q = `localhost/${conversationId}`;
  for (let round = 0; round < 10; round++) {
    const since = account.client.currentEpoch(q);
    const resp = await request.get(`${NODE}/api/v1/conversations/${conversationId}/mls/messages?since_epoch=${since}&limit=100`, { headers: { Authorization: `Bearer ${account.token}` } });
    const log = (await resp.json()) as { items: { commit: string }[]; next: number | null };
    for (const item of log.items) {
      try {
        account.client.processHandshake(q, new Uint8Array(Buffer.from(item.commit, "base64url"))).free();
      } catch {
        /* own or stale commit */
      }
    }
    if (!log.next) return;
  }
}

async function toggleFullHistory(page: Page, expected: boolean) {
  await openNavIfMobile(page);
  const row = page.getByTestId("channel-row").filter({ hasText: "allgemein" });
  await openContextMenu(page, row);
  const item = page.getByTestId("channel-menu").getByRole("menuitemcheckbox", { name: "Gesamten Verlauf auf diesem Gerät behalten" });
  await expect(item).toHaveAttribute("aria-checked", String(!expected));
  await item.click();
  await expect(page.getByText(expected ? "Der gesamte Verlauf wird auf diesem Gerät behalten" : "Auf diesem Gerät werden nur noch die letzten 90 Tage behalten")).toBeVisible();
  // Phones: the navigation drawer covers the conversation header; close it again.
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (await overlay.isVisible()) await overlay.click({ position: { x: (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
}

async function search(page: Page, query: string) {
  const panel = page.getByTestId("search-panel");
  if (!(await panel.isVisible())) await page.getByTestId("search-open").click();
  await panel.getByTestId("search-input").fill(query);
  await panel.getByTestId("search-submit").click();
  return panel;
}

test("keep the full history: the background sync finds an old message; when off, the budget applies", async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.addInitScript((days) => localStorage.setItem("tavrn.dev.searchWindowDays", String(days)), WINDOW_SECONDS / 86_400);

  // Alice (owner, crypto in the test process) creates the encrypted channel; Bob joins in the browser.
  const alice = await cryptoAccountViaApi(request, "alice");
  const room = await createRoomViaApi(request, alice.token, "Archivraum", "invite", { encrypted: true });
  const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
  const welcome = room.channels.find((c: { kind: string }) => c.kind === "system").id as string;
  await createGroup(request, alice, channel);
  const code = await inviteCode(request, alice.token, room.id);

  await registerViaUi(page, { prefix: "bob" });
  await page.goto(`/invite/${code}`);
  await page.getByRole("button", { name: "Beitreten" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });

  // Bob looks elsewhere (the welcome channel) while Alice writes more than two pages of history.
  await page.goto(`/rooms/${room.id}/channels/${welcome}`);
  await expect(page.getByTestId("channel-name")).toBeVisible();
  await catchUp(request, alice, channel);
  const firstSent = Date.now();
  await sendEncrypted(request, alice, channel, "Die Zeitkapsel liegt unter der Eiche");
  for (let i = 2; i <= 120; i++) await sendEncrypted(request, alice, channel, `Altlast ${String(i).padStart(3, "0")}`);

  await toggleFullHistory(page, true);
  // The background sync pages the whole history (two pages of 100) and indexes what it decrypts.
  let panel = page.getByTestId("search-panel");
  await expect(async () => {
    panel = await search(page, "zeitkapsel");
    await expect(panel.getByTestId("search-result")).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  const result = panel.getByTestId("search-result");
  await expect(result).toHaveAttribute("data-source", "local");
  await expect(result.locator("mark")).toHaveText("Zeitkapsel");
  await expect(panel.getByTestId("search-status")).toContainText("gesamter Verlauf von 1 verschlüsselten Unterhaltung(en)");

  // Jump: the conversation opens at the oldest message.
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/channels/${channel}\\?m=`));
  await expect(page.locator('article[data-highlighted="true"]')).toContainText("Zeitkapsel", { timeout: 20_000 });
  if (await panel.isVisible()) await panel.getByTestId("search-close").click();

  // Turned off: the window (30 s here, 90 days normally) applies again and evicts the old messages.
  const wait = firstSent + (WINDOW_SECONDS + 5) * 1000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await toggleFullHistory(page, false);
  panel = await search(page, "zeitkapsel");
  await expect(panel.getByTestId("search-empty")).toBeVisible();
  await expect(panel.getByTestId("search-status")).toContainText("letzte 90 Tage von 1 verschlüsselten Unterhaltung(en)");
  await expect(panel.getByTestId("search-status")).not.toContainText("gesamter Verlauf");
});
