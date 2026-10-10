// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, railName } from "./helpers";
import { createRole, isTouch, joinRoom, longPress, memberRoles, openContextMenu, openMembers, postMessage } from "./menu-helpers";

// Context menus (design note 4.11): right-click on desktop, long press on phones, keyboard everywhere.
test.describe("Context menus", () => {
  test("Member: the roles submenu assigns a role, a moderator removes the member", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Menü-Raum");
    await joinRoom(request, owner, room.id, bob);
    const raider = await createRole(request, owner, room.id, { name: "Raider" });

    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openMembers(page);
    const row = page.getByTestId("member-row").filter({ hasText: bob.username });
    await expect(row).toBeVisible();

    // Roles submenu: a checkbox per role below the own one.
    await openContextMenu(page, row);
    const menu = page.getByTestId("member-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Profil" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Rollen" }).click();
    const sub = page.getByTestId("context-submenu");
    await sub.getByRole("menuitemcheckbox", { name: "Raider" }).click();
    await expect(sub.getByRole("menuitemcheckbox", { name: "Raider" })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => memberRoles(request, owner.token, room.id, bob.userId)).toContain(raider.id);
    // Escape closes the submenu first, then the menu.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("context-submenu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("member-menu")).toHaveCount(0);

    // Kick with confirmation.
    await openMembers(page);
    await openContextMenu(page, row);
    await page.getByTestId("member-menu").getByRole("menuitem", { name: "Aus dem Raum entfernen" }).click();
    const dialog = page.getByTestId("kick-dialog");
    await expect(dialog).toContainText(`${bob.username}@localhost`);
    await dialog.getByRole("button", { name: "Aus dem Raum entfernen" }).click();
    await openMembers(page);
    await expect(page.getByTestId("member-row").filter({ hasText: bob.username })).toHaveCount(0);
  });

  test("Message: pin via the context menu, keyboard via the ⋯ button", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Pin-Raum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await postMessage(request, owner.token, channelId, "Treffpunkt um acht");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    const message = page.getByTestId("message").filter({ hasText: "Treffpunkt um acht" });
    await expect(message).toBeVisible();

    await openContextMenu(page, message);
    await page.getByTestId("message-menu").getByRole("menuitem", { name: "Nachricht anpinnen" }).click();
    await expect(message.getByLabel("Angepinnt")).toBeVisible();

    if (!isTouch()) {
      // Keyboard: the ⋯ button opens the menu with the first item focused; arrows and Enter choose.
      await message.hover();
      await message.getByTestId("message-menu-button").click();
      const menu = page.getByTestId("message-menu");
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(menu.getByRole("menuitem", { name: "Nachricht löschen" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  });

  test("Channel: mute via the context menu and unmute again", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Stumm-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openNavIfMobile(page);
    const row = page.getByTestId("channel-row").filter({ hasText: "allgemein" });
    await openContextMenu(page, row);
    const menu = page.getByTestId("channel-menu");
    await menu.getByRole("menuitem", { name: "Stummschalten" }).click();
    await page.getByTestId("context-submenu").getByRole("menuitem", { name: "Für 1 Stunde" }).click();
    await expect(row.getByTestId("channel-muted")).toBeVisible();
    // A state change keeps the menu open: "Unmute" (with the end time) takes the place of "Mute", focused.
    const unmute = menu.getByRole("menuitem", { name: /^Stummschaltung aufheben/ });
    await expect(unmute).toBeFocused();
    await expect(page.getByTestId("context-submenu")).toHaveCount(0);
    await unmute.click();
    await expect(row.getByTestId("channel-muted")).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Stummschalten" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("Room: a notification mode keeps the menu open with the new mode checked; settings close it", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Glocken-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openNavIfMobile(page);
    await openContextMenu(page, page.getByTestId("room-rail").getByRole("link", { name: railName("Glocken-Raum") }));
    const menu = page.getByTestId("room-menu");
    await menu.getByRole("menuitem", { name: "Benachrichtigungen" }).click();
    const sub = page.getByTestId("context-submenu");
    await expect(sub.getByRole("menuitemcheckbox", { name: /^Standard/ })).toHaveAttribute("aria-checked", "true");
    await sub.getByRole("menuitemcheckbox", { name: "Nur Erwähnungen" }).click();
    // Menu and submenu stay open and show the new state; a second change needs no reopening.
    await expect(sub.getByRole("menuitemcheckbox", { name: "Nur Erwähnungen" })).toHaveAttribute("aria-checked", "true");
    await expect(sub.getByRole("menuitemcheckbox", { name: /^Standard/ })).toHaveAttribute("aria-checked", "false");
    await sub.getByRole("menuitemcheckbox", { name: "@everyone unterdrücken" }).click();
    await expect(sub.getByRole("menuitemcheckbox", { name: "@everyone unterdrücken" })).toHaveAttribute("aria-checked", "true");
    await expect(menu).toBeVisible();
    // The node has the new setting.
    await expect
      .poll(async () => {
        const resp = await request.get(`${NODE}/api/v1/users/me/notification-settings`, { headers: { Authorization: `Bearer ${owner.token}` } });
        const body = (await resp.json()) as { rooms?: Record<string, { mode?: string; suppress_everyone?: boolean }> };
        return body.rooms?.[room.id];
      })
      .toMatchObject({ mode: "mentions", suppress_everyone: true });
    // Navigation still closes the menu.
    await menu.getByRole("menuitem", { name: "Raumeinstellungen" }).click();
    await expect(menu).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/settings`));
  });

  test("Voice channel: the same dropdown as text channels plus bulk move (right click, long press, ⋯)", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Sprach-Raum");
    const raid = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { kind: "voice", name: "Raid" } });
    expect(raid.ok(), await raid.text()).toBeTruthy();
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openNavIfMobile(page);
    const voice = page.getByTestId("voice-channel").filter({ has: page.getByRole("link", { name: "Sprachkanal Sprache" }) });
    const header = voice.getByTestId("voice-channel-header");
    await expect(header).toBeVisible();

    // Right-click (touch: long press) opens the dropdown, not a modal, and does not join the channel.
    await openContextMenu(page, header);
    const menu = page.getByTestId("channel-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    for (const name of ["Als gelesen markieren", "Benachrichtigungen", "Stummschalten", "Channel bearbeiten", "Link kopieren", "ID kopieren"]) {
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    }
    // Nobody in voice: the mass moves are there but disabled (with the count).
    await expect(menu.getByRole("menuitem", { name: "Alle hierher verschieben (0)" })).toHaveAttribute("aria-disabled", "true");
    await expect(menu.getByRole("menuitem", { name: /Alle von hier \(0\) verschieben nach/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("voice-stage")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // The ⋯ button opens the same menu; "Copy ID" copies the channel id.
    await voice.getByTestId("voice-channel-menu-button").click();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "ID kopieren" }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("voice-stage")).toHaveCount(0);

    // "Edit channel" opens the channel settings of this channel.
    await voice.getByTestId("voice-channel-menu-button").click();
    await menu.getByRole("menuitem", { name: "Channel bearbeiten" }).click();
    await expect(page).toHaveURL(/settings\/channels\?channel=/);
  });

  test("A long press opens the menu on a phone without navigating", async ({ page, request }) => {
    test.skip(!isTouch(), "touch only");
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Touch-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/overview`);
    await openNavIfMobile(page);
    const row = page.getByTestId("channel-row").filter({ hasText: "allgemein" });
    await longPress(page, row);
    await expect(page.getByTestId("channel-menu")).toBeVisible();
    // The long press did not follow the link.
    await expect(page).toHaveURL(/settings\/overview/);
    await page.getByTestId("channel-menu").getByRole("menuitem", { name: "ID kopieren" }).click();
    await expect(page.getByTestId("channel-menu")).toHaveCount(0);
  });
});
