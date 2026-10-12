// SPDX-License-Identifier: Apache-2.0
// Date of birth at registration, adults-only rooms and channels (protocol PROTOCOL.md §5e, `age.v1`): a minor registers
// through the form, an adult gates a room and a channel in the settings; the minor does not find the room in Discover,
// cannot join it with an invite link and sees the gated channel locked. axe scans every new view.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, adminAccount, bornYearsAgo, createRoomViaApi, inviteCode, loginAs, registerViaApi, registerViaUi, tokenOf } from "./helpers";
import { scaled } from "./timeouts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** Serious and critical WCAG violations of the current view fail the test (the gate of a11y.spec.ts). */
async function axe(page: Page, view: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const failing = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(failing.map((v) => `${view}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test.describe("Age gates", () => {
  test("a minor registers, an adult gates a room and a channel: hidden in Discover, no join by invite, locked channel", async ({ browser, page, request }) => {
    test.setTimeout(scaled(180_000));
    // The registration form asks for the date of birth (and checks it before the node does).
    await page.goto("/login");
    await page.getByRole("tab", { name: "Registrieren" }).click();
    const dob = page.getByLabel("Geburtsdatum", { exact: true });
    await expect(dob).toBeVisible();
    await axe(page, "registration");
    const minor = await registerViaUi(page, { prefix: "teen", dateOfBirth: bornYearsAgo(16) });

    // The adult and their rooms: a public, listed room and a room with a second text channel.
    const adult = await registerViaApi(request, "grown");
    const gatedRoom = await createRoomViaApi(request, adult.token, `Nachtcafe ${Date.now()}`, "public");
    const openRoom = await createRoomViaApi(request, adult.token, "Treffpunkt");
    const channelResp = await request.post(`${NODE}/api/v1/rooms/${openRoom.id}/channels`, { headers: { Authorization: `Bearer ${adult.token}` }, data: { kind: "text", name: "spaet", encrypted: false } });
    expect(channelResp.ok()).toBeTruthy();
    const late = await channelResp.json();
    const minorToken = await tokenOf(page);
    const joined = await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, adult.token, openRoom.id)}/join`, { headers: { Authorization: `Bearer ${minorToken}` }, data: {} });
    expect(joined.ok()).toBeTruthy();

    // The adult gates the room and the channel in the settings.
    const context = await browser.newContext();
    const adultPage = await context.newPage();
    await loginAs(adultPage, adult);
    await adultPage.goto(`/rooms/${gatedRoom.id}/settings/overview`);
    const roomGate = adultPage.getByTestId("room-age-gate");
    await expect(roomGate).toBeVisible();
    await roomGate.selectOption("adults_only");
    await expect(adultPage.getByRole("status").filter({ hasText: "Altersbeschränkung gespeichert" })).toBeVisible();
    await axe(adultPage, "room settings");
    await adultPage.goto(`/rooms/${openRoom.id}/settings/channels?channel=${late.id}`);
    const channelGate = adultPage.getByTestId("channel-age-gate");
    await expect(channelGate).toBeVisible();
    await channelGate.selectOption("adults_only");
    await expect(adultPage.getByRole("status").filter({ hasText: "Altersbeschränkung gespeichert" })).toBeVisible();
    // The adult finds the gated room in Discover, marked 18+.
    await adultPage.goto("/discover");
    const card = adultPage.locator(`[data-testid="discover-room"][data-room="${gatedRoom.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByRole("img", { name: "Nur für Erwachsene" })).toBeVisible();
    await context.close();

    // The minor: not in Discover.
    await page.goto("/discover");
    await expect(page.getByTestId("discover-room").first().or(page.getByText("Keine Räume gefunden.")).first()).toBeVisible();
    await expect(page.locator(`[data-testid="discover-room"][data-room="${gatedRoom.id}"]`)).toHaveCount(0);

    // An invite link explains the gate and the join stays impossible.
    const code = await inviteCode(request, adult.token, gatedRoom.id);
    await page.goto(`/invite/${code}`);
    await expect(page.getByTestId("invite-age-restricted")).toHaveText("Dieser Raum ist nur für Erwachsene. Du kannst ihm nicht beitreten.");
    await expect(page.getByRole("button", { name: "Beitreten" })).toBeDisabled();
    await axe(page, "invite");
    const refused = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${minorToken}` }, data: {} });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("age.restricted");

    // The gated channel stays listed but is locked: a notice, no messages, no composer.
    await page.goto(`/rooms/${openRoom.id}/channels/${late.id}`);
    await expect(page.getByTestId("age-locked")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dieser Kanal ist nur für Erwachsene" })).toBeVisible();
    await expect(page.getByTestId("message-list")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /Nachricht/ })).toHaveCount(0);
    await axe(page, "locked channel");
    expect(minor.username).toContain("teen");
  });

  test("an account without a date of birth is asked once before anything else", async ({ page, request }) => {
    const account = await registerViaApi(request, "old");
    // An account from before age.v1: the operator removes the date (as the node does for older accounts).
    const admin = await adminAccount(request);
    const removed = await request.put(`${NODE}/api/v1/admin/users/${account.userId}/date-of-birth`, { headers: { Authorization: `Bearer ${admin.token}` }, data: { date_of_birth: null } });
    expect(removed.status()).toBe(204);
    await loginAs(page, account);
    await page.goto("/");
    const dialog = page.getByTestId("dob-dialog");
    await expect(dialog).toBeVisible();
    await axe(page, "date of birth dialog");
    await dialog.getByRole("button", { name: "Speichern" }).click();
    await expect(dialog.getByTestId("date-of-birth-error")).toBeVisible();
    await dialog.getByLabel("Geburtsdatum", { exact: true }).fill("1985-03-02");
    await dialog.getByRole("button", { name: "Speichern" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("app-shell")).toBeVisible();
  });
});
