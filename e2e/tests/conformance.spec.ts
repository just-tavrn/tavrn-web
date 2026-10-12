// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { type Account, createRoomViaApi, registerViaApi, uniqueName } from "./helpers";
import { A, B, FEDERATION_BROWSER, NODE_A, NODE_B, WEB_A, chromiumOnly, fedAdmin, federatedSession, loginOn, openAdminOn, withNodeLock } from "./federation-helpers";
import { scaled } from "./timeouts";

test.use(FEDERATION_BROWSER);

// Conformance checks (FEDERATION.md §9): the admin of a.test checks b.test (a conforming node) and the
// never-answering c.test, blocks and unblocks it; the web client warns about and hides a node its home
// node blocks or that failed the check (§9.2).

/** Serializes a section across workers and projects (they share the nodes). */
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withNodeLock(A, name, fn);
}

/** The node admin of a.test (`TAVRN_ADMIN_USERS=fedadmin`), cached next to its database across runs. */
function adminOfA(request: APIRequestContext): Promise<Account> {
  return fedAdmin(request, A);
}

/** Opens a.test's admin page as `admin`. */
async function openAdmin(page: Page, admin: Account) {
  await openAdminOn(page, A, admin, "/admin/federation");
  await expect(page.getByRole("heading", { name: "Andere Knoten" })).toBeVisible();
}

/** Runs the check of `domain` from the form; retries while another run of the same peer is in progress. */
async function checkFromForm(page: Page, domain: string) {
  const row = page.locator(`[data-testid="federation-peer"][data-domain="${domain}"]`);
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = (await row.count()) ? await row.locator("p").first().textContent() : null;
    await page.getByLabel("Knoten prüfen").fill(domain);
    await page.getByRole("button", { name: "Knoten prüfen" }).click();
    await expect(page.getByRole("button", { name: "Knoten prüfen" })).toBeEnabled({ timeout: 70_000 });
    if ((await row.count()) && (await row.getByTestId("conformance-results").count()) && (await row.locator("p").first().textContent()) !== before) return row;
    await page.waitForTimeout(3_000);
  }
  throw new Error(`the check of ${domain} did not finish`);
}

