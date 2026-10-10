// SPDX-License-Identifier: Apache-2.0
// The channel list's access marks (docs/CLIENT.md "Channel list marks"): the owner denies @everyone "connect" on the
// voice channel (through the channel editor, whose line spells out the effect) and "view" on a text channel that Bob's
// role may view again. Bob's list shows the voice channel restricted for him and both channels as private; the owner,
// with every right, sees only the private marks. The lock stays the encryption mark. axe on the list and the editor.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";

async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("private and restricted channel marks for a member and the owner", async ({ browser, page, request }) => {
  test.setTimeout(120_000);
  const owner = await registerViaApi(request, "own");
  const bob = await registerViaApi(request, "bob");
  const room = await createRoomViaApi(request, owner.token, "Zugang");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const call = async (method: "post" | "patch" | "put" | "get", path: string, data?: object) => {
    const resp = await request[method](`${NODE}/api/v1/rooms/${room.id}${path}`, { headers: auth, ...(data ? { data } : {}) });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    return resp.json().catch(() => null);
  };
  const voice = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!;
  const intern = await call("post", "/channels", { kind: "text", name: "intern" });
  const crew = await call("post", "/roles", { name: "Crew", permissions: "0" });
  const code = (await call("post", "/invites", {})).code as string;
  expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${bob.token}` }, data: {} })).ok()).toBeTruthy();
  await call("patch", `/members/${bob.userId}`, { roles: [crew.id] });
  const everyone = ((await call("get", "")).roles as { id: string; is_everyone: boolean }[]).find((r) => r.is_everyone)!.id;
  // "intern": @everyone may not view it, the Crew role may.
  await call("put", "/overrides", { target_type: "channel", target_id: intern.id, subject_type: "role", subject_id: everyone, allow: "0", deny: "1" });
  await call("put", "/overrides", { target_type: "channel", target_id: intern.id, subject_type: "role", subject_id: crew.id, allow: "1", deny: "0" });

  // The owner denies @everyone "connect" in the channel editor; the line under the name says what that means.
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/channels?channel=${voice.id}`);
  const editor = page.getByTestId("channel-editor");
  await expect(editor.getByTestId("channel-access-line")).toHaveCount(0);
  await editor.getByRole("radio", { name: "Verbinden: verbieten" }).click();
  await editor.getByRole("button", { name: "Berechtigungen speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Berechtigungen gespeichert" })).toBeVisible();
  await expect(editor.getByTestId("channel-access-line")).toHaveText("Beitreten nur für bestimmte Rollen");
  await page.getByRole("button", { name: /^# intern/ }).click();
  await expect(editor.getByTestId("channel-access-line")).toHaveText("Nur für bestimmte Rollen sichtbar");
  await axe(page, "[data-testid='channel-editor']");

  // The owner's list: only the private marks (all rights, nothing restricted); the lock stays on the text channels.
  await page.goto(`/rooms/${room.id}/channels/${intern.id}`);
  await openNavIfMobile(page);
  const nav = page.getByRole("navigation", { name: "Channels" });
  const voiceRow = (p: Page) => p.getByRole("navigation", { name: "Channels" }).locator(`[data-testid='voice-channel'][data-channel='${voice.id}']`);
  const internRow = (p: Page) => p.getByRole("navigation", { name: "Channels" }).locator(`[data-channel='${intern.id}']`);
  await expect(internRow(page).getByTestId("channel-private")).toHaveAccessibleName("Nur für bestimmte Rollen sichtbar");
  await expect(internRow(page).getByTestId("channel-lock")).toBeVisible();
  await expect(voiceRow(page).getByTestId("channel-private")).toHaveAccessibleName("Beitreten nur für bestimmte Rollen");
  await expect(nav.getByTestId("channel-restricted")).toHaveCount(0);

  // Bob: the voice channel is restricted for him (dimmed name, no-entry mark, both named on the link); "intern" is
  // private but his role may use it.
  const ctx = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: test.info().project.name.includes("mobile"), hasTouch: test.info().project.name.includes("mobile") });
  const bobPage = await ctx.newPage();
  await loginAs(bobPage, bob);
  await bobPage.goto(`/rooms/${room.id}/channels/${intern.id}`);
  await expect(bobPage.getByTestId("channel-name")).toHaveText("intern");
  await openNavIfMobile(bobPage);
  const bobNav = bobPage.getByRole("navigation", { name: "Channels" });
  await expect(voiceRow(bobPage).getByTestId("channel-restricted")).toHaveAccessibleName("Du siehst diesen Channel, kannst ihm aber nicht beitreten");
  await expect(voiceRow(bobPage).getByTestId("channel-private")).toBeVisible();
  await expect(voiceRow(bobPage).getByRole("link")).toHaveAccessibleName(/^Sprachkanal .+, Beitreten nur für bestimmte Rollen, Du siehst diesen Channel, kannst ihm aber nicht beitreten$/);
  await expect(internRow(bobPage).getByTestId("channel-private")).toBeVisible();
  await expect(internRow(bobPage).getByTestId("channel-restricted")).toHaveCount(0);
  await expect(bobNav.getByTestId("channel-restricted")).toHaveCount(1);
  await axe(bobPage, "nav[aria-label='Channels']");

  // The dimmed name is fg-2 (4.5:1 on the sidebar); as the open channel it returns to fg-0 (fg-2 misses 4.5:1 on the
  // selection tint).
  const voiceName = voiceRow(bobPage).getByRole("link").locator("span.truncate");
  await expect(voiceName).toHaveCSS("color", "rgb(138, 146, 162)");
  // The row stays clickable: the stage explains that Bob may not join.
  await voiceRow(bobPage).getByRole("link").click();
  await expect(bobPage.getByText("Du darfst diesen Sprachkanal nicht betreten.")).toBeVisible();
  await openNavIfMobile(bobPage);
  await expect(voiceName).toHaveCSS("color", "rgb(243, 244, 246)");
  await ctx.close();
});
