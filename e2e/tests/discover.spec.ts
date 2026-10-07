// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createRoomViaApi, openNavIfMobile, registerViaApi, uniqueName } from "./helpers";
import { A, B, FEDERATION_BROWSER, NODE_A, NODE_B, WEB_A, WEB_B, chromiumOnly, indexOf, loginOn } from "./federation-helpers";

test.use(FEDERATION_BROWSER);

// A one-second animated GIF (the same fixture as profile.spec.ts).
const ANIMATED = resolve(dirname(new URL(import.meta.url).pathname), "../fixtures/animated.gif");

// Peer directory and Discover (FEDERATION.md §7): the owner of a room on b.test lists it in the
// directory, b.test announces itself to its reference node a.test, and a user of a.test finds the room
// on the Discover page of a.test and joins it on b.test through a federated session.
test.describe("Discovery across nodes", () => {
  chromiumOnly();

  test("List a room on B, discover and join it on A", async ({ page, request }) => {
    test.setTimeout(120_000);
    const bob = await registerViaApi(request, "dbob", NODE_B);
    const alice = await registerViaApi(request, "dalice", NODE_A);
    const roomName = uniqueName("Brettspiele ");
    const room = await createRoomViaApi(request, bob.token, roomName, "public", { base: NODE_B, discoverable: false });
    // Alice's own listed room on a.test has an (animated) icon; b.test's room has one too.
    const localName = uniqueName("Brettspiele daheim ");
    const local = await createRoomViaApi(request, alice.token, localName, "public", { base: NODE_A });
    for (const [base, token, id] of [[NODE_A, alice.token, local.id], [NODE_B, bob.token, room.id]] as const) {
      const icon = await request.put(`${base}/api/v1/rooms/${id}/icon`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/gif" }, data: readFileSync(ANIMATED), timeout: 60_000 });
      expect(icon.ok(), await icon.text()).toBeTruthy();
    }

    // B's owner turns the listing on in the room settings (B's web client).
    await loginOn(page, WEB_B, bob, { domain: B, remote: false });
    await page.goto(`${WEB_B}/rooms/${room.id}/settings/overview`);
    const toggle = page.getByTestId("room-discoverable");
    await expect(toggle).toBeEnabled({ timeout: 20_000 });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.getByTestId("overview-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    const detail = await request.get(`${NODE_B}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
    expect((await detail.json()).discoverable).toBe(true);

    // a.test learns the room from b.test's announce (verified against b.test's own documents).
    await expect
      .poll(async () => (await (await request.get(`${NODE_A}/api/v1/directory/rooms?q=${encodeURIComponent(roomName)}`)).json()).items.map((r: { room_id: string }) => r.room_id), { timeout: 20_000 })
      .toContain(room.id);

    // A user of a.test opens Discover on a.test's web client.
    await loginOn(page, WEB_A, alice, { domain: A, remote: false });
    await page.goto(`${WEB_A}/`);
    await openNavIfMobile(page);
    await page.getByTestId("nav-discover").click();
    await expect(page).toHaveURL(/\/discover$/);
    await expect(page.getByRole("heading", { name: "Entdecken", level: 1 })).toBeVisible();

    // Nodes tab: b.test with registration mode and software version.
    await page.getByRole("tab", { name: "Knoten" }).click();
    const nodeCard = page.locator(`[data-testid="discover-node-card"][data-node="${B}"]`);
    await expect(nodeCard).toBeVisible({ timeout: 20_000 });
    await expect(nodeCard.getByTestId("discover-node-registration")).toHaveText("Registrierung: offen");
    await expect(nodeCard.getByTestId("discover-node-software")).toContainText("tavrn-node");

    // Rooms tab: the card names the hosting node; the listing was verified in the browser.
    await page.getByRole("tab", { name: "Räume" }).click();
    await page.getByTestId("discover-search").fill(roomName);
    const card = page.locator(`[data-testid="discover-room"][data-room="${room.id}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("discover-room-name")).toHaveText(roomName);
    await expect(card.getByTestId("discover-room-node")).toHaveText(B);
    await expect(card).toContainText("1 Mitglieder");
    await expect(page.getByTestId("discover-hidden")).toHaveCount(0);
    // No icon from b.test: this client has no session there yet and never loads images of other nodes
    // (FEDERATION.md §7.4), so the card shows the initials.
    await expect(card.getByTestId("room-icon")).toBeVisible();
    await expect(card.getByTestId("room-icon").getByTestId("avatar-image")).toHaveCount(0);

    // A room of a.test itself: its icon as a still, animated while hovered; the domain stays visible.
    await page.getByTestId("discover-search").fill(localName);
    const localCard = page.locator(`[data-testid="discover-room"][data-room="${local.id}"]`);
    await expect(localCard.getByTestId("discover-room-node")).toContainText(A, { timeout: 20_000 });
    const icon = localCard.getByTestId("room-icon");
    await expect(icon.getByTestId("avatar-image")).toHaveAttribute("src", /\/api\/v1\/media\/[0-9A-Z]{26}$/);
    await expect(icon).toHaveAttribute("data-has-animation", "true");
    await expect(icon).toHaveAttribute("data-animated", "false");
    if (!test.info().project.use.hasTouch) {
      await icon.hover();
      await expect(icon).toHaveAttribute("data-animated", "true");
      await page.mouse.move(0, 0);
      await expect(icon).toHaveAttribute("data-animated", "false");
    }
    await page.getByTestId("discover-search").fill(roomName);
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Joining opens a federated session on b.test and lands in the room under its domain.
    await card.getByRole("button", { name: /Beitreten/ }).click();
    await expect(page).toHaveURL(new RegExp(`/n/${B}/rooms/${room.id}/channels/`), { timeout: 20_000 });
    await expect(page.getByTestId("channel-name")).toBeVisible({ timeout: 20_000 });
    await openNavIfMobile(page);
    await expect(page.getByTestId("room-name")).toHaveText(roomName);
    await expect(page.getByTestId("room-node")).toHaveText(B);
    await expect.poll(async () => (await indexOf(request, NODE_A, alice.token)).items.map((e) => `${e.node}/${e.room_id}`), { timeout: 20_000 }).toContain(`${B}/${room.id}`);
    const members = await request.get(`${NODE_B}/api/v1/directory/rooms?local=true&q=${encodeURIComponent(roomName)}`);
    expect((await members.json()).items[0].member_count).toBe(2);
  });
});
