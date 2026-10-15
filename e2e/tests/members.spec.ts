// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";
import { createRole, isTouch, joinRoom, openMembers, setRoles } from "./menu-helpers";

/** The members drawer's layout width (CSS px), unaffected by its slide-in transform. */
const drawerWidth = (page: Page) => page.getByTestId("members-drawer").evaluate((el) => (el as HTMLElement).offsetWidth);

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
      // The list's own drag events on the rows, not a pointer drag by coordinates: the page still lays out here (the
      // banner of the account without encryption appears late and pushes the list down), and a mouse press that lands
      // above the moved row starts no drag at all (tavrn-web#170).
      const data = await page.evaluateHandle(() => new DataTransfer());
      await rows.nth(1).dispatchEvent("dragstart", { dataTransfer: data });
      await rows.nth(0).dispatchEvent("dragenter", { dataTransfer: data });
      await rows.nth(0).dispatchEvent("dragover", { dataTransfer: data });
      await rows.nth(0).dispatchEvent("drop", { dataTransfer: data });
      await rows.nth(1).dispatchEvent("dragend", { dataTransfer: data });
    }
    // The saved order, in the list and on the node (the confirmation toast is gone after a few seconds).
    await expect(rows.nth(0)).toHaveAttribute("data-role", "Beta");
    await expect(rows.nth(1)).toHaveAttribute("data-role", "Alpha");
    await expect
      .poll(async () => {
        const detail = await (await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
        const position = (name: string) => (detail.roles as { name: string; position: number }[]).find((r) => r.name === name)!.position;
        return position("Beta") > position("Alpha");
      })
      .toBe(true);

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
      const aside = el.closest("aside")!;
      const drawer = aside.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // The drawer's width from the layout (its CSS width), not the rendered rectangle: the drawer slides in with a
      // transform, and mid-transition the rectangle is a subpixel float (239.99996…, tavrn-web#121 run on 2026-10-15).
      return { truncated: name.scrollWidth > name.clientWidth, overflow: getComputedStyle(name).textOverflow, rowRight: r.right, drawerRight: drawer.right, drawerWidth: (aside as HTMLElement).offsetWidth };
    });
    expect(box.truncated).toBe(true);
    expect(box.overflow).toBe("ellipsis");
    expect(box.rowRight).toBeLessThanOrEqual(box.drawerRight + 0.5);
    if (info.project.name === "chromium") {
      await page.screenshot({ path: "test-results/uipolish/member-list.png" });
      // Landscape phone and tablet sizes below the desktop grid: the drawer is 280 px, portrait keeps 240 px.
      await page.setViewportSize({ width: 915, height: 412 });
      await openMembers(page);
      await expect.poll(() => drawerWidth(page)).toBe(280);
      await page.setViewportSize({ width: 412, height: 915 });
      await openMembers(page);
      await expect.poll(() => drawerWidth(page)).toBe(240);
    } else {
      expect(box.drawerWidth).toBe(240);
    }
  });
});
