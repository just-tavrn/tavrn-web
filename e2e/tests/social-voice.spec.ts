// SPDX-License-Identifier: Apache-2.0
// Voice activity outside the channel list (docs/CLIENT.md "Voice activity in the room rail and the friends list",
// tavrn-protocol VOICE.md §5 GET /users/me/voice): Bob joins voice in a room he shares with Alice, whose rail shows
// the speaker badge and whose room card lists Bob (hover with a mouse, the head of the long-press menu on touch);
// her friends list shows where Bob is and "Join" takes her into the channel. In a channel Alice cannot view, nothing
// is shown. axe scans the card, the menu head and the friends list.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, openNavIfMobile, tokenOf } from "./helpers";
import { isTouch, longPress } from "./menu-helpers";
import { FAKE_MEDIA, befriend, closeOpened, voiceUser } from "./voice-helpers";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** axe on one element: serious and critical WCAG violations fail. */
async function scan(page: Page, selector: string, screen: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id} @ ${screen}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

async function api(request: APIRequestContext, page: Page, method: "post" | "put", path: string, data: unknown) {
  const resp = await request[method](`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json().catch(() => null);
}

/** Joins a voice channel by clicking it in the channel list of the open room. */
async function joinFromSidebar(page: Page, roomId: string, channel: string) {
  await page.goto(`/rooms/${roomId}`);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: `Sprachkanal ${channel}` }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
}

test.describe("Voice activity in the rail and the friends list", () => {
  test("rail badge and room card, friends list with Join, nothing for a hidden channel", async ({ browser, request }) => {
    test.setTimeout(240_000);
    const bob = await voiceUser(browser, "svbob");
    const alice = await voiceUser(browser, "svalice");
    await befriend(alice, bob);
    // Bob's room with Alice as a member, and a voice channel only Bob (the owner) can view.
    const room = await createRoomViaApi(request, await tokenOf(bob.page), "Stammtisch");
    const roomId = room.id as string;
    const resp = await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, await tokenOf(bob.page), roomId)}/join`, { headers: { Authorization: `Bearer ${await tokenOf(alice.page)}` }, data: {} });
    expect(resp.ok()).toBeTruthy();
    const hidden = await api(request, bob.page, "post", `/rooms/${roomId}/channels`, { kind: "voice", name: "Geheim" });
    const detail = await (await request.get(`${NODE}/api/v1/rooms/${roomId}`, { headers: { Authorization: `Bearer ${await tokenOf(bob.page)}` } })).json();
    const everyone = detail.roles.find((r: { is_everyone: boolean }) => r.is_everyone).id as string;
    await api(request, bob.page, "put", `/rooms/${roomId}/overrides`, { target_type: "channel", target_id: hidden.id, subject_type: "role", subject_id: everyone, allow: "0", deny: "1" });

    // Alice is somewhere else (her friends list), the room is not open: the snapshot and events feed the rail.
    await alice.page.goto("/friends");
    await joinFromSidebar(bob.page, roomId, "Sprache");

    await openNavIfMobile(alice.page);
    const rail = alice.page.getByTestId("room-rail");
    const railRoom = rail.locator(`[data-testid="rail-room"][data-room="${roomId}"]`);
    await expect(railRoom.getByTestId("rail-voice-badge")).toHaveAttribute("data-kind", "voice", { timeout: 20_000 });
    await expect(railRoom).toHaveAttribute("aria-label", /Stammtisch, 1 im Sprachkanal/);

    // The room card: hover with a mouse, the long-press menu's head on touch.
    if (isTouch()) {
      await longPress(alice.page, railRoom);
      const head = alice.page.getByTestId("room-menu").getByTestId("menu-header");
      await expect(head.getByTestId("room-card-name")).toHaveText("Stammtisch");
      await expect(head.locator(`[data-testid="room-card-participant"][data-user="${bob.address}"]`)).toBeVisible();
      await scan(alice.page, '[data-testid="room-menu"]', "room menu with the card");
      await alice.page.keyboard.press("Escape");
      await expect(alice.page.getByTestId("room-menu")).toHaveCount(0);
    } else {
      await railRoom.hover();
      const card = alice.page.getByTestId("room-hover-card");
      await expect(card.getByTestId("room-card-name")).toHaveText("Stammtisch");
      await expect(card.getByTestId("room-card-channel")).toContainText("Sprache");
      await expect(card.locator(`[data-testid="room-card-participant"][data-user="${bob.address}"]`)).toBeVisible();
      await scan(alice.page, '[data-testid="room-hover-card"]', "room hover card");
      await alice.page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    }

    // The friends list: where Bob is, and Join takes Alice there.
    await alice.page.goto("/friends");
    const friend = alice.page.locator(`[data-testid="friend-item"][data-user="${bob.address}"]`);
    await expect(friend.getByTestId("friend-voice")).toHaveText("Im Sprachkanal: Stammtisch / Sprache", { timeout: 20_000 });
    await scan(alice.page, '[data-testid="friends-list"]', "friends list with a friend in voice");
    await friend.getByTestId("friend-menu-button").click();
    await alice.page.getByTestId("friend-menu").getByRole("menuitem", { name: "Sprache betreten" }).click();
    await expect(alice.page).toHaveURL(new RegExp(`/rooms/${roomId}/channels/`));
    await expect(alice.page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
    await expect(alice.page.locator(`[data-testid="voice-tile"][data-user="${bob.address}"]`)).toBeVisible({ timeout: 30_000 });
    await alice.page.getByTestId("voice-leave").click();

    // Bob goes invisible: Alice's friends list shows him offline, without the voice line (the channel still lists him).
    await alice.page.goto("/friends");
    await expect(friend.getByTestId("friend-voice")).toHaveText("Im Sprachkanal: Stammtisch / Sprache", { timeout: 20_000 });
    await openNavIfMobile(bob.page);
    await bob.page.getByTestId("presence-menu-button").click();
    await bob.page.getByTestId("presence-invisible").click();
    await expect(friend.getByTestId("friend-voice")).toHaveCount(0, { timeout: 20_000 });
    await friend.getByTestId("friend-menu-button").click();
    await expect(alice.page.getByTestId("friend-menu").getByRole("menuitem", { name: /betreten/ })).toHaveCount(0);
    await alice.page.keyboard.press("Escape");
    await bob.page.getByTestId("presence-menu-button").click();
    await bob.page.getByTestId("presence-online").click();
    await expect(friend.getByTestId("friend-voice")).toHaveText("Im Sprachkanal: Stammtisch / Sprache", { timeout: 20_000 });

    // Bob moves to the channel Alice cannot view: no badge, no card entry, no line in the friends list.
    await joinFromSidebar(bob.page, roomId, "Geheim");
    await alice.page.goto("/friends");
    await expect(friend).toBeVisible();
    await openNavIfMobile(alice.page);
    await expect(railRoom.getByTestId("rail-voice-badge")).toHaveCount(0, { timeout: 20_000 });
    await expect(railRoom).toHaveAttribute("aria-label", "Stammtisch");
    await expect(friend.getByTestId("friend-voice")).toHaveCount(0);
    // A fresh start (the snapshot of GET /users/me/voice) shows nothing either.
    await alice.page.reload();
    await expect(alice.page.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready");
    await expect(friend).toBeVisible();
    await expect(friend.getByTestId("friend-voice")).toHaveCount(0);
    await friend.getByTestId("friend-menu-button").click();
    await expect(alice.page.getByTestId("friend-menu").getByRole("menuitem", { name: /betreten/ })).toHaveCount(0);
  });
});
