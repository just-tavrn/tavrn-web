// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, uniqueName, type Account } from "./helpers";
import { createRole, joinRoom, openMembers } from "./menu-helpers";
import { B, FEDERATION_BROWSER, NODE_A, NODE_B, WEB_B, chromiumOnly, loginOn } from "./federation-helpers";

// Adding applications to rooms, phase 5 step 2 (tavrn-protocol/APPLICATIONS.md §4): the add link and its consent screen,
// installing, the room's application list with uninstall, the managed role and the BOT badge everywhere.

test.use(FEDERATION_BROWSER);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const bit = (n: number) => 1n << BigInt(n);
const SEND_MESSAGES = bit(1);
const ADD_REACTIONS = bit(4);
const MANAGE_ROLES = bit(8);
const MANAGE_APPLICATIONS = bit(35);
const MANAGE_ROOM = bit(9);
const KICK_MEMBERS = bit(11);

interface App {
  id: string;
  botAddress: string;
  botUsername: string;
  secret: string;
}

/** An application of `owner` with one token (all scopes). */
async function createApp(request: APIRequestContext, owner: Account, data: Record<string, unknown>, base = NODE): Promise<App> {
  const created = await request.post(`${base}/api/v1/applications`, { headers: auth(owner.token), data });
  expect(created.status(), await created.text()).toBe(201);
  const app = await created.json();
  const token = await request.post(`${base}/api/v1/applications/${app.id}/tokens`, { headers: auth(owner.token), data: { name: "main" } });
  expect(token.status(), await token.text()).toBe(201);
  return { id: app.id, botAddress: app.bot.address, botUsername: app.bot.username, secret: (await token.json()).secret };
}

