// SPDX-License-Identifier: Apache-2.0
/**
 * GDPR data rights (design note 4.14 item 3): "My data" with the summary and the JSON download, account deletion with the
 * confirmation phrase, the "Deleted user" in a room, and the admin's undo. Phone and desktop.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { NODE, adminAccount, confirmWithPassword, createRoomViaApi, inviteCode, loginAs, registerViaApi, uniqueName } from "./helpers";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe("My data and deleting the account", () => {
  test('Download the data, delete the account with the phrase, "Gelöschter Nutzer" in the room, the admin undoes it', async ({ browser, page, request }) => {
    test.setTimeout(120_000);
    const owner = await registerViaApi(request, "owner");
    const leaver = await registerViaApi(request, "leaver");
    const room = await createRoomViaApi(request, owner.token, "Abschied");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const code = await inviteCode(request, owner.token, room.id);
    expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: auth(leaver.token), data: {} })).ok()).toBeTruthy();
    const posted = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: auth(leaver.token), data: { content: { type: "text", body: "Bis bald, alle zusammen" } } });
    expect(posted.ok()).toBeTruthy();

    // "My data" in the profile settings: summary and the JSON archive (needs the password again).
    await loginAs(page, leaver);
    await page.goto("/settings/profile");
    await page.getByTestId("my-data-show").click();
    await expect(page.getByTestId("data-category-messages")).toContainText("1");
    await expect(page.getByTestId("data-category-rooms")).toBeVisible();
    const downloading = page.waitForEvent("download");
    await page.getByTestId("my-data-download").click();
    await confirmWithPassword(page, leaver.password);
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^tavrn-export-${leaver.username}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
    const archive = JSON.parse(readFileSync((await download.path())!, "utf8"));
    expect(archive.format).toBe("tavrn.export.v1");
    expect(archive.account.address).toBe(`${leaver.username}@localhost`);
    expect(archive.messages.some((m: { content?: { body?: string } }) => m.content?.body === "Bis bald, alle zusammen")).toBeTruthy();
    expect(JSON.stringify(archive)).not.toContain("argon2");

    // Delete the account: the phrase is the username; the confirmation asks for the password again.
    await page.goto("/settings/privacy");
    await page.getByTestId("delete-account-open").click();
    const confirm = page.getByTestId("delete-account-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("delete-confirm").fill("falsch");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("delete-confirm").fill(leaver.username);
    await confirm.click();
    await confirmWithPassword(page, leaver.password);
    await expect(page).toHaveURL(/\/login\?deleted=1/);
    await expect(page.getByTestId("account-deleted-notice")).toBeVisible();
    const gone = await request.get(`${NODE}/api/v1/users/me`, { headers: auth(leaver.token) });
    expect(gone.status()).toBe(401);

    // The owner sees the message as "Deleted user" without avatar or profile.
    const ownerContext = await browser.newContext({ ...test.info().project.use });
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, owner);
    await ownerPage.goto(`/rooms/${room.id}/channels/${channel.id}`);
    const message = ownerPage.getByTestId("message").filter({ hasText: "Bis bald, alle zusammen" });
    await expect(message.getByTestId("message-author")).toHaveText("Gelöschter Nutzer");
    await expect(message.getByTestId("deleted-avatar")).toBeVisible();
    await expect(message.getByTestId("message-avatar")).toHaveCount(0);
    await ownerContext.close();

    // The node admin restores the account within the grace period.
    const admin = await adminAccount(request);
    const adminContext = await browser.newContext({ ...test.info().project.use });
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, admin);
    await adminPage.goto("/admin/users");
    await adminPage.getByLabel("Nutzer suchen").fill(leaver.username);
    const row = adminPage.getByTestId("admin-user-list").locator("li").filter({ hasText: leaver.username });
    await expect(row.getByTestId("admin-user-deleted")).toBeVisible();
    await row.getByTestId("admin-undelete").click();
    await expect(row.getByTestId("admin-user-deleted")).toHaveCount(0);
    await adminContext.close();
    const login = await request.post(`${NODE}/api/v1/auth/login`, { data: { username: leaver.username, password: leaver.password, device_name: "e2e" } });
    expect(login.ok()).toBeTruthy();
    expect((await login.json()).status).toBe("enrollment_required");
  });

  test("an owner hands the room over from the deletion dialog, then the account goes (MODERATION.md §4)", async ({ page, request }) => {
    test.setTimeout(120_000);
    const owner = await registerViaApi(request, "owner");
    const heir = await registerViaApi(request, "heir");
    const name = uniqueName("Erbe");
    const room = await createRoomViaApi(request, owner.token, name);
    expect((await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, owner.token, room.id)}/join`, { headers: auth(heir.token), data: {} })).ok()).toBeTruthy();

    await loginAs(page, owner);
    await page.goto("/settings/privacy");
    await page.getByTestId("delete-account-open").click();
    await page.getByTestId("delete-confirm").fill(owner.username);
    await page.getByTestId("delete-account-confirm").click();
    await confirmWithPassword(page, owner.password);
    // The account still owns the room: transfer it instead of being refused.
    const owned = page.getByTestId("delete-owned-rooms");
    await expect(owned).toContainText(name);
    await owned.getByTestId("delete-transfer-room").click();
    const transfer = page.getByTestId("transfer-dialog");
    await transfer.getByTestId("transfer-target").selectOption({ label: `${heir.username} (${heir.username}@localhost)` });
    await transfer.getByTestId("transfer-confirm").click();
    if (await page.getByTestId("reauth-dialog").isVisible().catch(() => false)) await confirmWithPassword(page, owner.password);
    await expect(transfer).toHaveCount(0);
    await expect(page.getByTestId("delete-owned-rooms")).toHaveCount(0);
    const detail = await (await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth(heir.token) })).json();
    expect(detail.owner_id).toBe(heir.userId);

    await page.getByTestId("delete-account-confirm").click();
    if (await page.getByTestId("reauth-dialog").isVisible().catch(() => false)) await confirmWithPassword(page, owner.password);
    await expect(page).toHaveURL(/\/login\?deleted=1/);
  });
});
