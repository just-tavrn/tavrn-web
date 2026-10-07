// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, type Account } from "./helpers";

async function inviteAndJoin(request: Parameters<typeof registerViaApi>[0], owner: Account, roomId: string, member: Account) {
  const inv = await request.post(`${NODE}/api/v1/rooms/${roomId}/invites`, { headers: { Authorization: `Bearer ${owner.token}` }, data: {} });
  const code = (await inv.json()).code as string;
  const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${member.token}` }, data: {} });
  expect(join.ok()).toBeTruthy();
}

async function openSettings(page: Page, roomId: string, tab: string) {
  await page.goto(`/rooms/${roomId}/settings/${tab}`);
  await expect(page.getByRole("heading", { name: /Einstellungen ·/ })).toBeVisible();
}

test.describe("Room settings", () => {
  test("Create a role, grant permissions, assign it: the member may then create channels", async ({ browser, page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Rollen-Raum");
    await inviteAndJoin(request, owner, room.id, bob);

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAs(bobPage, bob);
    await bobPage.goto(`/rooms/${room.id}`);
    await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");
    await openNavIfMobile(bobPage);
    await expect(bobPage.getByRole("button", { name: "Channel erstellen" })).toHaveCount(0);

    await loginAs(page, owner);
    await openSettings(page, room.id, "roles");
    await page.getByRole("button", { name: "+ Rolle erstellen" }).click();
    const editor = page.getByTestId("role-editor");
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Neue Rolle");
    await editor.getByLabel("Name", { exact: true }).fill("Mod");
    await editor.getByLabel("Channels verwalten").check();
    await editor.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Rolle gespeichert" })).toBeVisible();
    await expect(page.getByTestId("role-list")).toContainText("Mod");

    await openSettings(page, room.id, "members");
    await page.getByRole("button", { name: `${bob.username} bearbeiten` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Mod").check();
    await dialog.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Mitglied gespeichert" })).toBeVisible();
    await expect(page.getByTestId("settings-member-list")).toContainText("Mod");

    // Bob receives the permission live (event member.update → room reloaded).
    await openNavIfMobile(bobPage);
    await expect(bobPage.getByRole("button", { name: "Channel erstellen" })).toBeVisible({ timeout: 10000 });
    await bobContext.close();
  });

  test("Channel settings: turning on encryption removes the marker, the audit log records it", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Channel-Raum");
    await loginAs(page, owner);
    await openSettings(page, room.id, "channels");
    const editor = page.getByTestId("channel-editor");
    await editor.getByLabel("Thema").fill("Nur Wichtiges");
    await editor.getByTestId("encrypted-toggle").check();
    await editor.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Channel gespeichert" })).toBeVisible();

    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByTestId("unencrypted-banner")).toHaveCount(0);
    await expect(page.getByTestId("message-list")).toContainText("Verschlüsselung eingeschaltet");

    await openSettings(page, room.id, "audit");
    await expect(page.getByTestId("audit-list")).toContainText("channel.encryption");
    await expect(page.getByTestId("audit-list")).toContainText("room.create");
  });

  test("Bulk deletion with preview and confirmation; ban and unban", async ({ browser, page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Mod-Raum");
    await inviteAndJoin(request, owner, room.id, bob);
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    for (const text of ["eins", "zwei", "drei"]) {
      await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channelId}/messages`, { headers: { Authorization: `Bearer ${bob.token}` }, data: { content: { type: "text", body: text } } });
    }
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAs(bobPage, bob);
    await bobPage.goto(`/rooms/${room.id}/channels/${channelId}`);
    await expect(bobPage.getByTestId("message")).toHaveCount(3);

    await loginAs(page, owner);
    await openSettings(page, room.id, "moderation");
    await page.getByLabel("Autor").selectOption({ label: `${bob.username} (${bob.username}@localhost)` });
    await page.getByRole("button", { name: "Vorschau" }).click();
    await expect(page.getByTestId("purge-preview")).toContainText("3");
    await page.getByRole("button", { name: "Endgültig löschen" }).click();
    await page.getByLabel("Bestätigung").fill("LÖSCHEN");
    await page.getByRole("button", { name: "Jetzt löschen" }).click();
    await expect(page.getByRole("status").filter({ hasText: "3 Nachrichten endgültig gelöscht" })).toBeVisible();
    await expect(bobPage.getByTestId("message")).toHaveCount(0);

    await openSettings(page, room.id, "bans");
    await page.getByLabel("Ban-Ziel").fill(`${bob.username}@localhost`);
    await page.getByLabel("Ban-Grund").fill("Test");
    await page.getByRole("button", { name: "Bannen" }).click();
    await expect(page.getByTestId("ban-list")).toContainText(`${bob.username}@localhost`);
    await expect(bobPage.getByRole("status").filter({ hasText: "verbannt" })).toBeVisible();
    await page.getByRole("button", { name: "Aufheben" }).click();
    await expect(page.getByTestId("ban-list")).toContainText("Keine Bans");
    await bobContext.close();
  });

  test("Overview: set rules, a member without permissions only sees the permitted sections", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Regel-Raum");
    await inviteAndJoin(request, owner, room.id, bob);
    await loginAs(page, owner);
    await openSettings(page, room.id, "overview");
    await page.getByLabel("Regeln").fill("Sei nett.");
    await page.getByTestId("overview-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    const resp = await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect((await resp.json()).rules).toBe("Sei nett.");

    const bobPage = await (await page.context().browser()!.newContext()).newPage();
    await loginAs(bobPage, bob);
    await openSettings(bobPage, room.id, "overview");
    const nav = bobPage.getByRole("navigation", { name: "Einstellungsbereiche" });
    await expect(nav).toContainText("Übersicht");
    await expect(nav).toContainText("Mitglieder");
    await expect(nav).not.toContainText("Rollen");
    await expect(nav).not.toContainText("Moderation");
    await expect(bobPage.getByLabel("Name", { exact: true })).toBeDisabled();
    await bobPage.context().close();
  });
});