test.describe("Adding applications (APPLICATIONS.md §4, phase 5 step 2)", () => {
  chromiumOnly();

  test("consent screen, install, BOT badges and managed role, uninstall from the room settings", async ({ page, request }) => {
    const owner = await registerViaApi(request, "appown");
    const roomOwner = await registerViaApi(request, "rown");
    const manager = await registerViaApi(request, "mgr");
    const name = uniqueName("Helfer");
    const app = await createApp(request, owner, { name, public: true, description: "Hilft beim Aufräumen", requested_permissions: (SEND_MESSAGES | ADD_REACTIONS | KICK_MEMBERS).toString() });
    const room = await createRoomViaApi(request, roomOwner.token, "Bot-Raum");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await joinRoom(request, roomOwner, room.id, manager);
    // Installing needs "Manage applications" (bit 35, design note 4.7); a room that only grants "Manage room" is not offered.
    const role = await createRole(request, roomOwner, room.id, { name: "Mods", position: 5, permissions: (MANAGE_APPLICATIONS | MANAGE_ROLES | SEND_MESSAGES | ADD_REACTIONS).toString() });
    const roomOnly = await createRoomViaApi(request, roomOwner.token, "Nur-Raum-Verwaltung");
    await joinRoom(request, roomOwner, roomOnly.id, manager);
    const roomRole = await createRole(request, roomOwner, roomOnly.id, { name: "Raumpflege", position: 5, permissions: (MANAGE_ROOM | MANAGE_ROLES).toString() });
    expect((await request.patch(`${NODE}/api/v1/rooms/${roomOnly.id}/members/${manager.userId}`, { headers: auth(roomOwner.token), data: { roles: [roomRole.id] } })).ok()).toBeTruthy();
    const assigned = await request.patch(`${NODE}/api/v1/rooms/${room.id}/members/${manager.userId}`, { headers: auth(roomOwner.token), data: { roles: [role.id] } });
    expect(assigned.ok(), await assigned.text()).toBeTruthy();
    // A room of the manager without bots: listed, but not selectable.
    const quiet = await createRoomViaApi(request, manager.token, "Ruhe-Raum");
    expect((await request.patch(`${NODE}/api/v1/rooms/${quiet.id}`, { headers: auth(manager.token), data: { no_bots: true } })).ok()).toBeTruthy();

    await loginAs(page, manager);
    await page.goto(`/add/${app.id}`);
    const consent = page.getByTestId("add-app-consent");
    await expect(consent.getByTestId("add-app-name")).toHaveText(name);
    await expect(consent.getByTestId("bot-badge")).toBeVisible();
    await expect(consent.getByTestId("add-app-bot")).toHaveText(app.botAddress);
    await expect(consent.getByTestId("add-app-owner")).toHaveText(`${owner.username}@localhost`);
    await expect(consent.getByTestId("add-app-description")).toHaveText("Hilft beim Aufräumen");
    await expect(consent.getByTestId("add-app-remote")).toHaveCount(0);
    // The room picker: the managed room is chosen, the "no bots" room is disabled with the reason.
    const target = consent.locator(`[data-testid="add-app-room"][data-room="${room.id}"]`);
    await expect(target.getByRole("radio")).toBeChecked();
    await expect(consent.locator(`[data-testid="add-app-room"][data-room="${roomOnly.id}"]`)).toHaveCount(0);
    const blocked = consent.locator(`[data-testid="add-app-room"][data-room="${quiet.id}"]`);
    await expect(blocked.getByRole("radio")).toBeDisabled();
    await expect(blocked.getByTestId("add-app-room-no-bots")).toBeVisible();
    // Requested permissions: the ones the manager holds are checkboxes, the others disabled.
    const perm = (name: string) => consent.locator(`[data-testid="add-app-permission"][data-permission="${name}"]`).getByRole("checkbox");
    await expect(perm("send_messages")).toBeChecked();
    await expect(perm("send_messages")).toBeEnabled();
    await expect(perm("kick_members")).toBeDisabled();
    await perm("add_reactions").uncheck();
    await expect(consent.getByTestId("add-app-scopes")).toContainText("messages:write");
    await expect(consent.getByTestId("add-app-e2ee")).toBeVisible();
    await consent.getByTestId("add-app-install").click();

    // The room's application list (settings) shows it; only the cleared and the missing permission are not granted.
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/settings/applications`));
    const row = page.locator(`[data-testid="room-application-row"][data-ref="localhost/${app.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("bot-badge")).toBeVisible();
    const list = await (await request.get(`${NODE}/api/v1/rooms/${room.id}/applications`, { headers: auth(roomOwner.token) })).json();
    expect(list[0].permissions).toBe(SEND_MESSAGES.toString());
    // The managed role is marked in the role editor.
    await page.goto(`/rooms/${room.id}/settings/roles`);
    const managed = page.locator(`[data-testid="role-row"][data-role="${name}"]`);
    await expect(managed.getByTestId("role-managed-icon")).toBeVisible();
    await managed.getByRole("button").filter({ hasText: name }).click();
    await expect(page.getByTestId("role-managed-by")).toContainText(name);

    // BOT badge on its message header, on a mention of it and in the member list.
    const sent = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: auth(app.secret), data: { content: { type: "text", body: "Aufgeräumt!" } } });
    expect(sent.status(), await sent.text()).toBe(201);
    const mention = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, {
      headers: auth(manager.token),
      data: { content: { type: "text", body: `Danke @${app.botUsername}!` }, mentions: [app.botAddress] },
    });
    expect(mention.status(), await mention.text()).toBe(201);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("message").filter({ hasText: "Aufgeräumt!" }).getByTestId("bot-badge")).toBeVisible();
    const mentioned = page.getByTestId("message").filter({ hasText: "Danke" });
    await expect(mentioned.getByTestId("mention")).toHaveText(`@${app.botUsername}`);
    await expect(mentioned.getByTestId("bot-badge")).toBeVisible();
    await openMembers(page);
    await expect(page.locator(`[data-testid="member-row"][data-address="${app.botAddress}"]`).getByTestId("bot-badge")).toBeVisible();

    // Uninstall from the room settings: the bot leaves and its role is gone.
    await page.goto(`/rooms/${room.id}/settings/applications`);
    await row.getByTestId("room-application-remove").click();
    await page.getByRole("dialog").getByRole("button").last().click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("room-applications")).toContainText("Keine Anwendungen installiert.");
    expect(await (await request.get(`${NODE}/api/v1/rooms/${room.id}/applications`, { headers: auth(roomOwner.token) })).json()).toEqual([]);
    const roles = (await (await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: auth(roomOwner.token) })).json()).roles as { name: string }[];
    expect(roles.map((r) => r.name)).not.toContain(name);
  });

  test("an add link pasted into the + dialog or the room settings opens the consent screen", async ({ page, request, baseURL }) => {
    const owner = await registerViaApi(request, "pasted");
    const app = await createApp(request, owner, { name: uniqueName("Kopie") });
    const room = await createRoomViaApi(request, owner.token, "Einfüge-Raum");
    await loginAs(page, owner);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("tab-add-app").click();
    await dialog.getByTestId("add-app-link").fill("kein Link");
    await dialog.getByTestId("add-app-open").click();
    await expect(dialog.getByRole("alert")).toHaveText("Das ist kein Hinzufügen-Link einer Anwendung.");
    await dialog.getByTestId("add-app-link").fill(`${baseURL}/add/${app.id}`);
    await dialog.getByTestId("add-app-open").click();
    await expect(page).toHaveURL(new RegExp(`/add/${app.id}$`));
    await expect(page.getByTestId("add-app-visibility")).toHaveText("Privat: nur der Eigentümer kann sie hinzufügen");

    // From the room settings the room is preselected; the reference form works as well.
    await page.goto(`/rooms/${room.id}/settings/applications`);
    await page.getByTestId("add-app-link").fill(`localhost/${app.id}`);
    await page.getByTestId("add-app-open").click();
    await expect(page.locator(`[data-testid="add-app-room"][data-room="${room.id}"]`).getByRole("radio")).toBeChecked();
    await page.getByTestId("add-app-install").click();
    await expect(page.locator(`[data-testid="room-application-row"][data-ref="localhost/${app.id}"]`)).toBeVisible();
  });

  test("a direct message of a bot carries the BOT badge", async ({ page, request }) => {
    const owner = await registerViaApi(request, "dmown");
    const app = await createApp(request, owner, { name: uniqueName("Post") });
    // The owner always gets a normal conversation with the bot (APPLICATIONS.md §2.5).
    const dm = await request.post(`${NODE}/api/v1/conversations`, { headers: auth(app.secret), data: { kind: "dm", members: [owner.username] } });
    expect(dm.status(), await dm.text()).toBeLessThan(300);
    const conversation = await dm.json();
    await loginAs(page, owner);
    await page.goto(`/conversations/${conversation.id}`);
    await expect(page.getByTestId("conversation-name")).toBeVisible();
    await expect(page.locator("header").getByTestId("bot-badge").first()).toBeVisible();
    await page.goto("/");
    await openNavIfMobile(page);
    await expect(page.locator(`[data-testid="dm-row"][data-conversation="${conversation.id}"]`).getByTestId("bot-badge")).toBeVisible();
  });

  test("a bot of another node: its home node is shown and the room node installs it", async ({ page, request }) => {
    const alice = await registerViaApi(request, "ra", NODE_A);
    const bob = await registerViaApi(request, "rb", NODE_B);
    const app = await createApp(request, alice, { name: uniqueName("Fern"), public: true, requested_permissions: SEND_MESSAGES.toString() }, NODE_A);
    const room = await createRoomViaApi(request, bob.token, "Fern-Raum", "invite", { base: NODE_B });
    await loginOn(page, WEB_B, bob, { domain: B, remote: false });
    await page.goto(`${WEB_B}/add/a.test/${app.id}`);
    const consent = page.getByTestId("add-app-consent");
    await expect(consent.getByTestId("add-app-bot")).toHaveText(app.botAddress);
    await expect(consent.getByTestId("add-app-bot")).toHaveAttribute("data-foreign", "true");
    await expect(consent.getByTestId("add-app-owner")).toHaveAttribute("data-foreign", "true");
    await expect(consent.getByTestId("add-app-remote")).toContainText("a.test");
    await expect(consent.locator(`[data-testid="add-app-room"][data-room="${room.id}"]`).getByRole("radio")).toBeChecked();
    await consent.getByTestId("add-app-install").click();
    await expect(page.locator(`[data-testid="room-application-row"][data-ref="a.test/${app.id}"]`)).toBeVisible();
    const installed = await (await request.get(`${NODE_B}/api/v1/rooms/${room.id}/applications`, { headers: auth(bob.token) })).json();
    expect(installed[0].bot.address).toBe(app.botAddress);
    expect(installed[0].bot.kind).toBe("bot");
  });
});
