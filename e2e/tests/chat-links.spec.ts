// SPDX-License-Identifier: Apache-2.0
// Pills and chips in messages (docs/CLIENT.md "Messages and the composer", PROTOCOL.md §7h): a channel link becomes a
// chip with the channel's name and opens it inside the client; a channel the reader may not see is a neutral private
// chip; a user pill opens the profile card with "Full profile", a role pill the role's members; a card-like message
// without a mentions list shows its members as pills, never as e-mail links. axe on the message list with the role list.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";
import { createRole, joinRoom, postMessage, setRoles } from "./menu-helpers";
import { scaled } from "./timeouts";

async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("channel chips, private chips, user and role pills, members in a card", async ({ page, request }) => {
  test.setTimeout(scaled(120_000));
  const owner = await registerViaApi(request, "own");
  const bob = await registerViaApi(request, "bob");
  const room = await createRoomViaApi(request, owner.token, "Link-Raum");
  await joinRoom(request, owner, room.id, bob);
  const auth = { Authorization: `Bearer ${owner.token}` };
  const call = async (method: "post" | "put" | "get", path: string, data?: object) => {
    const resp = await request[method](`${NODE}/api/v1/rooms/${room.id}${path}`, { headers: auth, ...(data ? { data } : {}) });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    return resp.json().catch(() => null);
  };
  const general = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "text")!;
  const raids = await call("post", "/channels", { kind: "text", name: "raids", encrypted: false });
  const secret = await call("post", "/channels", { kind: "text", name: "geheim-xyz", encrypted: false });
  const everyone = ((await call("get", "")).roles as { id: string; is_everyone: boolean }[]).find((r) => r.is_everyone)!.id;
  await call("put", "/overrides", { target_type: "channel", target_id: secret.id, subject_type: "role", subject_id: everyone, allow: "0", deny: "1" });
  const leads = await createRole(request, owner, room.id, { name: "Raid Leads", position: 1 });
  await setRoles(request, owner, room.id, bob.userId, [leads.id]);

  await loginAs(page, bob);
  await page.goto(`/rooms/${room.id}/channels/${general.id}`);
  const web = await page.evaluate(() => location.origin);
  await postMessage(request, owner.token, general.id, `Treffpunkt: ${web}/rooms/${room.id}/channels/${raids.id} und ${web}/rooms/${room.id}/channels/${secret.id}`);
  await postMessage(request, owner.token, general.id, `Hallo @${bob.username} und @Raid Leads`, { mentions: [`${bob.username}@localhost`] });
  // Like the raid helper's card: members named in the text, no mentions list.
  await postMessage(request, owner.token, general.id, `Tanks: @${bob.username}@localhost (Paladin)`);

  const links = page.getByTestId("message").filter({ hasText: "Treffpunkt" });
  const chips = links.getByTestId("tavrn-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText("raids");
  await expect(chips.nth(1).getByTestId("tavrn-chip-body")).toHaveAttribute("data-state", "private");
  await expect(chips.nth(1)).not.toContainText("geheim-xyz");

  const card = page.getByTestId("message").filter({ hasText: "Tanks:" });
  await expect(card.locator(`[data-mention][data-address="${bob.username}@localhost"]`)).toBeVisible();
  await expect(card.locator('a[href^="mailto:"]')).toHaveCount(0);

  // The role pill: a labelled dialog with the role's members; axe on the list and the dialog.
  const greeting = page.getByTestId("message").filter({ hasText: "Hallo" });
  await greeting.locator('[data-mention="role"]').click();
  const roleList = page.getByTestId("role-popover");
  await expect(roleList).toBeVisible();
  await expect(roleList.locator(`[data-address="${bob.username}@localhost"]`)).toBeVisible();
  await axe(page, '[data-testid="role-popover"]');
  await page.keyboard.press("Escape");
  await expect(roleList).toHaveCount(0);

  // The user pill: the profile card with "Full profile".
  await greeting.locator('[data-mention="self"]').click();
  const profile = page.getByTestId("profile-popover");
  await expect(profile).toBeVisible();
  await expect(profile.getByTestId("profile-full")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await axe(page, '[data-testid="message-list"]');

  // The chip opens the channel inside the client (no page load: the marker survives).
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await chips.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/channels/${raids.id}$`));
  await expect(page.getByTestId("channel-name")).toHaveText("raids");
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});
