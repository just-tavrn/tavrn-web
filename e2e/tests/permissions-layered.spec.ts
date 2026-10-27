// SPDX-License-Identifier: Apache-2.0
// Layered permission overrides (tavrn-protocol permissions.md "Evaluation"): the owner's example through the real UI.
// @everyone loses "view channel" on the role, one channel allows it again; a plain member then sees exactly that
// channel and its category. The category and channel editors are checked with axe.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { scaled } from "./timeouts";

async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("deny view on @everyone, allow it on one channel: a member sees exactly that channel and its category", async ({ browser, page, request }) => {
  test.setTimeout(scaled(120_000));
  const owner = await registerViaApi(request, "own");
  const member = await registerViaApi(request, "mem");
  const room = await createRoomViaApi(request, owner.token, "Schichten");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const post = async (path: string, data: object) => {
    const resp = await request.post(`${NODE}/api/v1/rooms/${room.id}/${path}`, { headers: auth, data });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    return resp.json();
  };
  const team = await post("categories", { name: "Team" });
  const staff = await post("categories", { name: "Leitung" });
  const offen = await post("channels", { kind: "text", name: "offen", category_id: team.id });
  await post("channels", { kind: "text", name: "geheim", category_id: team.id });
  await post("channels", { kind: "text", name: "intern", category_id: staff.id });
  const code = (await post("invites", {})).code as string;
  expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${member.token}` }, data: {} })).ok()).toBeTruthy();

  // The owner takes "view channel" away from @everyone on the role …
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/roles`);
  await page.getByTestId("role-list").getByRole("button", { name: /@everyone/ }).first().click();
  const roleEditor = page.getByTestId("role-editor");
  await roleEditor.getByLabel("Channel ansehen").uncheck();
  await roleEditor.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rolle gespeichert" })).toBeVisible();

  // … and allows it on one channel. The editor has no sync switch and shows what "–" inherits.
  await page.goto(`/rooms/${room.id}/settings/channels`);
  await page.getByRole("button", { name: /^# offen\b/ }).click();
  const editor = page.getByTestId("channel-editor");
  await expect(editor.getByText("Berechtigungen mit der Kategorie synchronisieren")).toHaveCount(0);
  await expect(editor.getByTestId("inherited-VIEW_CHANNEL")).toHaveText("Geerbt: von den Rollen verboten");
  await expect(editor.getByRole("radiogroup", { name: "Mitglieder bannen" })).toHaveCount(0);
  await editor.getByRole("radio", { name: "Channel ansehen: erlauben" }).click();
  await editor.getByRole("button", { name: "Berechtigungen speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Berechtigungen gespeichert" })).toBeVisible();
  await expect(editor.getByTestId("reset-to-category")).toBeVisible();
  await axe(page, "[data-testid='channel-editor']");

  // The category has the same editor; it stays neutral here.
  await page.getByRole("button", { name: "Team: Berechtigungen der Kategorie" }).click();
  const categoryEditor = page.getByTestId("category-editor");
  await expect(categoryEditor.getByRole("heading", { name: "Berechtigungen in dieser Kategorie: Team" })).toBeVisible();
  await expect(categoryEditor.getByRole("radio", { name: "Channel ansehen: neutral" })).toHaveAttribute("aria-checked", "true");
  await axe(page, "[data-testid='category-editor']");

  // The member sees the welcome channel, "offen" and its category; nothing of "geheim", "intern" or "Leitung".
  const ctx = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: test.info().project.name.includes("mobile"), hasTouch: test.info().project.name.includes("mobile") });
  const memberPage = await ctx.newPage();
  await loginAs(memberPage, member);
  await memberPage.goto(`/rooms/${room.id}`);
  await expect(memberPage.getByTestId("channel-name")).toHaveText("offen");
  await openNavIfMobile(memberPage);
  const nav = memberPage.getByRole("navigation", { name: "Channels" });
  const rows = nav.getByTestId("channel-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-kind", "system");
  await expect(rows.nth(1)).toContainText("offen");
  await expect(nav.getByText("Team", { exact: true })).toBeVisible();
  await expect(nav.getByText("Leitung", { exact: true })).toHaveCount(0);
  await expect(nav.getByText("geheim")).toHaveCount(0);

  // The owner hides "offen" again: the open channel disappears for the member, as lost access, not as deleted
  // (`channel.delete` with `hidden`, PROTOCOL.md §6).
  const everyone = ((await (await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth })).json()).roles as Array<{ id: string; is_everyone: boolean }>).find((r) => r.is_everyone)!.id;
  const hide = await request.put(`${NODE}/api/v1/rooms/${room.id}/overrides`, { headers: auth, data: { target_type: "channel", target_id: offen.id, subject_type: "role", subject_id: everyone, allow: "0", deny: "1" } });
  expect(hide.ok(), await hide.text()).toBeTruthy();
  await expect(memberPage.getByText("Du hast keinen Zugriff mehr auf diesen Channel.")).toBeVisible();
  await ctx.close();
});

test("the category editor's hint under a neutral role names the category's own @everyone deny", async ({ page, request }) => {
  test.setTimeout(scaled(60_000));
  const owner = await registerViaApi(request, "own");
  const room = await createRoomViaApi(request, owner.token, "Verborgen");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const call = async (method: "post" | "put" | "get", path: string, data?: object) => {
    const resp = await request[method](`${NODE}/api/v1/rooms/${room.id}${path}`, { headers: auth, data });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    return resp.json();
  };
  const team = await call("post", "/categories", { name: "Team" });
  await call("post", "/channels", { kind: "text", name: "intern", category_id: team.id });
  await call("post", "/roles", { name: "Moderator", position: 1, permissions: "0" });
  const everyone = ((await call("get", "")).roles as Array<{ id: string; is_everyone: boolean }>).find((r) => r.is_everyone)!.id;
  // The category hides itself from @everyone; Moderator has no override of its own, so moderators cannot see it either.
  await call("put", "/overrides", { target_type: "category", target_id: team.id, subject_type: "role", subject_id: everyone, allow: "0", deny: "1" });

  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/channels`);
  await page.getByRole("button", { name: "Team: Berechtigungen der Kategorie" }).click();
  const categoryEditor = page.getByTestId("category-editor");
  await categoryEditor.getByRole("combobox", { name: "Rolle" }).selectOption({ label: "Moderator" });
  await expect(categoryEditor.getByTestId("inherited-VIEW_CHANNEL")).toHaveText("Geerbt: von @everyone hier verboten");
  await expect(categoryEditor.getByTestId("inherited-SEND_MESSAGES")).toHaveText("Geerbt: von den Rollen erlaubt");
});
