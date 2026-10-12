// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { expectInsideViewport, isTouch, joinRoom, openContextMenu, openMembers, postMessage } from "./menu-helpers";
import { scaled } from "./timeouts";

// The profile card used to be cut off when opened from the member list on desktop (design note 4.11): it is
// now placed with collision handling. Desktop and tablet sizes run in the desktop project, phones in the
// mobile project (bottom sheet).
test.describe("Profile card stays inside the window", () => {
  test("from the member list, from the message author and from the DM list", async ({ page, request }) => {
    test.setTimeout(scaled(90_000));
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Profil-Raum");
    await joinRoom(request, alice, room.id, bob);
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await postMessage(request, bob.token, channelId, "Hallo zusammen");
    const dm = await request.post(`${NODE}/api/v1/conversations`, { headers: { Authorization: `Bearer ${alice.token}` }, data: { kind: "dm", members: [bob.username] } });
    expect(dm.ok()).toBeTruthy();

    await loginAs(page, alice);
    const sizes = isTouch() ? [page.viewportSize()!] : [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1024, height: 700 }];
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.goto(`/rooms/${room.id}/channels/${channelId}`);
      const message = page.getByTestId("message").filter({ hasText: "Hallo zusammen" });
      await expect(message).toBeVisible();

      // Member list (the last member sits at the right edge of the screen on desktop).
      await openMembers(page);
      await page.getByTestId("member-row").filter({ hasText: bob.username }).getByTestId("profile-trigger").click();
      const card = page.getByTestId("profile-popover");
      await expect(card.getByTestId("profile-address")).toHaveText(`${bob.username}@localhost`);
      await expectInsideViewport(page, card);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);

      // Message author.
      if ((page.viewportSize()?.width ?? 0) < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) === "true") await page.getByRole("button", { name: "Drawer schließen" }).click({ position: { x: 10, y: 200 } });
      await message.getByTestId("message-avatar").click();
      await expect(card.getByTestId("profile-address")).toHaveText(`${bob.username}@localhost`);
      await expectInsideViewport(page, card);
      await page.keyboard.press("Escape");

      // DM list: the context menu's "Profile".
      await page.goto("/");
      await openNavIfMobile(page);
      const row = page.getByTestId("dm-row").first();
      await openContextMenu(page, row);
      await page.getByTestId("dm-menu").getByRole("menuitem", { name: "Profil" }).click();
      await expect(card.getByTestId("profile-address")).toHaveText(`${bob.username}@localhost`);
      await expectInsideViewport(page, card);
      await page.keyboard.press("Escape");
    }
  });
});
