// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { NODE, adminAccount, createRoomViaApi, loginAs, registerViaApi, uniqueName } from "./helpers";

// Node admin controls for applications (tavrn-protocol/APPLICATIONS.md §4.4), the approval of their commands (§5.2) and the
// SSO group map (§8.5).

const DATA = resolve(dirname(new URL(import.meta.url).pathname), "../../data-dev");
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Serializes work on the node-wide group map across parallel workers (same lock as sso.spec.ts). */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lock = resolve(DATA, `e2e/${name}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* vanished meanwhile */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

test.describe("Node admin: applications and SSO", () => {
  test("disable and enable an application, block its bot (uninstalled, token refused), unblock, delete", async ({ page, request }) => {
    const admin = await adminAccount(request);
    const owner = await registerViaApi(request, "appown");
    const created = await request.post(`${NODE}/api/v1/applications`, { headers: auth(owner.token), data: { name: uniqueName("Wache"), public: true } });
    expect(created.status(), await created.text()).toBe(201);
    const app = await created.json();
    const botAddress: string = app.bot.address;
    const token = await request.post(`${NODE}/api/v1/applications/${app.id}/tokens`, { headers: auth(owner.token), data: { name: "prod" } });
    expect(token.ok(), await token.text()).toBeTruthy();
    const secret: string = (await token.json()).secret;
    const room = await createRoomViaApi(request, owner.token, "App-Raum");
    const install = await request.post(`${NODE}/api/v1/rooms/${room.id}/applications`, { headers: auth(owner.token), data: { application: `localhost/${app.id}` } });
    expect(install.status(), await install.text()).toBe(201);
    const installed = async () => (await (await request.get(`${NODE}/api/v1/rooms/${room.id}/applications`, { headers: auth(owner.token) })).json()) as unknown[];
    expect(await installed()).toHaveLength(1);
    const botMe = () => request.get(`${NODE}/api/v1/users/me`, { headers: auth(secret) });
    expect((await botMe()).status()).toBe(200);

    await loginAs(page, admin);
    await page.goto("/admin/overview");
    await page.getByTestId("admin-tab-applications").click();
    await expect(page).toHaveURL(/\/admin\/applications$/);
    const row = page.locator(`[data-testid="admin-app-row"][data-id="${app.id}"]`);
    await expect(row).toContainText(botAddress);
    await expect(row).toContainText(`${owner.username}@localhost`);
    await expect(row.getByTestId("bot-badge")).toBeVisible();
    await expect(row.getByTestId("admin-app-stats")).toContainText("1 Tokens · 1 Installationen");

    // Disable: the token is refused at once; enable again.
    await row.getByTestId("admin-app-toggle").click();
    await expect(row).toHaveAttribute("data-disabled", "true");
    await expect(row.getByTestId("admin-app-disabled")).toContainText("durch einen Admin");
    await expect(row.getByTestId("admin-app-toggle")).toHaveText("Aktivieren");
    const refused = await botMe();
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("app.disabled");
    await row.getByTestId("admin-app-toggle").click();
    await expect(row).toHaveAttribute("data-disabled", "false");
    expect((await botMe()).status()).toBe(200);

    // Blocking an address that is not a bot fails with a message.
    const form = page.getByTestId("admin-app-block-form");
    await form.getByTestId("admin-app-block-bot").fill(`${owner.username}@localhost`);
    await form.getByTestId("admin-app-block-submit").click();
    await expect(page.getByTestId("admin-app-block-error")).toBeVisible();

    // Block the bot: uninstalled from the room, its token refused, listed in the blocklist.
    await form.getByTestId("admin-app-block-bot").fill(botAddress);
    await form.getByTestId("admin-app-block-reason").fill("E2E-Sperre");
    await form.getByTestId("admin-app-block-submit").click();
    const entry = page.locator(`[data-testid="admin-app-block"][data-bot="${botAddress}"]`);
    await expect(entry).toContainText("E2E-Sperre");
    await expect(page.getByTestId("admin-app-block-error")).toHaveCount(0);
    await expect(row.getByTestId("admin-app-disabled")).toContainText("Bot blockiert");
    expect(await installed()).toEqual([]);
    const blocked = await botMe();
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).code).toBe("app.disabled");

    // Unblock: the entry disappears and the bot may act again (no automatic reinstallation).
    await entry.getByTestId("admin-app-unblock").click();
    await expect(entry).toHaveCount(0);
    await expect(row).toHaveAttribute("data-disabled", "false");
    expect((await botMe()).status()).toBe(200);
    expect(await installed()).toEqual([]);

    // Delete after typing the bot's username.
    await row.getByTestId("admin-app-delete").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bestätigung").fill(app.bot.username);
    await dialog.getByRole("button", { name: "Löschen" }).click();
    await expect(row).toHaveCount(0);
    expect((await botMe()).status()).toBe(401);
  });

  test("command approval: pending definitions per application, approve, reject (APPLICATIONS.md §5.2)", async ({ page, request }) => {
    const admin = await adminAccount(request);
    const owner = await registerViaApi(request, "cmdapp");
    const created = await request.post(`${NODE}/api/v1/applications`, { headers: auth(owner.token), data: { name: uniqueName("Freigabe"), public: true } });
    expect(created.status(), await created.text()).toBe(201);
    const app = await created.json();
    const commands = { commands: [{ name: "ping", description: "Pong" }, { name: "roll", description: "Roll a die", args: [{ name: "sides", description: "Sides", type: "integer" }] }] };
    const put = await request.put(`${NODE}/api/v1/applications/${app.id}/commands`, { headers: auth(owner.token), data: commands });
    expect(put.status(), await put.text()).toBe(200);
    const required = (await (await request.get(`${NODE}/api/v1/admin/applications/commands/approval`, { headers: auth(admin.token) })).json()).required as boolean;

    await loginAs(page, admin);
    await page.goto("/admin/applications");
    const filter = page.getByTestId("command-approval-filter");
    await expect(filter).toHaveAttribute("data-required", String(required));
    await expect(page.getByText(required ? /TAVRN_APP_COMMANDS_REQUIRE_APPROVAL=true/ : /TAVRN_APP_COMMANDS_REQUIRE_APPROVAL=false/)).toBeVisible();
    const group = page.locator(`[data-testid="command-approval-app"][data-application="localhost/${app.id}"]`);
    await expect(group).toContainText(app.name);
    await expect(group.getByTestId("command-approval-row")).toHaveCount(2);
    await expect(group.locator('[data-command="roll"]')).toContainText("1 Argument(e)");

    // Approve one: it leaves the pending list and shows up as approved.
    await group.locator('[data-command="ping"]').getByTestId("command-approval-approve").click();
    await expect(group.getByTestId("command-approval-row")).toHaveCount(1);
    await page.getByTestId("command-approval-state-approved").click();
    const approved = page.locator(`[data-testid="command-approval-app"][data-application="localhost/${app.id}"]`);
    await expect(approved.locator('[data-command="ping"]')).toHaveAttribute("data-state", "approved");
    await expect(approved.locator('[data-command="ping"]').getByTestId("command-approval-approve")).toHaveCount(0);
    // Reject it again: listed under "rejected".
    await approved.locator('[data-command="ping"]').getByTestId("command-approval-reject").click();
    await expect(approved).toHaveCount(0);
    await page.getByTestId("command-approval-state-rejected").click();
    await expect(page.locator(`[data-testid="command-approval-app"][data-application="localhost/${app.id}"] [data-command="ping"]`)).toHaveAttribute("data-state", "rejected");
    const states = await (await request.get(`${NODE}/api/v1/admin/applications/commands`, { headers: auth(admin.token) })).json();
    const mine = (states as Array<{ application: string; command: { name: string }; state: string }>).filter((c) => c.application === `localhost/${app.id}`);
    expect(Object.fromEntries(mine.map((c) => [c.command.name, c.state]))).toEqual({ ping: "rejected", roll: "pending" });
  });

  test("SSO group map: add a mapping, see it after a reload, remove it", async ({ page, request }) => {
    const admin = await adminAccount(request);
    const room = await createRoomViaApi(request, admin.token, "SSO-Karte");
    const group = uniqueName("e2egrp");
    const getMap = async () => (await (await request.get(`${NODE}/api/v1/admin/sso/group-map`, { headers: auth(admin.token) })).json()) as { map: Record<string, unknown>; fixed: boolean };

    await loginAs(page, admin);
    await page.goto("/admin/overview");
    await page.getByTestId("admin-tab-sso").click();
    await expect(page).toHaveURL(/\/admin\/sso$/);
    await expect(page.getByTestId("admin-sso-sync")).toBeVisible();
    await expect(page.getByTestId("admin-sso-fixed")).toHaveCount(0);

    await withLock("sso-map", async () => {
      // The other projects change the map too: start from the current one.
      await page.reload();
      await page.getByTestId("admin-sso-group").fill(group);
      await page.getByTestId("admin-sso-room-creation").fill("3");
      // Rooms are picked by name (the search feeds the select), not by id.
      await page.getByTestId("admin-sso-room-search").fill("SSO-Karte");
      await page.getByTestId("admin-sso-room-add").selectOption(room.id);
      await expect(page.locator(`[data-testid="admin-sso-room-grant"][data-room="${room.id}"]`)).toContainText("SSO-Karte");
      await page.getByTestId("admin-sso-add").click();
      const mapping = page.locator(`[data-testid="admin-sso-mapping"][data-group="${group}"]`);
      await expect(mapping).toContainText("Raum-Erstellungen: 3");
      await expect(mapping.getByTestId("admin-sso-mapping-room")).toContainText("SSO-Karte");
      expect((await getMap()).map[group]).toEqual({ room_creation: 3, rooms: [{ room: room.id, roles: [] }] });

      await page.reload();
      await expect(mapping).toContainText("Raum-Erstellungen: 3");

      await mapping.getByTestId("admin-sso-remove").click();
      await expect(mapping).toHaveCount(0);
      expect((await getMap()).map[group]).toBeUndefined();
    });
  });
});