test.describe("Conformance check of other nodes", () => {
  chromiumOnly();

  test("The admin checks b.test and c.test, blocks and unblocks c.test", async ({ page, request }) => {
    test.setTimeout(scaled(240_000));
    const admin = await adminOfA(request);
    await openAdmin(page, admin);

    // b.test conforms: every hard check passes (the rate check skips its burst: the published limit is high).
    const b = await withLock("check-b", () => checkFromForm(page, B));
    await expect(b.getByTestId("peer-conformance")).toHaveAttribute("data-result", /^(pass|warn)$/);
    await expect(b.getByTestId("peer-status")).toHaveAttribute("data-status", "ok");
    const results = b.getByTestId("conformance-results");
    for (const id of ["wk.schema", "token.accept", "token.bad_signature", "token.alg", "token.replay", "s2s.body_hash", "mls.sequence", "mls.reject", "msg.plaintext"]) {
      await expect(results.locator(`[data-check="${id}"]`)).toHaveAttribute("data-result", "pass");
    }
    await expect(results.locator('[data-check="rate.limits"]')).toHaveAttribute("data-result", "skip");
    // Hiding and showing the checks.
    await b.getByRole("button", { name: "Prüfungen ausblenden" }).click();
    await expect(results).toHaveCount(0);
    await b.getByRole("button", { name: "Prüfungen zeigen" }).click();
    await expect(b.getByTestId("conformance-results")).toBeVisible();

    await withLock("check-c", async () => {
      // c.test never answers: a warning, never a block.
      const c = await checkFromForm(page, "c.test");
      await expect(c.getByTestId("peer-conformance")).toHaveAttribute("data-result", "warn");
      await expect(c.getByTestId("conformance-results").locator('[data-check="wk.fetch"]')).toHaveAttribute("data-result", "warn");
      if ((await c.getByTestId("peer-status").getAttribute("data-status")) !== "ok") {
        await c.getByRole("button", { name: "Entsperren" }).click();
        await expect(c.getByTestId("peer-status")).toHaveAttribute("data-status", "ok");
      }
      await c.getByRole("button", { name: "Sperren" }).click();
      await expect(c.getByTestId("peer-status")).toHaveAttribute("data-status", "blocked");
      await expect(c.getByTestId("peer-status")).toHaveText("gesperrt");
      const state = await request.get(`${NODE_A}/api/v1/federation/peers/c.test/state`);
      expect((await state.json()).blocked).toBe(true);
      await c.getByRole("button", { name: "Entsperren" }).click();
      await expect(c.getByTestId("peer-status")).toHaveAttribute("data-status", "ok");
    });

    await page.getByRole("link", { name: "Audit-Log" }).click();
    await expect(page.getByTestId("admin-audit-list")).toContainText("admin.federation_block");
    await expect(page.getByTestId("admin-audit-list")).toContainText("admin.federation_unblock");
    await expect(page.getByTestId("admin-audit-list")).toContainText("admin.federation_check");
  });

  test("Users report a node via Discover, the admin sees and handles the reports", async ({ page, request }) => {
    test.setTimeout(scaled(180_000));
    // A discoverable room on b.test makes b.test announce itself to a.test.
    const bob = await registerViaApi(request, "frepb", NODE_B);
    const roomName = uniqueName("Gemeldet ");
    const room = await createRoomViaApi(request, bob.token, roomName, "public", { base: NODE_B });
    await expect
      .poll(async () => (await (await request.get(`${NODE_A}/api/v1/directory/rooms?q=${encodeURIComponent(roomName)}`)).json()).items.map((r: { room_id: string }) => r.room_id), { timeout: 30_000 })
      .toContain(room.id);

    // alice (a.test) reports the room from a.test's Discover page.
    const alice = await registerViaApi(request, "frep", NODE_A);
    await loginOn(page, WEB_A, alice, { domain: A, remote: false });
    await page.goto(`${WEB_A}/discover`);
    await page.getByTestId("discover-search").fill(roomName);
    const card = page.locator(`[data-testid="discover-room"][data-room="${room.id}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: `Melden: ${roomName} (${B})` }).click();
    const dialog = page.getByTestId("report-dialog");
    await expect(dialog).toContainText(`nicht an ${B}`);
    await dialog.getByLabel("Grund").selectOption("abuse");
    await dialog.getByLabel("Details (optional)").fill("Beleidigungen im Kanal");
    await dialog.getByRole("button", { name: "Meldung senden" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Meldung an die Admins deines Knotens gesendet." })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // a.test lists itself; its own card offers no report.
    await page.getByRole("tab", { name: "Knoten" }).click();
    const own = page.locator(`[data-testid="discover-node-card"][data-node="${A}"]`);
    await expect(own).toBeVisible({ timeout: 20_000 });
    await expect(own.getByTestId("discover-report")).toHaveCount(0);
    // c.test (never listed) gets a report through the API, for the admin actions below.
    const viaApi = await request.post(`${NODE_A}/api/v1/directory/reports`, { headers: { Authorization: `Bearer ${alice.token}` }, data: { domain: "c.test", check: "spam", detail: "" } });
    expect(viaApi.status(), await viaApi.text()).toBe(201);

    // The admin of a.test sees the reports in the Federation tab.
    const admin = await adminOfA(request);
    await openAdmin(page, admin);
    const rowB = page.locator(`[data-testid="report-node"][data-domain="${B}"]`);
    await expect(rowB.getByTestId("report-count")).toBeVisible();
    await rowB.getByRole("button", { name: "Meldungen anzeigen" }).click();
    const entry = rowB.getByTestId("report-entry").filter({ hasText: `${alice.username}@${A}` });
    await expect(entry).toContainText("abuse");
    await expect(entry).toContainText("Beleidigungen im Kanal");
    await rowB.getByRole("button", { name: "Meldungen ausblenden" }).click();
    await expect(rowB.getByTestId("report-entries")).toHaveCount(0);

    // Delisting, listing again and dismissing (on c.test, so b.test stays listed for the other specs).
    await withLock("reports-c", async () => {
      const rowC = page.locator(`[data-testid="report-node"][data-domain="c.test"]`);
      await expect(rowC).toBeVisible();
      if (await rowC.getByRole("button", { name: "Wieder listen" }).count()) await rowC.getByRole("button", { name: "Wieder listen" }).click();
      await rowC.getByRole("button", { name: "Aus dem Verzeichnis entfernen" }).click();
      await expect(rowC).toContainText("aus dem Verzeichnis entfernt");
      await rowC.getByRole("button", { name: "Wieder listen" }).click();
      await expect(rowC.getByRole("button", { name: "Aus dem Verzeichnis entfernen" })).toBeVisible();
      await rowC.getByRole("button", { name: "Verwerfen" }).click();
      await expect(rowC).toHaveCount(0);
    });
    await page.getByRole("link", { name: "Audit-Log" }).click();
    await expect(page.getByTestId("admin-audit-list")).toContainText("admin.directory_reports_dismiss");
  });

  test("The client warns about a failed node and blocks a blocked one", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    const alice = await registerViaApi(request, "fconf", NODE_A);
    const bob = await registerViaApi(request, "fconfb", NODE_B);
    const roomB = await createRoomViaApi(request, bob.token, uniqueName("geprüft "), "public", { base: NODE_B });
    const onB = await federatedSession(request, NODE_A, alice.token, B, NODE_B);
    const join = await request.post(`${NODE_B}/api/v1/rooms/${roomB.id}/join`, { headers: { Authorization: `Bearer ${onB}` }, data: { accept_rules: true } });
    expect(join.ok(), await join.text()).toBeTruthy();
    const items = [{ node: B, kind: "room", room_id: roomB.id, conversation_id: null, joined_at: new Date().toISOString() }];
    const put = await request.put(`${NODE_A}/api/v1/users/me/conversations-index`, { headers: { Authorization: `Bearer ${alice.token}` }, data: { items } });
    expect(put.ok(), await put.text()).toBeTruthy();

    // The home node's view of b.test, as a.test reports it (the real state is whatever the other specs
    // left; the client's reaction to each state is what is checked here).
    let state = { domain: B, conformance: "fail", blocked: false, keys: [] as unknown[] };
    await page.route(`**/api/v1/federation/peers/${B}/state`, (route) => route.fulfill({ json: state }));
    await loginOn(page, WEB_A, alice, { domain: A, remote: false });

    // Failed check: the room still works, with the warning above it.
    await page.goto(`${WEB_A}/n/${B}/rooms/${roomB.id}`);
    const warning = page.getByTestId("peer-failed-check");
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await expect(warning).toContainText("Sicherheitsprüfung nicht bestanden");
    await expect(warning).toContainText(B);
    await expect(page.getByTestId("channel-name")).toBeVisible();

    // Blocked by the home node: the node's views are replaced by the warning.
    state = { ...state, blocked: true };
    await page.reload();
    const blocked = page.getByTestId("peer-blocked");
    await expect(blocked).toBeVisible({ timeout: 15_000 });
    await expect(blocked).toContainText(`föderiert nicht mit ${B}`);
    await expect(page.getByTestId("channel-name")).toHaveCount(0);

    // Passed: nothing is shown.
    state = { ...state, blocked: false, conformance: "pass" };
    await page.reload();
    await expect(page.getByTestId("channel-name")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("peer-failed-check")).toHaveCount(0);
    await expect(page.getByTestId("peer-blocked")).toHaveCount(0);
  });
});
