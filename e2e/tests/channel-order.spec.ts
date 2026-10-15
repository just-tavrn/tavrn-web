// SPDX-License-Identifier: Apache-2.0
// Reordering channels and categories in Room settings → Channels (docs/CLIENT.md "Reordering channels", #179): with a
// mouse by HTML5 drag and drop (Playwright's dragTo drives Chromium's native drag events), on touch with the ▲/▼
// buttons and the channel editor's category dropdown. The order survives a reload, the sidebar shows it, axe scans the
// tree, and a member without "Manage channels" gets no handles (the sidebar is never draggable).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { isTouch, joinRoom } from "./menu-helpers";
import { scaled } from "./timeouts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** The channel ids per group of the settings tree, groups in display order (`""`: without category). */
async function treeOrder(page: Page): Promise<Array<[string, string[]]>> {
  return page.getByTestId("channel-tree-group").evaluateAll((groups) =>
    groups.map((g) => [g.getAttribute("data-category") ?? "", [...g.querySelectorAll("[data-testid='channel-tree-row']")].map((r) => r.getAttribute("data-channel") ?? "")] as [string, string[]]),
  );
}

/** The channel ids of the sidebar in display order, limited to `ids`. */
async function sidebarOrder(page: Page, ids: string[]): Promise<string[]> {
  const all = await page.getByRole("navigation", { name: "Channels" }).locator("[data-testid='channel-row']").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-channel") ?? ""));
  return all.filter((id) => ids.includes(id));
}

test("channels and categories are reordered in the room settings and the sidebar follows", async ({ browser, page, request }) => {
  test.setTimeout(scaled(120_000));
  const owner = await registerViaApi(request, "own");
  const member = await registerViaApi(request, "mem");
  const room = await createRoomViaApi(request, owner.token, "Ordnung");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const post = async (path: string, data: object) => {
    const resp = await request.post(`${NODE}/api/v1/rooms/${room.id}${path}`, { headers: auth, data });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    return resp.json();
  };
  const hall = await post("/categories", { name: "Halle" });
  const cellar = await post("/categories", { name: "Keller" });
  const alpha = await post("/channels", { kind: "text", name: "alpha", category_id: hall.id });
  const beta = await post("/channels", { kind: "text", name: "beta", category_id: hall.id });
  const gamma = await post("/channels", { kind: "text", name: "gamma", category_id: hall.id });
  await joinRoom(request, owner, room.id, member);
  const detail = await (await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth })).json();
  const general = detail.categories.find((c: { id: string }) => c.id !== hall.id && c.id !== cellar.id).id as string;
  const ids = [alpha.id, beta.id, gamma.id];

  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/channels`);
  const tree = page.getByTestId("channel-tree");
  await expect(tree).toBeVisible();
  const row = (id: string) => tree.locator(`[data-testid='channel-tree-row'][data-channel='${id}']`);
  const header = (id: string) => tree.locator(`[data-testid='channel-tree-category'][data-category='${id}']`);
  const saved = page.getByRole("status").filter({ hasText: "Reihenfolge gespeichert" });
  const group = async (id: string) => (await treeOrder(page)).find(([g]) => g === id)?.[1].filter((c) => ids.includes(c));
  await expect.poll(() => group(hall.id)).toEqual([alpha.id, beta.id, gamma.id]);

  const scan = new AxeBuilder({ page }).include("[data-testid='channel-tree']").withTags(TAGS);
  const blocking = (await scan.analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

  // A channel one step down.
  if (isTouch()) await tree.getByRole("button", { name: "alpha nach unten", exact: true }).click();
  else await tree.getByRole("img", { name: "alpha ziehen zum Umsortieren" }).dragTo(row(beta.id));
  await expect(saved.first()).toBeVisible();
  await expect.poll(() => group(hall.id)).toEqual([beta.id, alpha.id, gamma.id]);

  // Into the other category: dropped on its header, or the editor's category dropdown (to the end of the category).
  if (isTouch()) {
    await row(alpha.id).getByRole("button", { name: /alpha/ }).first().click();
    const editor = page.getByTestId("channel-editor");
    await editor.getByRole("combobox", { name: "Kategorie" }).selectOption(cellar.id);
    await editor.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Channel gespeichert" }).first()).toBeVisible();
  } else {
    await tree.getByRole("img", { name: "alpha ziehen zum Umsortieren" }).dragTo(header(cellar.id));
  }
  await expect.poll(() => group(cellar.id)).toEqual([alpha.id]);
  await expect.poll(() => group(hall.id)).toEqual([beta.id, gamma.id]);

  // A category one step up.
  if (isTouch()) await tree.getByRole("button", { name: "Kategorie Keller nach oben", exact: true }).click();
  else await tree.getByRole("img", { name: "Kategorie Keller ziehen zum Umsortieren" }).dragTo(header(hall.id));
  const categories = async () => (await treeOrder(page)).map(([g]) => g).filter((g) => g !== "");
  await expect.poll(categories).toEqual([general, cellar.id, hall.id]);

  // Stored by the node: the same order after a reload, in the tree and in the sidebar.
  await page.reload();
  await expect(tree).toBeVisible();
  await expect.poll(categories).toEqual([general, cellar.id, hall.id]);
  await expect.poll(() => group(cellar.id)).toEqual([alpha.id]);
  await expect.poll(() => group(hall.id)).toEqual([beta.id, gamma.id]);
  await page.goto(`/rooms/${room.id}`);
  await openNavIfMobile(page);
  await expect.poll(() => sidebarOrder(page, ids)).toEqual([alpha.id, beta.id, gamma.id]);
  await expect(page.getByRole("navigation", { name: "Channels" }).locator("[draggable='true']")).toHaveCount(0);

  // Without "Manage channels": no Channels tab (the address falls back to the overview), no handles, nothing draggable.
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginAs(memberPage, member);
  await memberPage.goto(`/rooms/${room.id}/settings/channels`);
  await expect(memberPage).toHaveURL(/\/settings\/overview$/);
  await expect(memberPage.getByTestId("reorder-handle")).toHaveCount(0);
  await memberPage.goto(`/rooms/${room.id}`);
  await openNavIfMobile(memberPage);
  await expect.poll(() => sidebarOrder(memberPage, ids)).toEqual([alpha.id, beta.id, gamma.id]);
  await expect(memberPage.getByRole("navigation", { name: "Channels" }).locator("[draggable='true']")).toHaveCount(0);
  await memberContext.close();
});
