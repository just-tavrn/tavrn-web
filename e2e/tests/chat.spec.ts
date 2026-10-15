// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, registerViaUi, uniqueName, logoutViaUi, openRoomInvite } from "./helpers";
import { createRole, joinRoom, postMessage } from "./menu-helpers";

test.describe("Text chat", () => {
  test("Register, create a room, create a channel, send, edit and delete a message (encrypted)", async ({ page }) => {
    await registerViaUi(page, { displayName: "UI Testerin" });
    await expect(page.getByTestId("me-name")).toHaveText("UI Testerin");

    // Create a room through the dialog
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Gilde");
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("room-name")).toHaveText("Gilde");
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    // New channels are end-to-end encrypted: no plaintext notice, a lock instead.
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByTestId("unencrypted-banner")).toHaveCount(0);

    // Create a channel
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Channel erstellen" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Taktik Besprechung");
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await openNavIfMobile(page);
    await page.getByRole("link", { name: "taktik-besprechung" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("taktik-besprechung");

    // Send, edit and delete a message
    await page.getByLabel("Nachricht", { exact: true }).fill("Hallo Gilde!");
    await page.keyboard.press("Enter");
    const message = page.getByTestId("message").filter({ hasText: "Hallo Gilde!" });
    await expect(message).toBeVisible();
    await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue("");
    await message.hover();
    await message.getByRole("button", { name: "Nachricht bearbeiten" }).click();
    await page.getByLabel("Neuer Text").fill("Hallo Gilde, korrigiert!");
    await page.keyboard.press("Enter");
    const edited = page.getByTestId("message").filter({ hasText: "Hallo Gilde, korrigiert!" });
    await expect(edited).toContainText("(bearbeitet)");
    await edited.hover();
    await edited.getByRole("button", { name: "Nachricht löschen" }).click();
    await page.getByTestId("confirm-ok").click();
    await expect(edited).toHaveCount(0);
  });

  test("Invite by link; a second browser sees messages live", async ({ browser, page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const room = await createRoomViaApi(request, alice.token, "Live-Raum");
    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}`);
    await openRoomInvite(page);
    await page.getByRole("button", { name: "Link erzeugen" }).click();
    const link = await page.getByTestId("invite-link").inputValue();
    expect(link).toMatch(/\/invite\//);
    await page.getByRole("button", { name: "Fertig" }).click();

    const bob = await registerViaApi(request, "bob");
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAs(bobPage, bob);
    await bobPage.goto(link);
    await expect(bobPage.getByTestId("invite-room-name")).toHaveText("Live-Raum");
    await bobPage.getByRole("button", { name: "Beitreten" }).click();
    await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");

    // Alice sees Bob in the member list (live), Bob sees Alice's message (live).
    await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "ready");
    await expect(bobPage.getByTestId("ws-status")).toHaveAttribute("data-status", "ready");
    await page.getByLabel("Nachricht", { exact: true }).fill("Willkommen, Bob!");
    await page.keyboard.press("Enter");
    await expect(bobPage.getByTestId("message").filter({ hasText: "Willkommen, Bob!" })).toBeVisible();
    await bobPage.getByLabel("Nachricht", { exact: true }).fill("Danke!");
    await bobPage.keyboard.press("Enter");
    await expect(page.getByTestId("message").filter({ hasText: "Danke!" })).toBeVisible();
    await bobContext.close();
  });

  test("A public room appears under Discover and can be joined", async ({ page, request }) => {
    const owner = await registerViaApi(request, "owner");
    const roomName = `Offener Raum ${uniqueName("")}`;
    const room = await createRoomViaApi(request, owner.token, roomName, "public");
    const guest = await registerViaApi(request, "guest");
    await loginAs(page, guest);
    await page.goto("/");
    const card = page.getByTestId("discover-list").locator("li").filter({ hasText: roomName });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Beitreten" }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/channels/`));
    await openNavIfMobile(page);
    await expect(page.getByTestId("room-name")).toHaveText(roomName);
  });

  test("Signing out leads to the login page and invalidates the session", async ({ page, request }) => {
    const account = await registerViaApi(request, "logout");
    await loginAs(page, account);
    await page.goto("/");
    await openNavIfMobile(page);
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);
    const resp = await request.post("/api/v1/auth/refresh", { data: { refresh_token: account.refresh } });
    expect(resp.status()).toBe(401);
  });

  test("mentions are pills: your own name and @everyone stand out, the row is marked (tavrn-web#122)", async ({ page, request }, info) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Mention-Raum");
    await joinRoom(request, owner, room.id, bob);
    await createRole(request, owner, room.id, { name: "Raid Leads", position: 1 });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await postMessage(request, owner.token, channel.id, `Hallo @${bob.username}, @Raid Leads und @everyone: Start um 20 Uhr`, { mentions: [`${bob.username}@localhost`], mentions_everyone: true });
    await postMessage(request, owner.token, channel.id, `Nur @${owner.username} selbst`, { mentions: [`${owner.username}@localhost`] });
    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}`);
    const row = page.getByTestId("message").filter({ hasText: "Start um 20 Uhr" });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-mentioned", "true");
    await expect(row.locator('[data-mention="self"]')).toHaveText(`@${bob.username}`);
    await expect(row.locator('[data-mention="everyone"]')).toHaveText("@everyone");
    await expect(row.locator('[data-mention="role"]')).toHaveText("@Raid Leads");
    const other = page.getByTestId("message").filter({ hasText: "selbst" });
    await expect(other.locator('[data-mention="user"]')).toHaveText(`@${owner.username}`);
    await expect(other).not.toHaveAttribute("data-mentioned", "true");
    // The pills are visible as such: a background and a text colour that differ from the plain text around them.
    const look = await row.locator('[data-mention="self"]').evaluate((el) => {
      const s = getComputedStyle(el);
      const p = getComputedStyle(el.parentElement!);
      return { bg: s.backgroundColor, color: s.color, parentColor: p.color, parentBg: p.backgroundColor };
    });
    expect(look.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(look.bg).not.toBe(look.parentBg);
    if (info.project.name === "chromium") await page.screenshot({ path: "test-results/uipolish/mentions.png" });
  });
});
