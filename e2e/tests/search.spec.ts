// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, send, message } from "./helpers";
import { scaled } from "./timeouts";

// Search (design note 4.4): one search box over the node (unencrypted channels) and the local encrypted index
// (encrypted channels), snippets with highlights, filters, the honest status line, and jumping to a result.

async function api(request: APIRequestContext, path: string, token: string, data: unknown) {
  const resp = await request.post(`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` }, data });
  if (!resp.ok()) throw new Error(`${path}: ${resp.status()} ${await resp.text()}`);
  return resp.json();
}

async function say(request: APIRequestContext, token: string, roomId: string, channelId: string, body: string) {
  return api(request, `/rooms/${roomId}/channels/${channelId}/messages`, token, { content: { type: "text", body } });
}

const phone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

async function openSearch(page: Page) {
  await page.getByTestId("search-open").click();
  const panel = page.getByTestId("search-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("search-input")).toBeFocused();
  return panel;
}

test.describe("Search", () => {
  test("unencrypted channel: hits with highlighting, jump into the history and back", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    const alice = await registerViaApi(request, "alice");
    const room = await createRoomViaApi(request, alice.token, "Suchraum");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await say(request, alice.token, room.id, channel.id, "Der Leuchtturm steht am Kap");
    // Enough newer messages that the jump stays detached: the page around the hit brings 25 newer ones, and a
    // loaded window shorter than the view is filled with one more page of 50 (grouped rows are compact).
    for (let i = 1; i <= 160; i++) await say(request, alice.token, room.id, channel.id, `Füller ${String(i).padStart(3, "0")}`);

    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await expect(message(page, "Füller 160")).toBeVisible();
    // Lazy history: the old message is not loaded.
    await expect(message(page, "Leuchtturm")).toHaveCount(0);

    const panel = await openSearch(page);
    if (phone(page)) {
      // Phones: a full-screen panel.
      const box = (await panel.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
      expect(box.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 1);
    }
    await panel.getByTestId("search-input").fill("leucht");
    await page.keyboard.press("Enter");
    const result = panel.getByTestId("search-result");
    await expect(result).toHaveCount(1);
    await expect(result).toHaveAttribute("data-source", "node");
    await expect(result.locator("mark")).toHaveText("Leuchtturm");
    await expect(result).toContainText("#allgemein");
    await expect(panel.getByTestId("search-status")).toContainText("1 unverschlüsselte(n) Channel(s) in 1 Raum/Räumen");

    // Keyboard: arrow down selects the result, Enter opens it.
    await page.keyboard.press("ArrowDown");
    await expect(result).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\?m=/);
    await expect(message(page, "Leuchtturm")).toBeVisible();
    await expect(page.locator('article[data-highlighted="true"]')).toContainText("Leuchtturm");
    if (phone(page)) await expect(panel).toHaveCount(0);
    else await panel.getByTestId("search-close").click();
    // The history around the target is loaded; the newest messages come back with "jump to latest".
    await expect(message(page, "Füller 160")).toHaveCount(0);
    await page.getByTestId("jump-latest").click();
    await expect(message(page, "Füller 160")).toBeVisible();
  });

  test('Filter by author, scope "Überall" and empty result', async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Treffpunkt");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await api(request, `/invites/${await inviteCode(request, alice.token, room.id)}/join`, bob.token, {});
    await say(request, alice.token, room.id, channel.id, "Treffen um acht");
    await say(request, bob.token, room.id, channel.id, "Treffen verschoben");

    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await expect(message(page, "Treffen verschoben")).toBeVisible();
    const panel = await openSearch(page);
    await panel.getByTestId("search-input").fill("treffen");
    await page.keyboard.press("Enter");
    await expect(panel.getByTestId("search-result")).toHaveCount(2);

    await panel.getByTestId("search-filters-toggle").click();
    await panel.getByTestId("search-filter-author").fill(`${bob.username}@localhost`);
    await panel.getByTestId("search-submit").click();
    const result = panel.getByTestId("search-result");
    await expect(result).toHaveCount(1);
    await expect(result.getByTestId("search-result-author")).toHaveText(bob.username);
    await expect(result).toContainText("verschoben");

    // Everywhere: the node search runs per room the user is in.
    await panel.getByTestId("search-scope-everywhere").click();
    await panel.getByTestId("search-submit").click();
    await expect(panel.getByTestId("search-result")).toHaveCount(1);
    await expect(panel.getByTestId("search-status")).toContainText("Raum/Räumen");

    await panel.getByTestId("search-input").fill("zebra");
    await page.keyboard.press("Enter");
    await expect(panel.getByTestId("search-empty")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });

  test("encrypted channel: read messages in the local index, honest status line, jump", async ({ page, request }) => {
    test.setTimeout(scaled(150_000));
    await registerViaUi(page, { prefix: "alice" });
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Tresor");
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await send(page, "Der Geheimcode lautet Bergkristall");
    await send(page, "Noch etwas anderes");
    await expect(message(page, "Bergkristall")).toBeVisible();
    // A second encrypted channel this device has never opened: "not synced yet".
    const roomId = page.url().match(/rooms\/([^/]+)/)![1]!;
    await api(request, `/rooms/${roomId}/channels`, await tokenOf(page), { kind: "text", name: "zweiter", encrypted: true });

    const panel = await openSearch(page);
    await panel.getByTestId("search-input").fill("bergkri");
    const result = panel.getByTestId("search-result");
    const status = panel.getByTestId("search-status");
    // The index is written a moment after the messages were decrypted; the background sync then covers the channel.
    await expect(async () => {
      await panel.getByTestId("search-submit").click();
      await expect(result).toHaveCount(1, { timeout: scaled(2_000) });
      await expect(status).toContainText("letzte 90 Tage von 1 verschlüsselten Unterhaltung(en)", { timeout: scaled(2_000) });
    }).toPass({ timeout: scaled(45_000) });
    await expect(result).toHaveAttribute("data-source", "local");
    await expect(result.locator("mark")).toHaveText("Bergkristall");
    await expect(status).toContainText("1 verschlüsselte Unterhaltung(en) noch nicht synchronisiert");
    await expect(status).toContainText("0 unverschlüsselte(n) Channel(s)");

    await result.click();
    await expect(page).toHaveURL(/\?m=/);
    await expect(page.locator('article[data-highlighted="true"]')).toContainText("Bergkristall");
  });
});
