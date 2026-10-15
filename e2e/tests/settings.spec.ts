// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, adminAccount, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, type Account } from "./helpers";
import { createRole } from "./menu-helpers";
import { scaled } from "./timeouts";

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

  test("Overview: set rules (Markdown, shown on the invite page), a member without permissions only sees the permitted sections", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Regel-Raum");
    await inviteAndJoin(request, owner, room.id, bob);
    await loginAs(page, owner);
    await openSettings(page, room.id, "overview");
    // Rules are Markdown (PROTOCOL.md `rules`): the preview renders them as the invite page will.
    const rules = "Sei nett.\n\n- Kein Spam\n- **Keine** Werbung";
    await page.getByLabel("Regeln").fill(rules);
    await page.getByRole("button", { name: "Vorschau", exact: true }).click();
    await expect(page.getByRole("region", { name: "Regeln" }).getByRole("listitem")).toHaveText(["Kein Spam", "Keine Werbung"]);
    await page.getByTestId("overview-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    const resp = await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect((await resp.json()).rules).toBe(rules);

    // Someone invited sees the list on the invite page before accepting the rules.
    const carol = await registerViaApi(request, "carol");
    const invite = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/invites`, { headers: { Authorization: `Bearer ${owner.token}` }, data: {} })).json();
    const carolPage = await (await page.context().browser()!.newContext()).newPage();
    await loginAs(carolPage, carol);
    await carolPage.goto(`/invite/${invite.code}`);
    const shown = carolPage.getByRole("region", { name: "Regeln" });
    await expect(shown.locator("li").first()).toHaveText("Kein Spam");
    await expect(shown.locator("strong")).toHaveText("Keine");
    await carolPage.context().close();

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

  test("no settings page or tab scrolls the app shell, only its own content (tavrn-web#116)", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    const admin = await adminAccount(request);
    const room = await createRoomViaApi(request, admin.token, "Scroll-Raum");
    // A long role list made the Roles tab taller than the viewport; the sr-only legend of its permission editor then
    // escaped the static scroll container and the whole shell scrolled.
    for (let i = 0; i < 30; i++) await createRole(request, admin, room.id, { name: `Rolle ${i}`, position: i + 1 });
    await loginAs(page, admin);
    const userTabs = ["profile", "privacy", "security", "voice", "notifications", "emojis", "sounds", "applications", "language", "devices", "legal"];
    const roomTabs = ["overview", "profile", "roles", "channels", "members", "bans", "invites", "webhooks", "applications", "emojis", "soundboard", "moderation", "audit"];
    const adminTabs = ["overview", "users", "invites", "bans", "entitlements", "tokens", "applications", "federation", "legal", "notices", "audit"];
    const pages = [...userTabs.map((t) => `/settings/${t}`), ...roomTabs.map((t) => `/rooms/${room.id}/settings/${t}`), ...adminTabs.map((t) => `/admin/${t}`)];
    for (const path of pages) {
      await page.goto(path);
      const content = page.locator('main [tabindex="0"].overflow-y-auto');
      await expect(content, path).toBeVisible();
      // Scroll the tab's own container and the window to the very bottom: only the container may move.
      const result = await content.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        window.scrollTo(0, 1e6);
        const d = document.documentElement;
        return { docScrollTop: d.scrollTop, bodyScrollTop: document.body.scrollTop, docOverflow: d.scrollHeight - d.clientHeight, contentTop: el.scrollTop, contentOverflow: el.scrollHeight - el.clientHeight };
      });
      expect(result.docScrollTop, path).toBe(0);
      expect(result.bodyScrollTop, path).toBe(0);
      expect(result.docOverflow, path).toBeLessThanOrEqual(0);
      // The roles tab is the one known to be long: its own container scrolled.
      if (path.endsWith("/settings/roles")) expect(result.contentTop, path).toBeGreaterThan(0);
    }
  });
});
