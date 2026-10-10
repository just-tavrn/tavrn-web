// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createRoomViaApi, loginViaApi, openNavIfMobile, registerViaApi, uniqueName, railName } from "./helpers";
import { A, B, BROWSER_API_B, FEDERATION_BROWSER, NODE_A, NODE_B, WEB_A, WEB_B, chromiumOnly, federatedSession, indexOf, loginOn } from "./federation-helpers";

test.use(FEDERATION_BROWSER);

// Rooms on several nodes (FEDERATION.md §4): the conversation index on the home node is kept by the
// client and brings the rooms of every node back on a new device; a node that is down only marks its
// own rooms unreachable.
test.describe("Rooms on several nodes", () => {
  chromiumOnly();

  test("Index: a new device restores the rooms of both nodes", async ({ browser, page, request }) => {
    test.setTimeout(120_000);
    const alice = await registerViaApi(request, "fidx", NODE_A);
    const carol = await registerViaApi(request, "fcarol", NODE_A);
    const bob = await registerViaApi(request, "fbob", NODE_B);
    const roomA = await createRoomViaApi(request, carol.token, uniqueName("raum a "), "public", { base: NODE_A });
    const roomB = await createRoomViaApi(request, bob.token, uniqueName("raum b "), "public", { base: NODE_B });

    // First device, A's web client: join the public room of A.
    await loginOn(page, WEB_A, alice, { domain: A, remote: false });
    await loginOn(page, WEB_B, alice, { domain: A, remote: true });
    await page.goto(`${WEB_A}/`);
    await page.getByTestId("discover-list").locator("li").filter({ hasText: roomA.name }).getByRole("button", { name: "Beitreten" }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${roomA.id}/channels/`));
    await expect.poll(async () => (await indexOf(request, NODE_A, alice.token)).items.map((e) => `${e.node}/${e.room_id}`)).toContain(`${A}/${roomA.id}`);

    // B's web client with the same account of A: join a public room of B through the federated session.
    await page.goto(`${WEB_B}/`);
    const onB = page.locator(`[data-testid="discover-node"][data-node="${B}"]`);
    await onB.locator("li").filter({ hasText: roomB.name }).getByRole("button", { name: "Beitreten" }).click();
    await expect(page).toHaveURL(new RegExp(`/n/${B}/rooms/${roomB.id}/channels/`));
    await openNavIfMobile(page);
    await expect(page.getByTestId("room-node")).toHaveText(B);
    await expect.poll(async () => (await indexOf(request, NODE_A, alice.token)).items.map((e) => `${e.node}/${e.room_id}`)).toContain(`${B}/${roomB.id}`);

    // A new device (fresh browser profile) on A's web client: the index brings back both rooms.
    const second = await loginViaApi(request, alice, "Zweitgerät", NODE_A);
    const context = await browser.newContext({ ...test.info().project.use });
    const page2 = await context.newPage();
    await loginOn(page2, WEB_A, { ...alice, token: second.token, refresh: second.refresh, deviceId: second.deviceId }, { domain: A, remote: false });
    await page2.goto(`${WEB_A}/`);
    await openNavIfMobile(page2);
    await expect(page2.getByRole("link", { name: railName(roomA.name) })).toBeVisible();
    const remoteLink = page2.getByRole("link", { name: `${roomB.name} (${B})` });
    await expect(remoteLink).toBeVisible();
    await expect(page2.locator(`[data-testid="node-group"][data-node="${B}"]`)).toContainText(B);
    await remoteLink.click();
    await expect(page2).toHaveURL(new RegExp(`/n/${B}/rooms/${roomB.id}/channels/`));
    await expect(page2.getByTestId("channel-name")).toBeVisible();
    await openNavIfMobile(page2);
    await expect(page2.getByTestId("room-name")).toHaveText(roomB.name);
    await expect(page2.getByTestId("room-node")).toHaveText(B);
    await context.close();
  });

  test("One node is unreachable: only its rooms are affected", async ({ page, request }) => {
    test.setTimeout(120_000);
    const alice = await registerViaApi(request, "foff", NODE_A);
    const bob = await registerViaApi(request, "foffb", NODE_B);
    const roomA = await createRoomViaApi(request, alice.token, uniqueName("lokal "), "invite", { base: NODE_A });
    const roomB = await createRoomViaApi(request, bob.token, uniqueName("fern "), "public", { base: NODE_B });
    const onB = await federatedSession(request, NODE_A, alice.token, B, NODE_B);
    const join = await request.post(`${NODE_B}/api/v1/rooms/${roomB.id}/join`, { headers: { Authorization: `Bearer ${onB}` }, data: { accept_rules: true } });
    expect(join.ok(), await join.text()).toBeTruthy();
    const items = [
      { node: A, kind: "room", room_id: roomA.id, conversation_id: null, joined_at: new Date().toISOString() },
      { node: B, kind: "room", room_id: roomB.id, conversation_id: null, joined_at: new Date().toISOString() },
    ];
    const put = await request.put(`${NODE_A}/api/v1/users/me/conversations-index`, { headers: { Authorization: `Bearer ${alice.token}` }, data: { items } });
    expect(put.ok(), await put.text()).toBeTruthy();

    await loginOn(page, WEB_A, alice, { domain: A, remote: false });
    await page.goto(`${WEB_A}/`);
    await openNavIfMobile(page);
    const remoteLink = page.getByRole("link", { name: `${roomB.name} (${B})` });
    await expect(remoteLink).toBeVisible();

    // b.test goes down (every request of the browser to its API fails).
    let lastRequestToB = Date.now();
    page.on("request", (r) => {
      if (r.url().startsWith(`${BROWSER_API_B}/`)) lastRequestToB = Date.now();
    });
    await page.route(`${BROWSER_API_B}/**`, (route) => route.abort("connectionrefused"));
    await remoteLink.click();
    const banner = page.getByTestId("node-unreachable-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-node", B);
    await expect(banner).toContainText(B);
    await openNavIfMobile(page);
    await expect(page.locator(`[data-testid="node-group"][data-node="${B}"]`)).toHaveAttribute("data-unreachable", "true");

    // The room on A works as before.
    await page.getByRole("link", { name: railName(roomA.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${roomA.id}/channels/`));
    await expect(page.getByTestId("channel-name")).toBeVisible();
    await expect(banner).toHaveCount(0);

    // Back in b.test's room while it is still down: its views fail again and keep the banner with the retry.
    await openNavIfMobile(page);
    await remoteLink.click();
    // Phones: the drawer stays open after picking a room; close it to reach the banner.
    if ((await page.getByTestId("nav-drawer").getAttribute("data-open")) === "true") await page.getByRole("button", { name: "Drawer schließen" }).click({ position: { x: (page.viewportSize()?.width ?? 400) - 10, y: 200 } });
    const retry = banner.getByRole("button", { name: "Erneut versuchen" });
    await expect(retry).toBeVisible();
    // Any answer of b.test clears the state by itself, and the client retries a failed request once after a second:
    // wait until it has given up, so that only the retry button reaches b.test once it is back (on a slow machine a
    // pending retry, or opening the room after b.test is back, would clear the banner before the click).
    await expect.poll(() => Date.now() - lastRequestToB, { timeout: 30_000 }).toBeGreaterThan(2_000);
    await expect(retry).toBeVisible();

    // b.test is back: retrying clears the state.
    await page.unroute(`${BROWSER_API_B}/**`);
    await retry.click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("channel-name")).toBeVisible();
    await expect(page.locator(`[data-testid="node-group"][data-node="${B}"]`)).not.toHaveAttribute("data-unreachable", "true");
  });
});
