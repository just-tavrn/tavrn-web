// SPDX-License-Identifier: Apache-2.0
/**
 * Content auto-moderation of unencrypted channels (protocol MODERATION.md §2): the owner writes rules in the room
 * settings; a blocked message is explained in the composer and nothing is stored, a link of a blocked domain is
 * removed silently, and the matches reach the moderators' inbox. Phone and desktop.
 */
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi, uniqueName } from "./helpers";
import { joinRoom } from "./menu-helpers";
import { scaled } from "./timeouts";

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

test.describe("Auto-moderation", () => {
  test("rules block words with an explanation in the composer and remove links of blocked domains", async ({ browser, page, request }) => {
    test.setTimeout(scaled(120_000));
    const owner = await registerViaApi(request, "owner");
    const member = await registerViaApi(request, "member");
    const room = await createRoomViaApi(request, owner.token, uniqueName("Filterraum"));
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await joinRoom(request, owner, room.id, member);

    // The owner writes two rules in the settings.
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/automod`);
    await expect(page.getByTestId("automod-plaintext-only")).toBeVisible();
    await expect(page.getByTestId("automod-burst")).toContainText("10");
    await page.getByTestId("automod-rule-add").click();
    let rule = page.getByTestId("automod-rule").nth(0);
    await rule.getByTestId("automod-rule-name").fill("Schimpfwörter");
    await rule.getByTestId("automod-rule-terms").fill("doofkopf\nblöd*");
    await page.getByTestId("automod-rule-add").click();
    rule = page.getByTestId("automod-rule").nth(1);
    await rule.getByTestId("automod-rule-name").fill("Werbelinks");
    await rule.getByTestId("automod-rule-links").selectOption("block_list");
    await rule.getByTestId("automod-rule-domains").fill("spam.test");
    await rule.getByTestId("automod-rule-action").selectOption("delete");
    await page.getByTestId("automod-save").click();
    await expect(page.getByText("Regeln der Auto-Moderation gespeichert")).toBeVisible();
    const saved = (await (await request.get(`${NODE}/api/v1/rooms/${room.id}/automod`, auth(owner.token))).json()) as { rules: { name: string; terms: string[] }[] };
    expect(saved.rules.map((r) => r.name)).toEqual(["Schimpfwörter", "Werbelinks"]);

    // The member writes.
    const memberContext = await browser.newContext({ ...test.info().project.use });
    const m = await memberContext.newPage();
    await loginAs(m, member);
    await m.goto(`/rooms/${room.id}/channels/${channel}`);
    const box = m.getByLabel("Nachricht", { exact: true });
    await expect(box).toBeEnabled({ timeout: 20_000 });
    await box.fill("Du Doofkopf!");
    await m.keyboard.press("Enter");
    await expect(m.getByTestId("composer-blocked")).toContainText("Schimpfwörter");
    await expect(box).toHaveValue("Du Doofkopf!");
    await box.fill("Schau auf spam.test/gewinn vorbei");
    await m.keyboard.press("Enter");
    await expect(m.getByTestId("composer-blocked")).toHaveCount(0);
    await expect(box).toHaveValue("");
    await expect(m.getByTestId("message").filter({ hasText: "spam.test" })).toHaveCount(0, { timeout: 20_000 });
    await box.fill("Ganz freundlich");
    await m.keyboard.press("Enter");
    await expect(m.getByTestId("message").filter({ hasText: "Ganz freundlich" })).toBeVisible();
    await memberContext.close();

    // Nothing of the blocked text was stored; the matches are in the audit log (without the text) and the inbox.
    const messages = (await (await request.get(`${NODE}/api/v1/conversations/${channel}/messages`, auth(owner.token))).json()) as { content: { body?: string } }[];
    expect(messages.map((x) => x.content.body).filter(Boolean)).not.toContain("Du Doofkopf!");
    const log = (await (await request.get(`${NODE}/api/v1/rooms/${room.id}/audit-log`, auth(owner.token))).json()) as { action: string; reason: string }[];
    expect(log.filter((e) => e.action === "automod.content").map((e) => e.reason).sort()).toEqual(["Schimpfwörter", "Werbelinks"]);
    expect(JSON.stringify(log)).not.toContain("Du Doofkopf");
    await page.goto(`/rooms/${room.id}/settings/reports`);
    const row = page.getByTestId("report-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Auto-Moderation");
  });
});
