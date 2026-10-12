// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginViaApi, loginViaUi, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, type UiAccount } from "./helpers";
import { FAKE_MEDIA, closeOpened, opened } from "./voice-helpers";
import { scaled } from "./timeouts";

// Ghost leaves and retired devices (ENCRYPTION.md §4.7, §5.2): a deleted device's leaf is removed by the user's next
// device (also when it joins a voice channel), and the messages the deleted device wrote stay readable.


async function newContextPage(browser: Browser, media = false): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use, ...(media ? { permissions: ["microphone", "camera"] } : {}) });
  opened.push(context);
  return context.newPage();
}

/** A second browser of `account`, unlocked with the recovery key. */
async function secondDevice(browser: Browser, account: UiAccount, media = false): Promise<Page> {
  const page = await newContextPage(browser, media);
  await loginViaUi(page, account);
  await page.getByTestId("recovery-key-input").fill(account.recoveryWords);
  await page.getByRole("button", { name: "Entsperren", exact: true }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  return page;
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 15_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

const message = (page: Page, text: string) => page.getByTestId("message").filter({ hasText: text });
const deviceIdOf = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}").deviceId as string);

async function pending(page: Page, conversationId: string): Promise<string[]> {
  const resp = await page.request.get(`${NODE}/api/v1/conversations/${conversationId}/mls/pending-removals`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return ((await resp.json()).items as { identity: string }[]).map((i) => i.identity);
}

/** Deletes a device of the signed-in user in the settings, confirming with the password (sudo mode). */
async function deleteDeviceInSettings(page: Page, deviceId: string, password: string) {
  await page.goto("/settings/devices");
  const list = page.getByTestId("device-list");
  await expect(list.locator("li").first()).toBeVisible();
  const before = await list.locator("li").count();
  // Rows show names, not ids: look the name up.
  const devices = (await (await page.request.get(`${NODE}/api/v1/users/me/devices`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).json()) as { id: string; name: string }[];
  const target = devices.find((d) => d.id === deviceId)!;
  await page.getByRole("button", { name: `${target.name} entfernen` }).first().click();
  // The page was loaded anew since the login: the confirmation is asked again.
  const reauth = page.getByTestId("reauth-dialog");
  await reauth.getByTestId("reauth-password").fill(password);
  await reauth.getByTestId("reauth-submit").click();
  await expect(list.locator("li")).toHaveCount(before - 1);
}

// Fake microphone and camera for the voice test (a launch option: for the whole file).
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(() => closeOpened());

test.describe("Ghost leaves in the voice channel", () => {
  test("Delete a device in the settings: the voice channel cleans up its leaf on join", async ({ browser, request, browserName }) => {
    test.skip(browserName !== "chromium" || process.env.E2E_VOICE === "false", "voice needs Chromium fake media and livekit-server");
    test.setTimeout(scaled(240_000));
    const owner = await registerViaApi(request, "gowner");
    const room = await createRoomViaApi(request, owner.token, "Geisterkanal");
    const voiceId = room.channels.find((c: { kind: string }) => c.kind === "voice").id as string;
    const code = await inviteCode(request, owner.token, room.id);

    // Device A of alice joins the voice channel: its leaf is in the channel's group.
    const a = await newContextPage(browser, true);
    const alice = await registerViaUi(a, { prefix: "galice" });
    expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(a)}` }, data: {} })).ok()).toBeTruthy();
    const deviceA = await deviceIdOf(a);
    await a.goto(`/rooms/${room.id}/channels/${voiceId}`);
    await a.getByTestId("voice-join").click();
    await expect(a.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
    // Gone for good (the node drops the seat after the reconnect grace).
    await a.context().close();

    // Device B deletes A in the settings: the node records A's leaf as pending removal.
    const b = await secondDevice(browser, alice, true);
    await deleteDeviceInSettings(b, deviceA, alice.password);
    await expect.poll(() => pending(b, voiceId)).toEqual([`${alice.address}/${deviceA}`]);

    // B joins the voice channel: the leaf goes before the voice key (no ghost warning), the roster no longer has it.
    await b.goto(`/rooms/${room.id}/channels/${voiceId}`);
    await b.getByTestId("voice-join").click();
    await expect(b.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
    await expect(b.getByTestId("voice-e2ee")).toBeVisible();
    await expect.poll(() => pending(b, voiceId), { timeout: 20_000 }).toEqual([]);
    await expect(b.getByTestId("ghost-warning")).toHaveCount(0);
  });
});

test.describe("Removed devices", () => {
  test("Messages of a deleted device stay readable, also after a reload", async ({ browser, page }) => {
    test.setTimeout(scaled(180_000));
    const alice = await registerViaUi(page, { prefix: "hist" });
    const deviceA = await deviceIdOf(page);
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Verlauf");
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    const roomUrl = page.url();
    await send(page, "Geschrieben auf Gerät A");
    await expect(message(page, "Geschrieben auf Gerät A")).toBeVisible();

    const b = await secondDevice(browser, alice);
    await b.goto(roomUrl);
    await expect(message(b, "Geschrieben auf Gerät A")).toBeVisible({ timeout: 20_000 });

    await deleteDeviceInSettings(b, deviceA, alice.password);
    const keys = await (await b.request.get(`${NODE}/api/v1/users/${alice.username}/keys`)).json();
    expect(keys.retired.map((r: { device_id: string }) => r.device_id)).toEqual([deviceA]);
    await b.goto(roomUrl);
    await expect(message(b, "Geschrieben auf Gerät A")).toBeVisible({ timeout: 20_000 });
    await expect(b.getByTestId("undecryptable")).toHaveCount(0);
    await expect(message(b, "Geschrieben auf Gerät A").getByTestId("retired-device")).toBeVisible();
    await b.reload();
    await expect(message(b, "Geschrieben auf Gerät A")).toBeVisible({ timeout: 20_000 });
    await expect(b.getByTestId("undecryptable")).toHaveCount(0);
    // The deleted device's leaf left the group with the cleanup of B.
    const channelId = roomUrl.split("/channels/")[1]!;
    await expect.poll(() => pending(b, channelId), { timeout: 20_000 }).toEqual([]);
  });

  test("Device deleted while the other one was offline: it confirms the old device afterwards and keeps reading", async ({ browser, page, request }) => {
    test.setTimeout(scaled(180_000));
    const alice = await registerViaUi(page, { prefix: "late" });
    const deviceA = await deviceIdOf(page);
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Nachtrag");
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    const roomUrl = page.url();
    await send(page, "Vor dem Löschen");
    await expect(message(page, "Vor dem Löschen")).toBeVisible();
    const b = await secondDevice(browser, alice);
    await b.goto(roomUrl);
    await expect(message(b, "Vor dem Löschen")).toBeVisible({ timeout: 20_000 });

    // B goes offline; a third session deletes A (with a fresh confirmation), as an older node did: no retired key.
    await b.context().setOffline(true);
    const third = await loginViaApi(request, { ...alice, token: "", refresh: "", userId: "", isNodeAdmin: false, deviceId: "" }, "Drittgerät");
    const confirm = await request.post(`${NODE}/api/v1/auth/reauth`, { headers: { Authorization: `Bearer ${third.token}` }, data: { password: alice.password } });
    expect(confirm.ok(), await confirm.text()).toBeTruthy();
    const del = await request.delete(`${NODE}/api/v1/users/me/devices/${deviceA}`, { headers: { Authorization: `Bearer ${third.token}`, "Tavrn-Reauth": (await confirm.json()).reauth_token } });
    expect(del.status()).toBe(204);
    // Development hook: forget the retired key, as nodes from before retired devices never kept one.
    expect((await request.post(`${NODE}/api/v1/dev/forget-retired-device`, { data: { device_id: deviceA } })).status()).toBe(204);
    expect((await (await request.get(`${NODE}/api/v1/users/${alice.username}/keys`)).json()).retired).toEqual([]);

    // B comes back: it attests A again from A's leaf key before removing the leaf, and still reads A's message.
    await b.context().setOffline(false);
    await b.reload();
    await expect(message(b, "Vor dem Löschen")).toBeVisible({ timeout: 30_000 });
    await expect(b.getByTestId("undecryptable")).toHaveCount(0);
    await expect.poll(async () => (await (await request.get(`${NODE}/api/v1/users/${alice.username}/keys`)).json()).retired.map((r: { device_id: string }) => r.device_id), { timeout: 20_000 }).toEqual([deviceA]);
    const channelId = roomUrl.split("/channels/")[1]!;
    await expect.poll(() => pending(b, channelId), { timeout: 20_000 }).toEqual([]);
  });
});
