// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's keychain, native notifications and tray (docs/DESKTOP.md), with the simulated shell of
 * `desktop-helpers.ts` against the real node, in Chromium and the phone emulation. The built app is covered by the
 * WebDriver smoke test (apps/desktop/e2e/smoke.mjs).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, logoutViaUi, openNavIfMobile, registerViaApi, registerViaUi, tokenOf } from "./helpers";
import { joinRoom, postMessage } from "./menu-helpers";
import { FAKE_MEDIA } from "./voice-helpers";
import { asDesktopShell, keyStoreRecord, keychainEntries, setKeychain, shellEmit, shellRecord } from "./desktop-helpers";

// The tray test joins voice with a fake microphone (a tone); Playwright allows browser arguments per file only.
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

test.describe("Desktop app: keys in the OS keychain", () => {
  test("without a keychain the key stays in IndexedDB with a warning; once there is one, it moves; sign-out removes it", async ({ page }) => {
    await asDesktopShell(page, { node: NODE, keychain: "unavailable" });
    const account = await registerViaUi(page, { prefix: "dkey" });
    expect(await keyStoreRecord(page, account.address)).toEqual({ hasKey: true, keychain: false });
    await page.goto("/settings/app");
    await expect(page.getByTestId("app-keys")).toHaveAttribute("data-protection", "fallback");
    await expect(page.getByTestId("app-keys-fallback")).toBeVisible();

    // The Secret Service is there at the next start: the key moves into it, the IndexedDB copy is removed.
    await setKeychain(page, "available");
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect.poll(async () => (await keychainEntries(page))[account.address]?.length ?? 0).toBe(32);
    expect(await keyStoreRecord(page, account.address)).toEqual({ hasKey: false, keychain: true });
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);

    // Another start opens the store from the keychain alone, without asking for the recovery key.
    await page.goto("/settings/app");
    await expect(page.getByTestId("app-keys")).toHaveAttribute("data-protection", "keychain");
    await expect(page.getByTestId("app-keys")).toContainText("Secret Service");
    await expect(page.getByTestId("app-keys-fallback")).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);

    // Signing out deletes the entry with the local data.
    await openNavIfMobile(page);
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => keychainEntries(page)).toEqual({});
  });
});

test.describe("Desktop app: notifications, close to tray, quit", () => {
  test("native in the background, in-app in front; a click opens the conversation; no web push settings", async ({ page, request }) => {
    const alice = await registerViaApi(request, "dnote");
    const bob = await registerViaApi(request, "dbob");
    const room = await createRoomViaApi(request, alice.token, "Desktop-Raum");
    await joinRoom(request, alice, room.id, bob);
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    const mention = (text: string) => postMessage(request, bob.token, channelId, `@${alice.username} ${text}`, { mentions: [`${alice.username}@localhost`] });

    await asDesktopShell(page, { node: NODE });
    await loginAs(page, alice);
    await page.goto("/");
    await expect(page.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready");

    // The window is in front: the toast as in the browser, no native notification.
    await mention("vorne?");
    await expect(page.getByTestId("notify-toast-mention").filter({ hasText: "vorne?" })).toBeVisible();
    expect((await shellRecord(page)).notices).toHaveLength(0);

    // In the background: a native notification with the jump path.
    await page.evaluate(() => ((window as unknown as { __e2eFocused: boolean }).__e2eFocused = false));
    await mention("hinten?");
    await expect.poll(async () => (await shellRecord(page)).notices.length).toBe(1);
    const notice = (await shellRecord(page)).notices[0]!;
    expect(notice.title).toContain("Desktop-Raum");
    expect(notice.body).toContain("hinten?");
    expect(notice.path).toBe(`/rooms/${room.id}/channels/${channelId}`);

    // The click (the shell focused the window) opens the conversation.
    await shellEmit(page, { kind: "open", path: notice.path! });
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/channels/${channelId}$`));
    await expect(page.getByTestId("message").filter({ hasText: "hinten?" })).toBeVisible();

    // The notification settings offer the app's notifications, no web push and no browser permission.
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("notify-desktop")).toBeChecked();
    await expect(page.getByTestId("push-settings")).toHaveCount(0);
    await expect(page.getByTestId("notify-browser")).toHaveCount(0);

    // Settings → App: close to tray (on by default) and quit.
    await page.goto("/settings/app");
    const closeToTray = page.getByTestId("app-close-to-tray");
    await expect(closeToTray).toBeChecked();
    await closeToTray.uncheck();
    await expect.poll(async () => (await shellRecord(page)).closeToTray).toBe(false);
    await expect(closeToTray).not.toBeChecked();
    await page.getByTestId("app-quit").click();
    await expect.poll(async () => (await shellRecord(page)).quit).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("Desktop app: tray", () => {
  async function voiceRoom(request: APIRequestContext, page: Page) {
    const owner = await registerViaApi(request, "downer");
    const room = await createRoomViaApi(request, owner.token, "Stammtisch");
    const code = await inviteCode(request, owner.token, room.id);
    const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data: {} });
    expect(join.ok(), await join.text()).toBeTruthy();
    return room.id as string;
  }

  const last = async (page: Page) => (await shellRecord(page)).tray.at(-1);

  test("follows the voice connection (connected, speaking, muted, deafened); its menu mutes, deafens and leaves", async ({ page, request }) => {
    await asDesktopShell(page, { node: NODE });
    await registerViaUi(page, { prefix: "dtray" });
    await expect.poll(async () => (await last(page))?.state).toBe("disconnected");
    expect((await last(page))?.labels).toMatchObject({ tooltip: "tavrn", hide: "tavrn ausblenden", mute: "Mikrofon stummschalten", quit: "tavrn beenden" });

    const roomId = await voiceRoom(request, page);
    await page.goto(`/rooms/${roomId}`);
    await openNavIfMobile(page);
    await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
    await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await last(page))?.state, { timeout: 15_000 }).toMatch(/^(connected|speaking)$/);
    expect((await last(page))?.labels.tooltip).toMatch(/^tavrn · Sprache \(Stammtisch\) · (Im Sprachkanal|Du sprichst)$/);
    // The fake microphone plays a tone: voice activation lets it through.
    await expect.poll(async () => (await shellRecord(page)).tray.map((t) => t.state), { timeout: 20_000 }).toContain("speaking");

    await shellEmit(page, { kind: "tray", action: "mute" });
    await expect.poll(async () => (await last(page))?.state).toBe("muted");
    expect((await last(page))?.labels.tooltip).toBe("tavrn · Sprache (Stammtisch) · Mikrofon stummgeschaltet");
    await shellEmit(page, { kind: "tray", action: "deafen" });
    await expect.poll(async () => (await last(page))?.state).toBe("deafened");
    await shellEmit(page, { kind: "tray", action: "leave" });
    await expect.poll(async () => (await last(page))?.state, { timeout: 15_000 }).toBe("disconnected");
    await expect(page.getByTestId("voice-join-panel")).toBeVisible();
    // Speaking does not flood the tray (at most one update per 150 ms).
    const updates = (await shellRecord(page)).tray.length;
    expect(updates).toBeLessThan(60);
  });
});
