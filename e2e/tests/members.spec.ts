// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createRoomViaApi, loginAs, registerViaApi } from "./helpers";
import { createRole, isTouch, joinRoom, openMembers, setRoles } from "./menu-helpers";

test.describe("Member list and roles (design note 4.11)", () => {
  test("Roles displayed separately form their own sections, offline members are at the bottom", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, owner.token, "Gruppen-Raum");
    await joinRoom(request, owner, room.id, bob);
    const lead = await createRole(request, owner, room.id, { name: "Gildenleitung", hoist: true, position: 3 });
    await createRole(request, owner, room.id, { name: "Unsichtbar", hoist: false, position: 2 });
    await setRoles(request, owner, room.id, owner.userId, [lead.id]);

    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openMembers(page);
    const sections = page.getByTestId("member-section");
    // The own account is online (its presence), bob has no session: offline.
    await expect(sections.first()).toHaveAttribute("data-section", "Gildenleitung");
    await expect(page.locator('[data-section="Gildenleitung"]')).toContainText(owner.username);
    await expect(page.locator('[data-section="offline"]')).toContainText(bob.username);
    await expect(page.locator('[data-section="Unsichtbar"]')).toHaveCount(0);
  });

  test("Reorder roles by dragging or arrow; @everyone cannot get administrative permissions", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Sortier-Raum");
    await createRole(request, owner, room.id, { name: "Alpha", position: 2 });
    await createRole(request, owner, room.id, { name: "Beta", position: 1 });
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/roles`);
    const rows = page.getByTestId("role-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-role", "Alpha");

    if (isTouch()) {
      await page.getByRole("button", { name: "Beta nach oben" }).click();
    } else {
      await rows.nth(1).dragTo(rows.nth(0));
    }
    await expect(page.getByRole("status").filter({ hasText: "Rollenreihenfolge gespeichert" })).toBeVisible();
    await expect(rows.nth(0)).toHaveAttribute("data-role", "Beta");
    await expect(rows.nth(1)).toHaveAttribute("data-role", "Alpha");

    // @everyone: management bits are locked with an explanation, everyday bits stay editable.
    await page.getByTestId("role-list").getByRole("button", { name: "@everyone" }).click();
    const editor = page.getByTestId("role-editor");
    await expect(editor.getByTestId("everyone-restricted-note")).toBeVisible();
    await expect(editor.getByLabel("Administrator")).toBeDisabled();
    await expect(editor.getByLabel("Mitglieder bannen")).toBeDisabled();
    await expect(editor.getByLabel("Nachrichten senden")).toBeEnabled();
  });
});
