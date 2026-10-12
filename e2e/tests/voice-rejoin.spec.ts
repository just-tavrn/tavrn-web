// SPDX-License-Identifier: Apache-2.0
// Rejoining an end-to-end encrypted voice channel after the session ended while connected (tavrn-web#83): the
// device that comes back after a recovery-key unlock joins by external commit signed with the device key the node
// attests for its session, and its old leaf goes in the same commit (tavrn-protocol/ENCRYPTION.md §4.2, §4.5).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginViaUi, openNavIfMobile, registerViaApi, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, hooks, opened, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

const consoleLines: string[] = [];
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && consoleLines.length) await info.attach("browser-console", { body: consoleLines.join("\n"), contentType: "text/plain" });
  consoleLines.length = 0;
  await closeOpened();
});

async function setup(request: APIRequestContext) {
  const owner = await registerViaApi(request, "rjowner");
  const room = await createRoomViaApi(request, owner.token, "Stammtisch");
  const voice = room.channels.find((c: { kind: string }) => c.kind === "voice") as { id: string };
  return { roomId: room.id as string, voiceId: voice.id, code: await inviteCode(request, owner.token, room.id) };
}

async function joinRoom(request: APIRequestContext, page: Page, code: string) {
  const resp = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data: {} });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

async function joinVoice(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: scaled(30_000) });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible();
}

const row = (page: Page, address: string) => page.getByTestId("voice-participant").and(page.locator(`[data-user="${address}"]`));

/** Records console warnings and errors of a page (attached when a test fails). */
function watch(page: Page, prefix: string) {
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && consoleLines.push(`[${prefix}] ${m.type()}: ${m.text()}`));
}

/** Both hear each other's encrypted audio on the same epoch. */
async function bothEncrypted(a: Page, b: Page) {
  for (const p of [a, b]) await expect.poll(async () => (await hooks(p)).e2eeEnabled, { timeout: scaled(20_000) }).toBe(true);
  await expect.poll(async () => (await hooks(a)).remote.some((r) => r.tracks.length > 0 && r.tracks.every((t) => t.encrypted && t.subscribed)), { timeout: scaled(20_000) }).toBe(true);
  await expect.poll(async () => (await hooks(b)).remote.some((r) => r.tracks.length > 0 && r.tracks.every((t) => t.encrypted && t.subscribed)), { timeout: scaled(20_000) }).toBe(true);
}

test.describe("Voice rejoin after the session ended while connected", () => {
  test("a new sign-in unlocked with the recovery key joins the same encrypted voice channel", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const { roomId, code } = await setup(request);
    const alice = await voiceUser(browser, "rjalice", consoleLines);
    const bob = await voiceUser(browser, "rjbob", consoleLines);
    await joinRoom(request, alice.page, code);
    await joinRoom(request, bob.page, code);
    await joinVoice(alice.page, roomId);
    await joinVoice(bob.page, roomId);
    await expect(row(bob.page, alice.address)).toHaveCount(1, { timeout: scaled(20_000) });

    // Alice's browser goes away while she is connected (no leave).
    const old = opened.shift()!;
    await old.close();

    // A fresh browser: sign in, unlock with the recovery key, join the same channel.
    const context = await browser.newContext({ ...test.info().project.use, permissions: ["microphone", "camera"] });
    opened.push(context);
    const page = await context.newPage();
    watch(page, "alice-2");
    await loginViaUi(page, alice.account);
    await page.getByTestId("recovery-key-input").fill(alice.account.recoveryWords);
    await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await joinVoice(page, roomId);
    await bothEncrypted(page, bob.page);
    await expect(page.getByTestId("voice-error")).toHaveCount(0);
  });

  test("the same session after its local keys were lost: told to sign in again, it joins as a new device", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const { roomId, code } = await setup(request);
    const alice = await voiceUser(browser, "rjalice", consoleLines);
    const bob = await voiceUser(browser, "rjbob", consoleLines);
    await joinRoom(request, alice.page, code);
    await joinRoom(request, bob.page, code);
    await joinVoice(alice.page, roomId);
    await joinVoice(bob.page, roomId);
    await expect(row(bob.page, alice.address)).toHaveCount(1, { timeout: scaled(20_000) });

    // The app dies while connected and its local key store does not survive (an app process killed before its
    // storage reached the disk), while the session does: the deletion completes once the page is gone.
    const context = alice.page.context();
    await alice.page.evaluate(() => void indexedDB.deleteDatabase("tavrn-crypto"));
    await alice.page.close();
    const page = await context.newPage();
    watch(page, "alice-2");
    await page.goto("/");
    // Issue #83 showed "Encrypted messages are not readable on this device yet" here, and the recovery key made the
    // client create a second key for the same device: every voice join failed with "The commit is not from this
    // device". The device's key is gone for good (a device key is immutable), so the client says so and signs in again.
    const banner = page.getByTestId("e2ee-banner");
    await expect(banner).toHaveAttribute("data-device-lost", "true");
    await expect(banner).toContainText("Verschlüsselungsschlüssel verloren");
    await page.goto(`/rooms/${roomId}`);
    await openNavIfMobile(page);
    await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
    await expect(page.getByTestId("voice-error")).toBeVisible({ timeout: scaled(20_000) });
    await expect(page.getByTestId("voice-error")).not.toContainText("not from this device");
    await page.goto("/encryption");
    await expect(page.getByTestId("device-lost")).toBeVisible();
    await expect(page.getByTestId("recovery-key-input")).toHaveCount(0);
    await page.getByTestId("device-lost-sign-in").click();
    // Signed out (the lost device is forgotten on the node, its leaves go as ghosts): sign in, unlock, join.
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible({ timeout: scaled(20_000) });
    await loginViaUi(page, alice.account);
    await page.getByTestId("recovery-key-input").fill(alice.account.recoveryWords);
    await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
    await joinVoice(page, roomId);
    await bothEncrypted(page, bob.page);
    await expect(page.getByTestId("voice-error")).toHaveCount(0);
  });
});
