// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { joinRoom, postMessage } from "./menu-helpers";

test.describe("Notifications (design note 4.11)", () => {
  test("A mention from another context shows a toast and an entry behind the bell", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Ping-Raum");
    await joinRoom(request, alice, room.id, bob);
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;

    // Alice is on the home view, not in the channel.
    await loginAs(page, alice);
    await page.goto("/");
    await expect(page.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready");

    // An unmentioned message does not notify (default: mentions only).
    await postMessage(request, bob.token, channelId, "nur so");
    await postMessage(request, bob.token, channelId, `@${alice.username} kommst du?`, { mentions: [`${alice.username}@localhost`] });
    const toast = page.getByTestId("notify-toast-mention");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("kommst du?");
    await expect(toast).toContainText("Ping-Raum");
    await expect(page.getByTestId("notify-toast")).toHaveCount(0);

    // The bell counts the unseen entry; its panel jumps to the conversation.
    await openNavIfMobile(page);
    const bell = page.getByTestId("notification-bell").locator("visible=true").first();
    await expect(bell.getByTestId("notification-count")).toHaveText("1");
    await bell.click();
    const entry = page.getByTestId("notification-panel").getByTestId("notification-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("data-kind", "mention");
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/channels/${channelId}`));
    await expect(page.getByTestId("message").filter({ hasText: "kommst du?" })).toBeVisible();
  });

  test("Settings: mode, sound and browser notifications; stored locally without the node route", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    await loginAs(page, alice);
    await page.goto("/settings/notifications");
    const settings = page.getByTestId("notification-settings");
    await expect(settings).toBeVisible();
    await settings.getByTestId("notify-global-mode").selectOption("all");
    await settings.getByTestId("notify-sound").uncheck();
    // Saved on the node after a short pause (or only in this browser on nodes without the route).
    await page.waitForTimeout(1000);
    await page.reload();
    await expect(page.getByTestId("notify-global-mode")).toHaveValue("all");
    await expect(page.getByTestId("notify-sound")).not.toBeChecked();
  });
});
