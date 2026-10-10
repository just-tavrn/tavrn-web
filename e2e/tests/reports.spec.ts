// SPDX-License-Identifier: Apache-2.0
/**
 * Reports (protocol MODERATION.md §1): a member reports an end-to-end encrypted message and releases its plaintext
 * with the message before it after an explicit consent; the room's moderator reads it labelled as released by the
 * reporter and times the author out from the inbox. A room reported from the header menu reaches the node admins.
 * Phone and desktop.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { NODE, adminAccount, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, registerViaUi, uniqueName } from "./helpers";
import { createGroup, cryptoAccountViaApi, sendEncrypted, type CryptoAccount } from "./crypto-helpers";
import { joinRoom, openContextMenu } from "./menu-helpers";

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Processes the conversation's handshake log in the test process's client (the browser joined meanwhile). */
async function catchUp(request: APIRequestContext, account: CryptoAccount, conversationId: string) {
  const q = `localhost/${conversationId}`;
  for (let round = 0; round < 10; round++) {
    const since = account.client.currentEpoch(q);
    const resp = await request.get(`${NODE}/api/v1/conversations/${conversationId}/mls/messages?since_epoch=${since}&limit=100`, auth(account.token));
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

test.describe("Reports", () => {
  test("an encrypted message is reported with released plaintext; the moderator times the author out", async ({ browser, page, request }) => {
    test.setTimeout(180_000);
    const owner = await registerViaApi(request, "owner");
    const room = await createRoomViaApi(request, owner.token, uniqueName("Meldestelle"), "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    // Mallory's encryption runs in the test process; she creates the channel's group.
    const mallory = await cryptoAccountViaApi(request, "mallory");
    await joinRoom(request, owner, room.id, mallory);
    await createGroup(request, mallory, channel);

    // The reporter joins in the browser and reads Mallory's messages.
    await registerViaUi(page, { prefix: "melder" });
    await page.goto(`/invite/${await inviteCode(request, owner.token, room.id)}`);
    await page.getByRole("button", { name: "Beitreten" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });
    await catchUp(request, mallory, channel);
    await sendEncrypted(request, mallory, channel, "Hallo zusammen");
    await sendEncrypted(request, mallory, channel, "Ich weiß, wo du wohnst");
    const bad = page.getByTestId("message").filter({ hasText: "Ich weiß, wo du wohnst" });
    await expect(bad).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("message").filter({ hasText: "Hallo zusammen" })).toBeVisible();

    // Report it: nothing is released without the consent, then the dialog shows exactly what is shared.
    await openContextMenu(page, bad);
    await page.getByTestId("message-menu").getByRole("menuitem", { name: "Nachricht melden" }).click();
    const dialog = page.getByTestId("report-dialog");
    await expect(dialog).toContainText("Moderatoren");
    await dialog.getByTestId("report-category").selectOption("harassment");
    await dialog.getByTestId("report-detail").fill("Eine Drohung");
    await expect(dialog.getByTestId("report-evidence-list")).toHaveCount(0);
    await dialog.getByTestId("report-consent").check();
    const list = dialog.getByTestId("report-evidence-list");
    await expect(list).toContainText("Hallo zusammen");
    await expect(list).toContainText("Ich weiß, wo du wohnst");
    await expect(dialog.getByTestId("report-evidence-reported")).toBeDisabled();
    await expect(dialog.getByTestId("report-evidence-reported")).toBeChecked();
    await dialog.getByTestId("report-submit").click();
    await expect(page.getByText("Meldung gesendet")).toBeVisible();

    // The owner moderates: the badge, the evidence with its label, the timeout from the inbox.
    const modContext = await browser.newContext({ ...test.info().project.use });
    const mod = await modContext.newPage();
    await loginAs(mod, owner);
    await mod.goto(`/rooms/${room.id}/channels/${channel}`);
    await openNavIfMobile(mod);
    await expect(mod.getByTestId("room-reports-badge")).toHaveText("1", { timeout: 20_000 });
    // The badge sits on the room header's chevron; "Room settings" in its menu shows the count and opens the inbox.
    await mod.getByTestId("room-header-menu").click();
    const settings = mod.getByTestId("room-menu").getByTestId("room-settings-button");
    await expect(settings).toHaveAccessibleName("Raumeinstellungen · 1 offene Meldung");
    await settings.click();
    await expect(mod).toHaveURL(new RegExp(`/rooms/${room.id}/settings/reports$`));
    await expect(mod.getByTestId("reports-tab-badge")).toHaveText("1");
    const row = mod.getByTestId("report-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Belästigung oder Hass");
    await row.click();
    const detail = mod.getByTestId("report-detail");
    await expect(detail.getByTestId("report-reporter")).toContainText("melder");
    await expect(detail.getByTestId("report-text")).toHaveText("Eine Drohung");
    await expect(detail.getByTestId("report-evidence-label")).toContainText("nicht geprüft");
    await expect(detail.getByTestId("report-evidence-entry")).toHaveCount(2);
    await expect(detail.locator('[data-testid="report-evidence-entry"][data-reported="true"]')).toContainText("Ich weiß, wo du wohnst");
    await detail.getByTestId("report-timeout-minutes").selectOption("60");
    await detail.getByTestId("report-action-timeout").click();
    const confirm = mod.getByTestId("report-action-confirm");
    await confirm.getByRole("button", { name: "Timeout" }).click();
    await expect(mod.getByTestId("report-row")).toHaveCount(0, { timeout: 20_000 });
    await mod.getByTestId("reports-status-filter").selectOption("resolved");
    await expect(mod.getByTestId("report-row")).toHaveCount(1);
    await expect(mod.getByTestId("reports-tab-badge")).toHaveCount(0);
    await modContext.close();

    // The node did it with the owner's rights and noted the report in the audit log.
    const members = (await (await request.get(`${NODE}/api/v1/rooms/${room.id}/members`, auth(owner.token))).json()) as { user: { id: string }; timeout_until: string | null }[];
    expect(members.find((m) => m.user.id === mallory.userId)?.timeout_until).toBeTruthy();
    const log = (await (await request.get(`${NODE}/api/v1/rooms/${room.id}/audit-log`, auth(owner.token))).json()) as { action: string; meta: { report_id?: string } }[];
    expect(log.find((e) => e.action === "member.timeout")?.meta.report_id).toBeTruthy();
  });

  test.describe("in English", () => {
    test.use({ locale: "en-US" });
    test("the action buttons of a report keep icon and label on one line", async ({ page, request }, info) => {
      // At 1440 px the "Time out" button used to wrap (the icon above the label) next to its duration select.
      test.skip(info.project.name !== "chromium", "the desktop width of the screenshot run");
      const owner = await registerViaApi(request, "owner");
      const member = await registerViaApi(request, "member");
      const reporter = await registerViaApi(request, "reporter");
      const room = await createRoomViaApi(request, owner.token, uniqueName("Actions"));
      await joinRoom(request, owner, room.id, member);
      await joinRoom(request, owner, room.id, reporter);
      const created = await request.post(`${NODE}/api/v1/reports`, { ...auth(reporter.token), data: { kind: "user", user: `${member.username}@localhost`, room_id: room.id, category: "spam", detail: "" } });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.setViewportSize({ width: 1440, height: 900 });
      await loginAs(page, owner);
      await page.goto(`/rooms/${room.id}/settings/reports`);
      await page.getByTestId("report-row").click();
      const bar = page.getByTestId("report-detail").getByTestId("report-action-bar");
      await expect(bar.getByTestId("report-action-timeout")).toContainText("Time out");
      const heights = await bar.locator("button[data-testid^=report-action-]").evaluateAll((buttons) => buttons.map((b) => [b.getAttribute("data-testid"), Math.round(b.getBoundingClientRect().height)]));
      expect(heights.length).toBeGreaterThanOrEqual(3);
      for (const [id, h] of heights) expect(h, String(id)).toBeLessThanOrEqual(44);
    });
  });

  test("a room reported from its header menu reaches the node admins, who dismiss it", async ({ browser, page, request }) => {
    test.setTimeout(120_000);
    const owner = await registerViaApi(request, "owner");
    const member = await registerViaApi(request, "member");
    const name = uniqueName("Zwielicht");
    const room = await createRoomViaApi(request, owner.token, name);
    await joinRoom(request, owner, room.id, member);
    await loginAs(page, member);
    await page.goto(`/rooms/${room.id}`);
    await openNavIfMobile(page);
    await page.getByTestId("room-header-menu").click();
    await page.getByTestId("room-menu").getByRole("menuitem", { name: "Raum melden" }).click();
    const dialog = page.getByTestId("report-dialog");
    await expect(dialog).toContainText("Admins");
    await dialog.getByTestId("report-category").selectOption("illegal");
    await dialog.getByTestId("report-submit").click();
    await expect(page.getByText("Meldung gesendet")).toBeVisible();

    const admin = await adminAccount(request);
    const adminContext = await browser.newContext({ ...test.info().project.use });
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, admin);
    await adminPage.goto("/admin/reports");
    await adminPage.getByTestId("reports-scope-filter").selectOption("node");
    const row = adminPage.getByTestId("report-row").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Illegale Inhalte");
    await row.click();
    const detail = adminPage.getByTestId("report-detail");
    await detail.getByTestId("report-status").selectOption("dismissed");
    await detail.getByTestId("report-note").fill("Kein Verstoß");
    await detail.getByTestId("report-save").click();
    await expect(adminPage.getByTestId("report-row").filter({ hasText: name })).toHaveCount(0);
    await adminContext.close();
  });
});
