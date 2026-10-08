// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, openRoomInvite } from "./helpers";

// Invites overview (design note 4.13 item 8): the room settings tab for manage_room and the expiry choice of
// the invite dialog for members with create_invites only.
test.describe("Invites", () => {
  test('Invites tab: create with "nie" and a use limit, list, revoke', async ({ page, request }) => {
    const owner = await registerViaApi(request, "inv");
    const room = await createRoomViaApi(request, owner.token, "Einladungsraum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/invites`);
    await expect(page.getByRole("link", { name: "Einladungen" })).toBeVisible();
    await expect(page.getByText("Es gibt keine aktiven Einladungen.")).toBeVisible();

    await page.getByTestId("invite-max-uses").selectOption("5");
    await page.getByTestId("invite-expiry").selectOption({ label: "Nie" });
    await page.getByTestId("invite-create").click();
    const row = page.getByTestId("invite-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("invite-uses")).toHaveText("0/5 Nutzungen");
    await expect(row.getByTestId("invite-expires")).toHaveText("läuft nie ab");
    await expect(row).toContainText(`von ${owner.username}`);
    const code = await row.getAttribute("data-code");
    const preview = await request.get(`${NODE}/api/v1/invites/${code}`);
    expect(preview.ok()).toBeTruthy();

    await row.getByTestId("invite-revoke").click();
    await expect(page.getByRole("dialog")).toContainText(`Der Link mit dem Code ${code} funktioniert sofort nicht mehr.`);
    await page.getByTestId("invite-revoke-confirm").click();
    await expect(page.getByTestId("invite-row")).toHaveCount(0);
    expect((await request.get(`${NODE}/api/v1/invites/${code}`)).status()).toBe(404);
  });

  test('Member with create_invites: validity up to 30 days, no "nie"; the owner sees the invite', async ({ browser, page, request }) => {
    const owner = await registerViaApi(request, "own");
    const member = await registerViaApi(request, "mem");
    const room = await createRoomViaApi(request, owner.token, "Gildenhalle");
    const code = await inviteCode(request, owner.token, room.id);
    const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${member.token}` }, data: {} });
    expect(join.ok(), await join.text()).toBeTruthy();
    // The API refuses "never" for members without manage_room.
    const never = await request.post(`${NODE}/api/v1/rooms/${room.id}/invites`, { headers: { Authorization: `Bearer ${member.token}` }, data: { expires_hours: 0 } });
    expect(never.status()).toBe(403);

    await loginAs(page, member);
    await page.goto(`/rooms/${room.id}`);
    await openRoomInvite(page);
    const expiry = page.getByTestId("invite-dialog-expiry");
    await expect(expiry).toHaveValue("168");
    await expect(expiry.locator("option")).toHaveText(["1 Stunde", "1 Tag", "7 Tage", "30 Tage"]);
    await expiry.selectOption({ label: "30 Tage" });
    await page.getByRole("button", { name: "Link erzeugen" }).click();
    await expect(page.getByText("Dieser Link ist 30 Tage gültig:")).toBeVisible();
    const link = await page.getByTestId("invite-link").inputValue();
    const memberCode = link.split("/invite/")[1]!;

    // The owner's overview lists the member's invite with its creator and expiry.
    const ownerContext = await browser.newContext({ ...test.info().project.use });
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, owner);
    await ownerPage.goto(`/rooms/${room.id}/settings/invites`);
    const row = ownerPage.locator(`[data-testid="invite-row"][data-code="${memberCode}"]`);
    await expect(row).toContainText(`von ${member.username}`);
    await expect(row.getByTestId("invite-expires")).toContainText("läuft ab");
    await expect(row.getByTestId("invite-uses")).toHaveText("0 Nutzungen");
    // Owners also get "never" in the dialog.
    await ownerPage.goto(`/rooms/${room.id}`);
    await openRoomInvite(ownerPage);
    await expect(ownerPage.getByTestId("invite-dialog-expiry").locator("option")).toHaveText(["1 Stunde", "1 Tag", "7 Tage", "30 Tage", "Nie"]);
    await ownerContext.close();
  });
});
