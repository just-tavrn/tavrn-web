// SPDX-License-Identifier: Apache-2.0
import { dirname, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, railName } from "./helpers";

// Fixtures made with ffmpeg (testsrc): a still PNG and a one-second animated GIF.
const FIXTURES = resolve(dirname(new URL(import.meta.url).pathname), "../fixtures");
export const STILL = resolve(FIXTURES, "still.png");
export const ANIMATED = resolve(FIXTURES, "animated.gif");

/** Hover works with a mouse only; touch devices never animate (design note 4.9). */
function hasMouse(page: Page): boolean {
  return !test.info().project.use.hasTouch && (page.viewportSize()?.width ?? 0) >= 768;
}

async function expectStillThenAnimatedOnHover(page: Page, avatar: Locator) {
  await expect(avatar).toHaveAttribute("data-has-animation", "true");
  await expect(avatar).toHaveAttribute("data-animated", "false");
  if (!hasMouse(page)) return;
  await avatar.hover();
  await expect(avatar).toHaveAttribute("data-animated", "true");
  await expect(avatar.getByTestId("avatar-image")).toHaveAttribute("src", /\/animated$/);
  await page.mouse.move(0, 0);
  await expect(avatar).toHaveAttribute("data-animated", "false");
}

async function openMembers(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) !== "true") await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
}

test.describe("Profile", () => {
  test("Avatar (image and animation), banner, description and accounts, visible in the profile popover and on the profile page", async ({ page, request }) => {
    test.setTimeout(120_000);
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Gilde");
    const code = await inviteCode(request, alice.token, room.id);
    await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${bob.token}` }, data: {} });

    await loginAs(page, alice);
    await page.goto("/settings/profile");
    // A still image: converted by the node, no animation.
    await page.getByTestId("avatar-input").setInputFiles(STILL);
    const preview = page.getByTestId("avatar-preview");
    await expect(preview.getByTestId("avatar-image")).toBeVisible({ timeout: 20_000 });
    await expect(preview).toHaveAttribute("data-has-animation", "false");
    // An animated GIF: the still first frame, the animation only on hover.
    await page.getByTestId("avatar-input").setInputFiles(ANIMATED);
    await expect(preview).toHaveAttribute("data-has-animation", "true", { timeout: 20_000 });
    await expectStillThenAnimatedOnHover(page, preview);
    await page.getByTestId("header-input").setInputFiles(STILL);
    await expect(page.getByTestId("header-preview").locator("img")).toBeVisible({ timeout: 20_000 });

    // Bio (Markdown) and linked accounts; the node derives the links.
    await page.getByLabel("Anzeigename").fill("Alice Raidlead");
    await page.getByLabel("Beschreibung").fill("**Raids** jeden Freitag");
    await expect(page.getByTestId("bio-preview").locator("strong")).toHaveText("Raids");
    await page.getByTestId("link-add").click();
    await page.getByLabel("Name, Tag oder Link").first().fill("https://steamcommunity.com/id/alice_raids");
    await page.getByTestId("link-add").click();
    await page.getByLabel("Dienst").nth(1).selectOption("battlenet");
    await page.getByLabel("Name, Tag oder Link").nth(1).fill("Alice#1234");
    await page.getByTestId("about-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Profil gespeichert" })).toBeVisible();

    // The footer card shows the avatar too (presence menu).
    await openNavIfMobile(page);
    await expect(page.getByTestId("presence-menu-button").getByTestId("avatar-image")).toBeVisible();

    // Bob sees all of it in the member list's profile card and on the profile page.
    const bobPage = await page.context().browser()!.newContext({ ...test.info().project.use }).then((c) => c.newPage());
    await loginAs(bobPage, bob);
    // Alice's messages carry her avatar: the still, animated on hover; a click opens her profile card.
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const posted = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: { Authorization: `Bearer ${alice.token}` }, data: { content: { type: "text", body: "Raid heute um acht" } } });
    expect(posted.ok(), await posted.text()).toBeTruthy();
    await bobPage.goto(`/rooms/${room.id}/channels/${channel.id}`);
    const messageAvatar = bobPage.getByTestId("message").filter({ hasText: "Raid heute um acht" }).getByTestId("message-avatar");
    await expect(messageAvatar.getByTestId("avatar-image")).toHaveAttribute("src", /\/api\/v1\/media\/[0-9A-Z]{26}$/);
    await expectStillThenAnimatedOnHover(bobPage, messageAvatar.locator("[data-has-animation]"));
    await messageAvatar.click();
    await expect(bobPage.getByTestId("profile-popover").getByTestId("profile-name")).toHaveText("Alice Raidlead");
    await bobPage.keyboard.press("Escape");
    await expect(bobPage.getByTestId("profile-popover")).toHaveCount(0);
    await openMembers(bobPage);
    const entry = bobPage.getByTestId("member-list").getByTestId("profile-trigger").filter({ hasText: "Alice Raidlead" });
    await expect(entry.getByTestId("avatar-image")).toBeVisible();
    await entry.click();
    const card = bobPage.getByTestId("profile-popover");
    await expect(card.getByTestId("profile-name")).toHaveText("Alice Raidlead");
    await expect(card.getByTestId("profile-address")).toHaveText(`${alice.username}@localhost`);
    await expect(card.getByTestId("profile-bio").locator("strong")).toHaveText("Raids");
    const links = card.getByTestId("profile-links");
    await expect(links.getByRole("link", { name: "alice_raids" })).toHaveAttribute("href", "https://steamcommunity.com/id/alice_raids");
    await expect(links).toContainText("Alice#1234");
    await expect(links).toContainText("nicht überprüft");
    await expect(card.getByTestId("profile-header").locator("img")).toBeVisible();
    await expectStillThenAnimatedOnHover(bobPage, card.getByTestId("profile-avatar"));
    await card.getByTestId("profile-full").click();
    await expect(bobPage).toHaveURL(new RegExp(`/u/${alice.username}`));
    await expect(bobPage.getByTestId("profile-page").getByTestId("profile-name")).toHaveText("Alice Raidlead");
    await expect(bobPage.getByTestId("profile-page").getByTestId("profile-bio")).toContainText("jeden Freitag");
    await bobPage.context().close();
  });

  test("Upload a room icon: in the room bar and the room header, animated only on hover", async ({ page, request }) => {
    test.setTimeout(90_000);
    const owner = await registerViaApi(request, "owner");
    const room = await createRoomViaApi(request, owner.token, "Icons");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/overview`);
    const section = page.getByTestId("room-icon-section");
    await section.getByTestId("room-icon-input").setInputFiles(ANIMATED);
    await expect(section.getByTestId("room-icon-preview").getByTestId("avatar-image")).toBeVisible({ timeout: 20_000 });
    await page.goto(`/rooms/${room.id}`);
    await openNavIfMobile(page);
    const rail = page.getByRole("link", { name: railName("Icons") }).getByTestId("room-icon");
    await expect(rail.getByTestId("avatar-image")).toHaveAttribute("src", /\/api\/v1\/media\/[0-9A-Z]{26}$/);
    await expectStillThenAnimatedOnHover(page, rail);
    await expect(page.getByTestId("room-header-icon").getByTestId("avatar-image")).toBeVisible();

    // Removing it falls back to the initials.
    await page.goto(`/rooms/${room.id}/settings/overview`);
    await page.getByTestId("room-icon-remove").click();
    await expect(page.getByTestId("room-icon-preview").getByTestId("avatar-image")).toHaveCount(0);
  });
});
