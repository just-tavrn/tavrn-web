// SPDX-License-Identifier: Apache-2.0
// Room rules on every join path and the room's privacy notice and legal notice (tavrn-web#195, PROTOCOL.md §6b): the
// owner writes the privacy notice from the template in Room settings → "Privacy & legal"; a user joining from Discover
// gets the dialog with the rules, the checkbox and the link to the notice; a personal invitation accepted from the
// invite list shows the same dialog; members open the notice and the rules from the room menu. A signed-out visitor
// of an invite link sees the preview, creates an account and comes back to the join block. axe scans the tab, the
// dialogs and the signed-out preview.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, registerViaUi, uniqueName, type Account } from "./helpers";
import { scaled } from "./timeouts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const auth = (a: Account) => ({ Authorization: `Bearer ${a.token}` });

async function scan(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

async function setRoom(request: APIRequestContext, owner: Account, roomId: string, data: Record<string, unknown>) {
  const resp = await request.patch(`${NODE}/api/v1/rooms/${roomId}`, { headers: auth(owner), data });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

test.describe("Room rules and legal documents on every join path", () => {
  test("owner writes the privacy notice; Discover join shows rules, checkbox and the notice; members open it from the room menu", async ({ browser, page, request }) => {
    test.setTimeout(scaled(120_000));
    const alice = await registerViaApi(request, "rlalice");
    const bob = await registerViaApi(request, "rlbob");
    const name = uniqueName("Regelraum ");
    const room = await createRoomViaApi(request, alice.token, name, "public");
    await setRoom(request, alice, room.id, { rules: "Sei **nett**.", legal_notice: "Betrieben von Alice" });

    // The owner: Room settings → "Datenschutz & Impressum", template, save.
    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/settings/legal`);
    const privacy = page.getByLabel("Datenschutzhinweise (Markdown)");
    await expect(privacy).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Impressum (Markdown)")).toHaveValue("Betrieben von Alice");
    await page.getByTestId("room-legal-privacy-template").click();
    await expect(privacy).toHaveValue(/Datenschutzhinweise für den Raum/);
    await privacy.fill("# Datenschutz\n\nWir speichern Nachrichten.");
    await page.getByTestId("room-legal-privacy-preview").click();
    await expect(page.getByTestId("room-doc-privacy")).toContainText("Wir speichern Nachrichten.");
    await scan(page, '[data-testid="room-legal-privacy"]');
    await page.getByTestId("room-legal-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    const preview = await (await request.get(`${NODE}/api/v1/rooms/${room.id}/preview`)).json();
    expect(preview.privacy_notice).toBe("# Datenschutz\n\nWir speichern Nachrichten.");

    // Bob joins from Discover: the dialog with the rules, the checkbox and both documents.
    const bobContext = await browser.newContext({ ...test.info().project.use });
    const bobPage = await bobContext.newPage();
    await loginAs(bobPage, bob);
    await bobPage.goto("/discover");
    await bobPage.getByTestId("discover-search").fill(name);
    const card = bobPage.locator(`[data-testid="discover-room"][data-room="${room.id}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: new RegExp(`^Beitreten: ${name}`) }).click();
    const dialog = bobPage.getByRole("dialog", { name: `${name} beitreten` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("room-rules")).toContainText("Sei nett.");
    const join = dialog.getByTestId("join-room-submit");
    await expect(join).toBeDisabled();
    await dialog.getByTestId("room-doc-link-privacy").click();
    await expect(dialog.getByTestId("room-doc-privacy")).toContainText("Wir speichern Nachrichten.");
    await expect(dialog.getByTestId("room-doc-link-legal")).toBeVisible();
    await scan(bobPage, '[data-testid="join-room-dialog"]');
    await dialog.getByTestId("accept-rules").check();
    await join.click();
    await expect(bobPage).toHaveURL(new RegExp(`/rooms/${room.id}`), { timeout: 20_000 });

    // As a member: the room menu opens the notice; the settings tab shows both, read-only.
    await openNavIfMobile(bobPage);
    await bobPage.getByTestId("room-header-menu").click();
    await bobPage.getByTestId("room-menu").getByTestId("room-privacy-notice").click();
    const doc = bobPage.getByTestId("room-doc-dialog");
    await expect(doc.getByTestId("room-doc-privacy")).toContainText("Wir speichern Nachrichten.");
    await scan(bobPage, '[data-testid="room-doc-dialog"]');
    await bobPage.keyboard.press("Escape");
    // "Show rules" opens the rules read-only.
    await bobPage.getByTestId("room-header-menu").click();
    await bobPage.getByTestId("room-menu").getByTestId("room-show-rules").click();
    const rulesDialog = bobPage.getByTestId("room-rules-dialog");
    await expect(rulesDialog.getByTestId("room-rules")).toContainText("Sei nett.");
    await expect(rulesDialog.getByRole("checkbox")).toHaveCount(0);
    await scan(bobPage, '[data-testid="room-rules-dialog"]');
    await bobPage.keyboard.press("Escape");
    await bobPage.goto(`/rooms/${room.id}/settings/legal`);
    await expect(bobPage.getByTestId("room-legal-read").getByTestId("room-doc-legal")).toContainText("Betrieben von Alice");
    await expect(bobPage.getByRole("textbox")).toHaveCount(0);
    await scan(bobPage, '[data-testid="room-legal-read"]');
    await bobContext.close();
  });

  test("a personal invitation from the invite list shows the rules before the join", async ({ page, request }) => {
    test.setTimeout(scaled(90_000));
    const alice = await registerViaApi(request, "rlowner");
    const carol = await registerViaApi(request, "rlcarol");
    const name = uniqueName("Einladungsraum ");
    const room = await createRoomViaApi(request, alice.token, name);
    await setRoom(request, alice, room.id, { rules: "Keine Spoiler." });
    const direct = await request.post(`${NODE}/api/v1/rooms/${room.id}/invites/direct`, { headers: auth(alice), data: { user: carol.username } });
    expect(direct.ok(), await direct.text()).toBeTruthy();

    await loginAs(page, carol);
    await page.goto("/");
    const row = page.getByTestId("invite").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: "Annehmen" }).click();
    const dialog = page.getByRole("dialog", { name: `${name} beitreten` });
    await expect(dialog.getByTestId("room-rules")).toContainText("Keine Spoiler.");
    await expect(dialog.getByTestId("join-room-submit")).toBeDisabled();
    await expect(dialog.getByTestId("room-legal-links")).toHaveCount(0);
    await dialog.getByTestId("accept-rules").check();
    await dialog.getByTestId("join-room-submit").click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}`), { timeout: 20_000 });
    const members = await (await request.get(`${NODE}/api/v1/rooms/${room.id}/members`, { headers: auth(alice) })).json();
    expect(members.map((m: { user: { username: string } }) => m.user.username)).toContain(carol.username);
  });

  test("signed out, an invite link previews the room; the new account comes back to the join block", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    const alice = await registerViaApi(request, "rlhost");
    const name = uniqueName("Vorschauraum ");
    const room = await createRoomViaApi(request, alice.token, name);
    await setRoom(request, alice, room.id, { rules: "Sei **freundlich**.", privacy_notice: "Wir speichern Nachrichten.", description: "Ein ruhiger Ort." });
    const code = await inviteCode(request, alice.token, room.id);

    await page.goto(`/invite/${code}`);
    await expect(page.getByTestId("invite-room-name")).toHaveText(name);
    await expect(page.getByTestId("invite-room-description")).toHaveText("Ein ruhiger Ort.");
    await expect(page.getByTestId("room-rules")).toContainText("Sei freundlich.");
    await expect(page.getByTestId("accept-rules")).toHaveCount(0);
    await page.getByTestId("room-doc-link-privacy").click();
    await expect(page.getByTestId("room-doc-privacy")).toContainText("Wir speichern Nachrichten.");
    await expect(page.getByRole("link", { name: "Zum Beitreten anmelden" })).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/invite/${code}`)}`);
    await scan(page, '[role="main"]');

    // "Konto erstellen": the registration wizard, then back on the invite, signed in; nothing is joined yet.
    await page.getByRole("link", { name: "Konto erstellen" }).click();
    await expect(page).toHaveURL(/\/login\?mode=register&next=/);
    await registerViaUi(page, { prefix: "rlgast", here: true });
    await expect(page).toHaveURL(new RegExp(`/invite/${code}$`), { timeout: 20_000 });
    const join = page.getByRole("button", { name: "Beitreten" });
    await expect(join).toBeDisabled();
    const before = await (await request.get(`${NODE}/api/v1/rooms/${room.id}/members`, { headers: auth(alice) })).json();
    expect(before).toHaveLength(1);
    await page.getByTestId("accept-rules").check();
    await join.click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}`), { timeout: 20_000 });
  });
});
