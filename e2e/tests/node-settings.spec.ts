// SPDX-License-Identifier: Apache-2.0
/**
 * Settings that drive node features (tavrn-protocol PROTOCOL.md §6, §6c, §6d, §7f): a room's message retention, the
 * language of the node's mails (the client sends its own), and the report push switch with the hint about rooms on
 * other nodes.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi, type Account } from "./helpers";

const get = async (request: APIRequestContext, account: Account, path: string) =>
  (await request.get(`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${account.token}` } })).json();

test.describe("node feature settings", () => {
  test("room setting: delete messages after N days", async ({ page, request }) => {
    const owner = await registerViaApi(request, "msgret");
    const room = await createRoomViaApi(request, owner.token, "Fristen");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/overview`);
    await expect(page.getByRole("heading", { name: "Aufbewahrung von Nachrichten" })).toBeVisible();
    await expect(page.getByText(/Dieser Knoten behält Nachrichten/)).toBeVisible();
    await expect(page.getByTestId("message-retention-effective")).toHaveText("Nachrichten werden behalten.");
    await page.getByTestId("message-retention-days").fill("7");
    await page.getByTestId("message-retention-save").click();
    await expect(page.getByTestId("message-retention-effective")).toHaveText("Nachrichten werden nach 7 Tagen gelöscht (mit ihren Anhängen).");
    expect((await get(request, owner, `/rooms/${room.id}`)).message_retention_days).toBe(7);
  });

  test("the node's mails follow the client's language", async ({ page, request }) => {
    const user = await registerViaApi(request, "mails");
    await loginAs(page, user);
    await page.goto("/settings/language");
    // The browser runs in German: the client tells the node at start.
    await expect.poll(async () => (await get(request, user, "/users/me")).locale).toBe("de");
    await page.getByTestId("locale-switch").selectOption("en");
    await expect(page.getByText(/and to the e-mails of your home node/)).toBeVisible();
    await expect.poll(async () => (await get(request, user, "/users/me")).locale).toBe("en");
  });

  test("notification settings: report pushes can be turned off; rooms on other nodes are explained", async ({ page, request }) => {
    const user = await registerViaApi(request, "reportpush");
    await loginAs(page, user);
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("push-remote-hint")).toContainText("In Räumen auf anderen Knoten");
    const reports = page.getByTestId("push-reports");
    await expect(reports).toBeChecked();
    await reports.uncheck();
    await expect.poll(async () => (await get(request, user, "/users/me/notification-settings")).global.reports).toBe(false);
    await page.reload();
    await expect(page.getByTestId("push-reports")).not.toBeChecked();
  });
});
