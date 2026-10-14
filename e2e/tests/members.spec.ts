// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";
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

  test("long names truncate with an ellipsis inside the list; the drawer is wider in landscape (tavrn-web#121)", async ({ page, request }, info) => {
    const owner = await registerViaApi(request, "own");
    const longName = "Maximiliane Friederike von Hohenstein-Rabenberg";
    expect((await request.patch(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { display_name: longName } })).ok()).toBeTruthy();
    const room = await createRoomViaApi(request, owner.token, "Namen-Raum");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openMembers(page);
    const list = page.getByTestId("member-list");
    const row = list.getByTestId("member-row").filter({ hasText: "Maximiliane" });
    await expect(row).toBeVisible();
    const box = await row.evaluate((el) => {
      const name = Array.from(el.querySelectorAll("span.truncate")).find((s) => s.textContent?.startsWith("Maximiliane"))!;
      const drawer = el.closest("aside")!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { truncated: name.scrollWidth > name.clientWidth, overflow: getComputedStyle(name).textOverflow, rowRight: r.right, drawerRight: drawer.right, drawerWidth: drawer.width };
    });
    expect(box.truncated).toBe(true);
    expect(box.overflow).toBe("ellipsis");
    expect(box.rowRight).toBeLessThanOrEqual(box.drawerRight + 0.5);
    if (info.project.name === "chromium") {
      await page.screenshot({ path: "test-results/uipolish/member-list.png" });
      // Landscape phone and tablet sizes below the desktop grid: the drawer is 280 px, portrait keeps 240 px.
      await page.setViewportSize({ width: 915, height: 412 });
      await openMembers(page);
      await expect.poll(async () => (await page.getByTestId("members-drawer").boundingBox())!.width).toBe(280);
      await page.setViewportSize({ width: 412, height: 915 });
      await openMembers(page);
      await expect.poll(async () => (await page.getByTestId("members-drawer").boundingBox())!.width).toBe(240);
    } else {
      expect(box.drawerWidth).toBe(240);
    }
  });
});
