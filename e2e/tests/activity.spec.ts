// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, registerViaApi } from "./helpers";
import { scaled } from "./timeouts";

// Rich presence (APPLICATIONS.md §7.2/§7.3): an activity with details, state, end and application shows
// "via <application>" in the member list and the profile card; the privacy settings list the decisions of
// the local activity bridge stored on this device and revoke them.

/** localStorage key of the bridge decisions (web/src/activity/bridge.ts `CONSENT_STORAGE_KEY`). */
const CONSENT_KEY = "tavrn.activity.consent";
const APP_ID = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8";
const APP_REF = `games.example/${APP_ID}`;

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function openMembers(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) !== "true") await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
}

test.describe("Game activity", () => {
  test('Room members see details, state and "via <application>"', async ({ browser, page, request }) => {
    test.setTimeout(scaled(90_000));
    const alice = await registerViaApi(request, "act");
    const bob = await registerViaApi(request, "actb");
    const room = await createRoomViaApi(request, alice.token, "Spieleabend");
    const code = await inviteCode(request, alice.token, room.id);
    await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${bob.token}` }, data: {} });

    // Alice is online (her WebSocket is this device, the one the activity belongs to).
    const alicePage = await newPage(browser);
    await loginAs(alicePage, alice);
    await alicePage.goto(`/rooms/${room.id}`);
    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}`);
    await openMembers(page);
    const entry = page.getByTestId("member-list").getByTestId("profile-trigger").filter({ hasText: alice.username });
    await expect(entry.getByTestId("presence-dot")).toHaveAttribute("data-status", "online");

    const now = Date.now();
    const resp = await request.put(`${NODE}/api/v1/users/me/activity`, {
      headers: { Authorization: `Bearer ${alice.token}` },
      data: {
        type: "playing",
        name: "Space Miners",
        details: "Ranked match",
        state: "In a party (2 of 4)",
        started_at: new Date(now - 10 * 60_000).toISOString(),
        ends_at: new Date(now + 60 * 60_000).toISOString(),
        application: { ref: APP_REF, name: "Space Miners Launcher" },
      },
    });
    expect(resp.ok(), await resp.text()).toBeTruthy();

    const line = entry.getByTestId("member-status-line");
    await expect(line).toContainText("Spielt Space Miners");
    await expect(line.getByTestId("activity-via")).toHaveText("via Space Miners Launcher");
    // The member list stays one line per member.
    const box = await line.boundingBox();
    expect(box!.height).toBeLessThan(24);

    await entry.click();
    const card = page.getByTestId("profile-popover");
    const activity = card.getByTestId("profile-activity");
    await expect(activity.getByTestId("activity-details")).toHaveText("Ranked match");
    await expect(activity.getByTestId("activity-state")).toHaveText("In a party (2 of 4)");
    await expect(activity.getByTestId("activity-ends")).toContainText("bis");
    await expect(activity.getByTestId("activity-via")).toHaveText("via Space Miners Launcher");
    // Nothing the program could control beyond the text: no images or buttons in the block.
    await expect(activity.locator("img, button, a")).toHaveCount(0);
    await alicePage.context().close();
  });

  test("Privacy settings list allowed applications and revoke them", async ({ page, request }) => {
    const user = await registerViaApi(request, "actc");
    await loginAs(page, user);
    await page.addInitScript(
      ({ key, ref }) => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(
          key,
          JSON.stringify({
            [ref]: { ref, name: "Space Miners", bot: "spaceminers@games.example", decision: "always", decided_at: 1 },
            ["games.example/01J9Z8Y7X6W5V4T3S2R1Q0P9N9"]: { ref: "games.example/01J9Z8Y7X6W5V4T3S2R1Q0P9N9", name: "Asteroid Spam", bot: "spam@games.example", decision: "never", decided_at: 2 },
          }),
        );
      },
      { key: CONSENT_KEY, ref: APP_REF },
    );
    await page.goto("/settings/privacy");
    const rows = page.getByTestId("activity-app");
    await expect(rows).toHaveCount(2);
    const miners = rows.filter({ hasText: "Space Miners" });
    await expect(miners).toContainText(APP_REF);
    await expect(miners).toContainText("Immer erlaubt");
    await expect(rows.filter({ hasText: "Asteroid Spam" })).toContainText("Nie erlaubt");

    await miners.getByTestId("activity-app-revoke").click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Asteroid Spam");
    await rows.first().getByTestId("activity-app-revoke").click();
    await expect(page.getByTestId("activity-apps-empty")).toBeVisible();

    // Gone for good, not only from the list.
    await page.reload();
    await expect(page.getByTestId("activity-apps-empty")).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY)).toBeNull();
  });
});
