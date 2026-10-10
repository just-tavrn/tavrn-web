// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";

test.describe("Responsive layout", () => {
  test("Navigation is a drawer or a fixed column depending on the width", async ({ page, request }) => {
    const account = await registerViaApi(request, "resp");
    const room = await createRoomViaApi(request, account.token, "Layout-Raum");
    await loginAs(page, account);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");

    const width = page.viewportSize()?.width ?? 0;
    const navButton = page.getByRole("button", { name: "Navigation öffnen" });
    const channels = page.getByRole("complementary", { name: "Channels" });

    if (width < 768) {
      await expect(channels).not.toBeInViewport();
      await navButton.tap();
      await expect(channels).toBeInViewport();
      // Tapping a channel closes the drawer again.
      await page.getByRole("link", { name: "Sprache" }).tap();
      await expect(channels).not.toBeInViewport();
      await expect(page.getByTestId("channel-name")).toHaveText("Sprache");
    } else {
      await expect(navButton).toBeHidden();
      await expect(channels).toBeInViewport();
    }

    const members = page.getByRole("complementary", { name: "Mitglieder" });
    if (width < 1280) {
      await expect(members).not.toBeInViewport();
      await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
      await expect(members).toBeInViewport();
      await expect(page.getByTestId("member-list")).toContainText(account.username);
    } else {
      await expect(members).toBeInViewport();
      await expect(page.getByRole("button", { name: "Mitglieder öffnen" })).toBeHidden();
    }
  });

  test("message text uses the whole row on a phone", async ({ page, request }) => {
    // The hover actions of a message (react, pin, edit, delete, menu) are invisible until hover or focus; they used to
    // sit in the row's flex layout and took a third of a phone's width away from the text.
    await page.setViewportSize({ width: 390, height: 844 });
    const account = await registerViaApi(request, "wrap");
    const room = await createRoomViaApi(request, account.token, "Umbruch-Raum");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const body = "Ein langer Absatz, der auf einem Telefon über mehrere Zeilen umbricht. ".repeat(6).trim();
    const posted = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: { Authorization: `Bearer ${account.token}` }, data: { content: { type: "text", body } } });
    expect(posted.ok(), await posted.text()).toBeTruthy();
    await loginAs(page, account);
    await page.goto(`/rooms/${room.id}`);
    const message = page.getByTestId("message").filter({ hasText: "Ein langer Absatz" });
    await expect(message).toBeVisible();
    const box = await message.evaluate((row) => {
      const text = row.querySelector(".markdown")!.getBoundingClientRect();
      const avatar = row.querySelector("[data-testid=message-avatar]")!.getBoundingClientRect();
      return { row: row.getBoundingClientRect(), text, avatar };
    });
    // The text column spans from after the avatar to the row's right padding (8 px), with a little slack.
    expect(box.text.left).toBeGreaterThan(box.avatar.right);
    expect(box.row.right - box.text.right).toBeLessThanOrEqual(12);
    expect(box.text.width).toBeGreaterThan((box.row.width - box.avatar.width) * 0.85);
  });

  test("no horizontal scrollbar", async ({ page, request }) => {
    const account = await registerViaApi(request, "scroll");
    await loginAs(page, account);
    await page.goto("/");
    await expect(page.getByTestId("me-name")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test("pages without a member list use the full width on a desktop", async ({ page, request }, info) => {
    // Friends, discover and the user settings have no member list: the desktop grid used to keep its 240 px column
    // empty on the right. The phone and tablet layouts are covered above.
    test.skip(info.project.name !== "chromium", "a desktop width");
    await page.setViewportSize({ width: 1440, height: 900 });
    const account = await registerViaApi(request, "wide");
    await loginAs(page, account);
    for (const path of ["/friends", "/discover", "/settings/profile"]) {
      await page.goto(path);
      const main = page.locator("#main-content");
      await expect(main).toBeVisible();
      await expect(page.getByTestId("members-drawer")).toBeHidden();
      await expect(page.getByRole("button", { name: "Mitglieder öffnen" })).toHaveCount(0);
      const box = (await main.boundingBox())!;
      // The main column reaches the right edge of the window (72 px rail + 240 px channels on the left).
      expect(Math.round(box.x + box.width), path).toBe(1440);
      expect(Math.round(box.x), path).toBe(312);
    }
    // A room keeps its member column.
    const room = await createRoomViaApi(request, account.token, "Breit-Raum");
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByRole("complementary", { name: "Mitglieder" })).toBeInViewport();
  });
});
