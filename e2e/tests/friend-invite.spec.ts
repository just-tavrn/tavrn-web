// SPDX-License-Identifier: Apache-2.0
// "Invite to room" in the friend menu (docs/CLIENT.md "Inviting friends to a room", FEDERATION.md §3.4 direct invites):
// Alice invites her friend Bob into her room from the friends list; a room where she may not create invites is not
// offered. Bob's invite list shows the invitation without a reload and he joins. axe scans the open submenu.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { Permission } from "@tavrn/sdk";
import { NODE, createRoomViaApi, inviteCode, loginAs, registerViaApi, type Account } from "./helpers";
import { openContextMenu } from "./menu-helpers";
import { scaled } from "./timeouts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const auth = (a: Account) => ({ Authorization: `Bearer ${a.token}` });

async function befriend(request: APIRequestContext, a: Account, b: Account) {
  const resp = await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: auth(a), data: { user: b.username } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const list = await (await request.get(`${NODE}/api/v1/users/me/friends`, { headers: auth(b) })).json();
  for (const r of list.incoming) expect((await request.post(`${NODE}/api/v1/users/me/friends/requests/${r.id}/accept`, { headers: auth(b) })).ok()).toBeTruthy();
}

test.describe("Invite a friend to a room", () => {
  test("from the friends menu: only rooms with create_invites, Bob sees the invite live and joins", async ({ browser, page, request }) => {
    test.setTimeout(scaled(120_000));
    const alice = await registerViaApi(request, "fialice");
    const bob = await registerViaApi(request, "fibob");
    const carol = await registerViaApi(request, "ficarol");
    await befriend(request, alice, bob);
    const own = await createRoomViaApi(request, alice.token, "Gildenhalle");
    // Carol's room, where @everyone may not create invites; Alice is a plain member there.
    const other = await createRoomViaApi(request, carol.token, "Lesesaal");
    const everyone = (other.roles as Array<{ id: string; is_everyone: boolean; permissions: string }>).find((r) => r.is_everyone)!;
    const perms = (BigInt(everyone.permissions) & ~Permission.CREATE_INVITES).toString();
    expect((await request.patch(`${NODE}/api/v1/rooms/${other.id}/roles/${everyone.id}`, { headers: auth(carol), data: { permissions: perms } })).ok()).toBeTruthy();
    expect((await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, carol.token, other.id)}/join`, { headers: auth(alice), data: {} })).ok()).toBeTruthy();
    const seen = await (await request.get(`${NODE}/api/v1/rooms/${other.id}`, { headers: auth(alice) })).json();
    expect(BigInt(seen.my_permissions) & Permission.CREATE_INVITES, `perms ${seen.my_permissions} everyone ${perms} roles ${JSON.stringify(seen.roles)}`).toBe(0n);

    // Bob waits on his home view (his own context).
    const bobContext = await browser.newContext({ ...test.info().project.use });
    const bobPage = await bobContext.newPage();
    await loginAs(bobPage, bob);
    await bobPage.goto("/");
    await expect(bobPage.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect(bobPage.getByTestId("invite-list")).toHaveCount(0);

    await loginAs(page, alice);
    await page.goto("/friends");
    const friend = page.locator(`[data-testid="friend-item"][data-user="${bob.username}@localhost"]`);
    await expect(friend).toBeVisible();
    await openContextMenu(page, friend);
    const menu = page.getByTestId("friend-menu");
    await menu.getByRole("menuitem", { name: "Einladen in Raum" }).click();
    const submenu = page.getByTestId("context-submenu");
    await expect(submenu.getByRole("menuitem", { name: "Gildenhalle" })).toBeVisible();
    await expect(submenu.getByRole("menuitem", { name: "Lesesaal" })).toHaveCount(0);
    await page.waitForTimeout(300);
    const axe = await new AxeBuilder({ page }).include('[data-testid="friend-menu"]').include('[data-testid="context-submenu"]').withTags(TAGS).analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await submenu.getByRole("menuitem", { name: "Gildenhalle" }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: `Einladung in Gildenhalle an ${bob.username} gesendet` })).toBeVisible();

    // Bob: the invitation arrives without a reload; he accepts and lands in the room.
    const invite = bobPage.getByTestId("invite-list").getByTestId("invite").filter({ hasText: "Gildenhalle" });
    await expect(invite).toBeVisible({ timeout: 20_000 });
    await expect(invite).toContainText(`${alice.username}@localhost`);
    await invite.getByRole("button", { name: "Annehmen" }).click();
    await expect(bobPage).toHaveURL(new RegExp(`/rooms/${own.id}`), { timeout: 20_000 });
    const members = await (await request.get(`${NODE}/api/v1/rooms/${own.id}/members`, { headers: auth(alice) })).json();
    expect(members.map((m: { user: { address: string } }) => m.user.address)).toContain(`${bob.username}@localhost`);

    // Bob is in the room now: a second invitation is refused by the node and shown as an error.
    await page.reload();
    await openContextMenu(page, friend);
    await menu.getByRole("menuitem", { name: "Einladen in Raum" }).click();
    await submenu.getByRole("menuitem", { name: "Gildenhalle" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Diese Person ist bereits Mitglied des Raums" })).toBeVisible();
    await bobContext.close();
  });
});
