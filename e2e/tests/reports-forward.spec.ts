// SPDX-License-Identifier: Apache-2.0
/**
 * Reports v2 (protocol MODERATION.md §1.6): a member of a.test reports a message that a user of b.test wrote in a
 * room on a.test; the admin of a.test forwards the report to b.test after a confirmation, and the admin of b.test
 * finds it in the inbox marked with its origin and the reporter's pseudonym, never the reporter's address. Two
 * nodes, phone and desktop; the axe gate covers the confirmation and both inboxes.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createRoomViaApi, registerViaApi, uniqueName } from "./helpers";
import { A, B, FEDERATION_BROWSER, NODE_A, NODE_B, chromiumOnly, fedAdmin, federatedSession, openAdminOn } from "./federation-helpers";
import { scaled } from "./timeouts";

test.use(FEDERATION_BROWSER);

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function axeClean(page: Page, selector: string) {
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
  const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`)).toEqual([]);
}

test.describe("Forwarding reports to the home node", () => {
  chromiumOnly();

  test("the admin of a.test forwards a report about a user of b.test; b.test's admin sees it with its origin", async ({ browser, page, request }) => {
    test.setTimeout(scaled(180_000));
    const adminA = await fedAdmin(request, A);
    const adminB = await fedAdmin(request, B);
    const alice = await registerViaApi(request, "fwdalice", NODE_A);
    const carol = await registerViaApi(request, "fwdcarol", NODE_B);

    // carol of b.test joins alice's room on a.test and posts there; alice reports the message.
    const room = await createRoomViaApi(request, alice.token, uniqueName("Weiterleitung"), "invite", { base: NODE_A });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    const invite = await request.post(`${NODE_A}/api/v1/rooms/${room.id}/invites`, { ...auth(alice.token), data: {} });
    expect(invite.ok(), await invite.text()).toBeTruthy();
    const onA = await federatedSession(request, NODE_B, carol.token, A, NODE_A);
    const join = await request.post(`${NODE_A}/api/v1/invites/${(await invite.json()).code}/join`, { ...auth(onA), data: {} });
    expect(join.ok(), await join.text()).toBeTruthy();
    const sent = await request.post(`${NODE_A}/api/v1/rooms/${room.id}/channels/${channel}/messages`, { ...auth(onA), data: { content: { type: "text", body: "Follower zu verkaufen" } } });
    expect(sent.ok(), await sent.text()).toBeTruthy();
    const reported = await request.post(`${NODE_A}/api/v1/reports`, {
      ...auth(alice.token),
      data: { kind: "message", conversation_id: channel, message_id: (await sent.json()).id, category: "spam", detail: "Wirbt in jedem Kanal" },
    });
    expect(reported.status(), await reported.text()).toBe(201);
    const reportId = (await reported.json()).id as string;

    // a.test: the admin forwards it from the inbox after the confirmation.
    await openAdminOn(page, A, adminA, "/admin/reports");
    const row = page.locator(`[data-testid="report-row"][data-report="${reportId}"]`);
    await expect(row).toContainText(`${carol.username}@${B}`, { timeout: 20_000 });
    await row.click();
    const detail = page.getByTestId("report-detail");
    await expect(detail.getByTestId("report-forward-bar")).toContainText(B);
    await detail.getByTestId("report-forward").click();
    const confirm = page.getByTestId("report-forward-confirm");
    await expect(page.getByRole("dialog", { name: `Meldung an ${B} weiterleiten?` })).toBeVisible();
    await expect(confirm).toContainText("Pseudonym");
    await axeClean(page, "[role=dialog]");
    await confirm.getByRole("button", { name: "Weiterleiten" }).click();
    await expect(page.getByText(`Meldung an ${B} weitergeleitet`)).toBeVisible();
    await expect(detail.getByTestId("report-forwarded")).toContainText(`an ${B}`);
    await expect(detail.getByTestId("report-forward")).toHaveCount(0);
    await expect(row.getByTestId("report-forwarded-badge")).toHaveText(`Weitergeleitet an ${B}`);
    await axeClean(page, "[data-testid=reports-inbox]");

    // b.test: the report arrives through the federation outbox (worker every few seconds).
    let forwarded: { id: string; origin: { reporter: string } } | undefined;
    await expect
      .poll(
        async () => {
          const list = await (await request.get(`${NODE_B}/api/v1/admin/reports?limit=100`, auth(adminB.token))).json();
          forwarded = (list.reports as Array<{ id: string; origin: { node: string; report_id: string; reporter: string } | null }>).find((r) => r.origin?.report_id === reportId) as typeof forwarded;
          return !!forwarded;
        },
        { timeout: scaled(60_000) },
      )
      .toBe(true);
    const bContext = await browser.newContext({ ...test.info().project.use });
    const bPage = await bContext.newPage();
    await openAdminOn(bPage, B, adminB, "/admin/reports");
    const inRow = bPage.locator(`[data-testid="report-row"][data-report="${forwarded!.id}"]`);
    await expect(inRow.getByTestId("report-origin-badge")).toHaveText(`Weitergeleitet von ${A}`, { timeout: 20_000 });
    await expect(inRow).toContainText(forwarded!.origin.reporter);
    await expect(inRow).not.toContainText(alice.username);
    await inRow.click();
    const inDetail = bPage.getByTestId("report-detail");
    await expect(inDetail.getByTestId("report-reporter")).toContainText(forwarded!.origin.reporter);
    await expect(inDetail.getByTestId("report-origin")).toContainText(A);
    await expect(inDetail.getByTestId("report-snapshot")).toContainText("Follower zu verkaufen");
    await expect(inDetail.getByTestId("report-forward")).toHaveCount(0);
    await expect(inDetail).not.toContainText(alice.username);
    await axeClean(bPage, "[data-testid=reports-inbox]");
    await bContext.close();
  });
});
