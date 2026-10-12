// SPDX-License-Identifier: Apache-2.0
// Screen shares are opt-in (docs/CLIENT.md "Streams are joined"): nobody receives a stream until they join it. A
// share shows as a placeholder tile (name, LIVE, "Join stream"); joining subscribes its video and audio, leaving
// unsubscribes them again, any number of times without reconnecting. Joined from the tile (button, double-click), from
// the voice member list (double-click, Enter; only from inside the channel, otherwise a hint) and left from the tile or
// the fullscreen controls. The sharer has no permanent self view (a preview that can be hidden, an indicator with Stop).
// Several streams are joined one by one. On phones a wide stream in fullscreen turns the screen to landscape and fills
// it after the rotation. Subscriptions are read from LiveKit through the development hooks (`window.__tavrnVoice`).
// The Android app shares its screen as the device's screen publisher (VOICE.md §4b): a second participant
// `<identity>#screen` that is the sharer's stream (simulated shell, `android-helpers.ts`), stopped from the notification.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { NODE, createRoomViaApi, inviteCode, openNavIfMobile, tokenOf } from "./helpers";
import { androidRecord, asAndroidShell, stopFromNotification } from "./android-helpers";
import { FAKE_MEDIA, closeOpened, hooks, voiceUser, type VoiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

/** Headless Chromium has no screen: a 16:9 canvas capture as the shared screen. */
function fakeScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext("2d")!;
    let hue = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${(hue += 7) % 360} 60% 40%)`;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    return canvas.captureStream(10);
  };
}

/** Records the Screen Orientation API's lock and unlock calls (headless Chromium refuses real locks). */
function recordOrientationLocks() {
  const w = window as unknown as { __locks: string[] };
  w.__locks = [];
  const o = screen.orientation as ScreenOrientation & { lock: (x: string) => Promise<void>; unlock: () => void };
  if (!o) return;
  o.lock = async (x: string) => {
    w.__locks.push(x);
  };
  o.unlock = () => {
    w.__locks.push("unlock");
  };
}

const locks = (page: Page) => page.evaluate(() => (window as unknown as { __locks?: string[] }).__locks ?? []);
const streamTile = (page: Page, address: string) => page.getByTestId("screen-tile").and(page.locator(`[data-user="${address}"]`));
const row = (page: Page, address: string) => page.getByTestId("voice-participant").and(page.locator(`[data-user="${address}"]`));

/** Whether LiveKit on `page` has `address`'s screen share subscribed (null: no such publication). */
async function screenSubscribed(page: Page, address: string): Promise<boolean | null> {
  const state = await hooks(page);
  const remote = state.remote.find((r) => r.identity.startsWith(`${address}/`));
  const track = remote?.tracks.find((t) => t.source === "screen_share");
  return track ? track.subscribed : null;
}

/** Client-side navigation (keeps the voice session, unlike `page.goto`). */
async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function joinVoice(u: VoiceUser, roomId: string, voiceId: string) {
  await u.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
  await u.page.getByTestId("voice-join").click();
  await expect(u.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 30_000 });
}

async function share(u: VoiceUser) {
  await u.page.getByTestId("voice-screen").click();
  await u.page.getByTestId("screen-share-start").click();
  await expect(u.page.getByTestId("streaming-indicator")).toBeVisible({ timeout: 30_000 });
}

/** axe on the stage: serious and critical WCAG violations fail. */
async function axeStage(page: Page) {
  const result = await new AxeBuilder({ page }).include('[data-testid="voice-stage"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test.describe("Screen shares are joined", () => {
  test("a screen share is joined and left", async ({ browser, request }) => {
    test.setTimeout(scaled(300_000));
    const phone = (test.info().project.use.viewport?.width ?? 1280) < 768;
    const alice = await voiceUser(browser, "sjali");
    const bob = await voiceUser(browser, "sjbob");
    const carol = await voiceUser(browser, "sjcar");
    for (const u of [bob, carol]) await u.page.context().addInitScript(fakeScreen);
    await alice.page.context().addInitScript(recordOrientationLocks);
    const token = await tokenOf(alice.page);
    const room = await createRoomViaApi(request, token, "Kinoabend");
    const roomId = room.id as string;
    const channels = room.channels as { id: string; kind: string }[];
    const voiceId = channels.find((c) => c.kind === "voice")!.id;
    const textId = channels.find((c) => c.kind === "text")!.id;
    const code = await inviteCode(request, token, roomId);
    for (const u of [bob, carol]) {
      const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(u.page)}` }, data: {} });
      expect(join.ok(), await join.text()).toBeTruthy();
    }
    await joinVoice(alice, roomId, voiceId);
    await joinVoice(bob, roomId, voiceId);

    // Bob shares: he sees his own preview (no permanent self view: he hides it and brings it back) and the indicator.
    await share(bob);
    const own = streamTile(bob.page, bob.address);
    await expect(own).toHaveAttribute("data-state", "preview");
    await own.getByTestId("stream-preview-hide").click();
    await expect(own).toHaveCount(0);
    await bob.page.getByTestId("stream-preview-toggle").click();
    await expect(own).toHaveAttribute("data-state", "preview");

    // Alice gets a placeholder with Bob's name, LIVE and "Join stream"; nothing of the stream is received.
    const bobs = streamTile(alice.page, bob.address);
    await expect(bobs).toHaveAttribute("data-state", "available", { timeout: 30_000 });
    await expect(bobs).toContainText("Live");
    await expect(bobs.getByTestId("video-screen")).toHaveCount(0);
    await expect.poll(() => screenSubscribed(alice.page, bob.address), { timeout: 15_000 }).toBe(false);
    await expect(row(alice.page, bob.address).getByTestId("flag-streaming")).toBeAttached({ timeout: 15_000 });
    await axeStage(alice.page);

    // Joined from the button: the video arrives; left from the tile: back to the placeholder, unsubscribed.
    await bobs.getByTestId("stream-join").click();
    await expect(bobs).toHaveAttribute("data-state", "watching");
    await expect(bobs.getByTestId("video-screen")).toBeVisible({ timeout: 30_000 });
    await expect(bobs.getByTestId("stream-connecting")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => screenSubscribed(alice.page, bob.address), { timeout: 15_000 }).toBe(true);
    await axeStage(alice.page);
    await bobs.getByTestId("stream-leave").click();
    await expect(bobs).toHaveAttribute("data-state", "available");
    await expect.poll(() => screenSubscribed(alice.page, bob.address), { timeout: 15_000 }).toBe(false);
    // Again, by a double-click on the tile, and left again: no reconnect needed.
    await bobs.dblclick();
    await expect(bobs.getByTestId("video-screen")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => screenSubscribed(alice.page, bob.address), { timeout: 15_000 }).toBe(true);
    await bobs.getByTestId("stream-leave").click();
    await expect.poll(() => screenSubscribed(alice.page, bob.address), { timeout: 15_000 }).toBe(false);

    // Carol is not in the voice channel: a double-click on Bob in the member list only gives a hint.
    await carol.page.goto(`/rooms/${roomId}/channels/${textId}`);
    await openNavIfMobile(carol.page);
    await row(carol.page, bob.address).dblclick();
    await expect(carol.page.getByTestId("stream-join-hint")).toBeVisible();
    await expect(carol.page.getByTestId("voice-stage")).toHaveCount(0);
    // She joins and shares too: two streams, each its own placeholder for Alice.
    await joinVoice(carol, roomId, voiceId);
    await share(carol);
    const carols = streamTile(alice.page, carol.address);
    await expect(carols).toHaveAttribute("data-state", "available", { timeout: 30_000 });

    // Alice reads the text channel; a double-click on Bob (LIVE) in the member list joins his stream and opens the
    // stage. Carol's stream stays a placeholder: joining one does not join the others.
    await navigate(alice.page, `/rooms/${roomId}/channels/${textId}`);
    await expect(alice.page.getByTestId("voice-stage")).toHaveCount(0);
    await openNavIfMobile(alice.page);
    await row(alice.page, bob.address).dblclick();
    await expect(alice.page.getByTestId("voice-stage")).toBeVisible({ timeout: 15_000 });
    await expect(bobs).toHaveAttribute("data-state", "watching");
    await expect(bobs.getByTestId("video-screen")).toBeVisible({ timeout: 30_000 });
    await expect(carols).toHaveAttribute("data-state", "available");
    await expect.poll(() => screenSubscribed(alice.page, carol.address), { timeout: 15_000 }).toBe(false);
    await bobs.getByTestId("stream-leave").click();

    // Keyboard: Enter on Carol's row (focused) joins her stream.
    await openNavIfMobile(alice.page);
    await row(alice.page, carol.address).focus();
    await alice.page.keyboard.press("Enter");
    await expect(carols).toHaveAttribute("data-state", "watching", { timeout: 15_000 });
    await expect(carols.getByTestId("video-screen")).toBeVisible({ timeout: 30_000 });
    await expect(bobs).toHaveAttribute("data-state", "available");
    await expect.poll(() => screenSubscribed(alice.page, carol.address), { timeout: 15_000 }).toBe(true);

    // Fullscreen: on phones the wide stream turns the screen to landscape (desktops lock nothing); after the rotation
    // the stream fills the screen without scrolling. "Leave stream" in the fullscreen controls ends both.
    await expect.poll(async () => (await carols.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)) > 0, { timeout: 30_000 }).toBe(true);
    await carols.getByTestId("screen-fullscreen").click();
    await expect.poll(() => alice.page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") ?? null)).toBe("screen-tile");
    if (phone) {
      await expect.poll(() => locks(alice.page)).toEqual(["landscape"]);
      await expect(carols).toHaveAttribute("data-orientation", "portrait");
      // The phone turns: the emulated screen rotates (a window in fullscreen cannot be resized directly).
      const portrait = alice.page.viewportSize()!;
      const view = { width: portrait.height, height: portrait.width };
      const cdp = await alice.page.context().newCDPSession(alice.page);
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...view, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } });
      await expect(carols).toHaveAttribute("data-orientation", "landscape");
      for (const target of [carols, carols.getByTestId("video-screen")]) {
        const box = (await target.boundingBox())!;
        expect(Math.abs(box.width - view.width)).toBeLessThan(2);
        expect(Math.abs(box.height - view.height)).toBeLessThan(2);
      }
      expect(await carols.getByTestId("video-screen").evaluate((v) => getComputedStyle(v).objectFit)).toBe("contain");
      // The fullscreen view (the top layer, the page underneath is not shown) starts at the corner and does not scroll.
      const tileBox = (await carols.boundingBox())!;
      expect(Math.abs(tileBox.x) + Math.abs(tileBox.y)).toBeLessThan(2);
      const scroll = await carols.evaluate((el) => ({ x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight }));
      expect(scroll).toEqual({ x: 0, y: 0 });
    } else {
      expect(await locks(alice.page)).toEqual([]);
    }
    const controls = carols.getByTestId("fullscreen-controls");
    await carols.click({ position: { x: 40, y: 80 } });
    await controls.getByTestId("fullscreen-stream-leave").click();
    await expect.poll(() => alice.page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(carols).toHaveAttribute("data-state", "available");
    await expect.poll(() => screenSubscribed(alice.page, carol.address), { timeout: 15_000 }).toBe(false);
    if (phone) expect(await locks(alice.page)).toEqual(["landscape", "unlock"]);

    // A stream that ends is gone; a new share of the same person is a placeholder again.
    await carols.getByTestId("stream-join").click();
    await expect(carols).toHaveAttribute("data-state", "watching");
    await carol.page.getByTestId("stream-stop").click();
    await expect(carols).toHaveCount(0, { timeout: 15_000 });
    await expect(carol.page.getByTestId("streaming-indicator")).toHaveCount(0);
    await share(carol);
    await expect(carols).toHaveAttribute("data-state", "available", { timeout: 30_000 });
  });

  test("the Android app's screen publisher is its owner's stream; stopped from the notification", async ({ browser, request }) => {
    test.setTimeout(scaled(300_000));
    const project = test.info().project.name;
    const shots = (name: string) => fileURLToPath(new URL(`../../test-results/screenshare/${project}-${name}.png`, import.meta.url));
    // Alice uses the Android app (the shell simulated, its native screen publisher played in the page); Bob a browser.
    const alice = await voiceUser(browser, "sjapp");
    const bob = await voiceUser(browser, "sjweb");
    await asAndroidShell(alice.page, { node: NODE });
    await alice.page.reload();
    const token = await tokenOf(bob.page);
    const room = await createRoomViaApi(request, token, "Handyabend");
    const roomId = room.id as string;
    const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
    const code = await inviteCode(request, token, roomId);
    const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(alice.page)}` }, data: {} });
    expect(join.ok(), await join.text()).toBeTruthy();
    await joinVoice(bob, roomId, voiceId);
    await joinVoice(alice, roomId, voiceId);

    // The app's dialog: the whole screen after Android's consent, the sound of other apps off by default.
    await alice.page.getByTestId("voice-screen").click();
    await expect(alice.page.getByTestId("screen-share-dialog")).toHaveAttribute("data-native", "android");
    await expect(alice.page.getByTestId("screen-share-audio")).not.toBeChecked();
    await alice.page.getByTestId("screen-share-start").click();
    const indicator = alice.page.getByTestId("streaming-indicator");
    await expect(indicator).toHaveAttribute("data-native", "true", { timeout: 30_000 });
    await expect(indicator.getByTestId("stream-preview-toggle")).toHaveCount(0);
    const started = (await androidRecord(alice.page)).starts;
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ tokenParts: 3, keyLength: 32, max_side: 1920, fps: 30, audio: false });
    // The sharer gets no tile of her own publisher.
    await expect(alice.page.getByTestId("screen-tile")).toHaveCount(0);
    await axeStage(alice.page);

    // Bob: one stream under Alice's name, Alice listed once (streaming), nothing received before he joins.
    const alices = streamTile(bob.page, alice.address);
    await expect(alices).toHaveAttribute("data-state", "available", { timeout: 30_000 });
    await expect(alices).toHaveAttribute("data-identity", /#screen$/);
    await expect(row(bob.page, alice.address)).toHaveCount(1);
    await expect(row(bob.page, alice.address).getByTestId("flag-streaming")).toBeAttached({ timeout: 15_000 });
    await expect(bob.page.locator('[data-testid="voice-tile"][data-identity$="#screen"]')).toHaveCount(0);
    await axeStage(bob.page);
    await alices.getByTestId("stream-join").click();
    await expect(alices).toHaveAttribute("data-state", "watching");
    await expect(alices.getByTestId("video-screen")).toBeVisible({ timeout: 30_000 });
    // The frames decrypt: they were encrypted with the frame key Alice's client handed the publisher.
    await expect.poll(async () => (await alices.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)) > 0, { timeout: 30_000 }).toBe(true);
    await bob.page.screenshot({ path: shots("01-browser-watches-app-stream") });
    await alice.page.screenshot({ path: shots("02-app-streaming") });

    // A new epoch (Bob joins again: a self update) reaches the publisher as a new key; the stream still decrypts.
    const keysBefore = (await androidRecord(alice.page)).keys.length;
    await bob.page.getByTestId("voice-leave").click();
    await joinVoice(bob, roomId, voiceId);
    await expect.poll(async () => (await androidRecord(alice.page)).keys.length, { timeout: 30_000 }).toBeGreaterThan(keysBefore);
    await expect(alices).toHaveAttribute("data-state", "available", { timeout: 30_000 });
    await alices.getByTestId("stream-join").click();
    await expect.poll(async () => (await alices.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)) > 0, { timeout: 30_000 }).toBe(true);

    // Stopped from the notification: the bar goes, the stream ends for Bob, the node lets the publisher go.
    await stopFromNotification(alice.page);
    await expect(indicator).toHaveCount(0);
    await expect(alices).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => {
        const r = await request.get(`${NODE}/api/v1/rooms/${roomId}/voice`, { headers: { Authorization: `Bearer ${token}` } });
        const items = (await r.json()).items as { participants: { identity: string; screen_of?: string }[] }[];
        return items.flatMap((c) => c.participants).filter((p) => p.screen_of).length;
      }, { timeout: 15_000 })
      .toBe(0);
    await bob.page.screenshot({ path: shots("03-browser-after-stop") });
    // Alice can share again.
    await alice.page.getByTestId("voice-screen").click();
    await alice.page.getByTestId("screen-share-start").click();
    await expect(indicator).toBeVisible({ timeout: 30_000 });
    await expect(streamTile(bob.page, alice.address)).toHaveAttribute("data-state", "available", { timeout: 30_000 });
  });
});
