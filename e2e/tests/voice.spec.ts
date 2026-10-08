// SPDX-License-Identifier: Apache-2.0
// Voice client (tavrn-protocol/VOICE.md §9, design note 4.5, §4.9): two browser contexts with Chromium's fake
// media devices join the same voice channel through the node's LiveKit, with end-to-end encrypted media.
// Encryption, speaking and decoded audio are checked through the LiveKit SDK (`window.__tavrnVoice`,
// development builds only).
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, type Account } from "./helpers";

/** An animated GIF (profile.spec.ts fixture) for the avatar animation on the stage. */
const ANIMATED_GIF = resolve(dirname(new URL(import.meta.url).pathname), "../fixtures/animated.gif");

// Fake microphone and camera, no permission prompts, audio without a user gesture. The microphone plays a
// continuous tone from a file (Chromium's default fake input only beeps briefly, which LiveKit's active
// speaker detection rightly does not count as speech).
const FAKE_TONE = join(tmpdir(), "tavrn-voice-e2e-tone.wav");
writeFileSync(FAKE_TONE, toneWav(5, 48000));
const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${FAKE_TONE}`, "--autoplay-policy=no-user-gesture-required"];
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

/**
 * Headless Chromium has no screen to capture: `getDisplayMedia` returns a canvas capture track instead
 * (the client code path is the same: LiveKit's `setScreenShareEnabled`).
 */
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

interface VoiceUser {
  page: Page;
  address: string;
}

/**
 * Contexts opened by a test; closed afterwards so their LiveKit connections end (each holds UDP ports of the
 * test node's small range).
 */
const opened: BrowserContext[] = [];
/** Browser console warnings and errors of the test's pages, attached when a test fails. */
const consoleLines: string[] = [];
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && consoleLines.length) await info.attach("browser-console", { body: consoleLines.join("\n"), contentType: "text/plain" });
  consoleLines.length = 0;
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
});

async function voiceUser(browser: Browser, prefix: string, opts: { cuesOff?: boolean } = {}): Promise<VoiceUser> {
  const context = await browser.newContext({ ...test.info().project.use, permissions: ["microphone", "camera"] });
  opened.push(context);
  await context.addInitScript(fakeScreen);
  if (opts.cuesOff) await context.addInitScript(() => localStorage.setItem("tavrn.voice.settings", JSON.stringify({ cuesOff: true })));
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(`[${prefix}] ${m.type()}: ${m.text()}`);
  });
  const account = await registerViaUi(page, { prefix });
  return { page, address: account.address };
}

async function joinRoom(request: APIRequestContext, page: Page, code: string) {
  const resp = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data: {} });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

async function setup(request: APIRequestContext, opts: { userLimit?: number } = {}) {
  const owner = await registerViaApi(request, "vowner");
  const room = await createRoomViaApi(request, owner.token, "Stammtisch");
  const voice = room.channels.find((c: { kind: string }) => c.kind === "voice") as { id: string };
  if (opts.userLimit !== undefined) {
    const resp = await request.patch(`${NODE}/api/v1/rooms/${room.id}/channels/${voice.id}`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { user_limit: opts.userLimit } });
    expect(resp.ok(), await resp.text()).toBeTruthy();
  }
  return { owner, roomId: room.id as string, voiceId: voice.id, code: await inviteCode(request, owner.token, room.id) };
}

/** Joins the room's voice channel by clicking it in the channel list. */
async function joinFromSidebar(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible();
}

const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));
const row = (page: Page, address: string) => page.getByTestId("voice-participant").and(page.locator(`[data-user="${address}"]`));

interface HookState {
  e2eeEnabled: boolean;
  localEncrypted: boolean;
  keyIndex: number;
  epoch: number | null;
  local: { identity: string; tracks: { source: string; encrypted: boolean }[] };
  remote: { identity: string; isSpeaking: boolean; isEncrypted: boolean; tracks: { source: string; encrypted: boolean; subscribed: boolean }[] }[];
}

/** Notification sounds played so far (development builds record them, `cues.ts`). */
const cues = (page: Page) => page.evaluate(() => (window as unknown as { __tavrnCues?: { played: { cue: string; own: boolean }[] } }).__tavrnCues?.played ?? []);
/** Cues that actually reached a running AudioContext (scheduled by the cue engine). */
const scheduledCues = (page: Page) => page.evaluate(() => (window as unknown as { __tavrnCues?: { scheduled?: { cue: string; state: string }[] } }).__tavrnCues?.scheduled ?? []);

/** Width / height of an element's box (0 while it is not laid out). */
async function aspect(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  return box && box.height > 0 ? box.width / box.height : 0;
}

/** Stage tiles are 16:9 (polish round 2: no more tall, narrow strips). */
async function expect16x9(target: Locator) {
  await expect.poll(() => aspect(target), { timeout: 10_000 }).toBeGreaterThan(16 / 9 - 0.04);
  expect(await aspect(target)).toBeLessThan(16 / 9 + 0.04);
}

/** The element in fullscreen (its test id), from the page's Fullscreen API. */
const fullscreenOf = (page: Page) => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") ?? null);

/** LiveKit's view of the call (the hooks appear once the session finished connecting). */
async function hooks(page: Page): Promise<HookState> {
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __tavrnVoice?: unknown }).__tavrnVoice), { timeout: 20_000 }).toBe(true);
  return page.evaluate(() => (window as unknown as { __tavrnVoice: { state: () => unknown } }).__tavrnVoice.state() as HookState);
}

/** Signs a LiveKit webhook like LiveKit does (JWT with the SHA-256 of the body), with the node's key file. */
async function liveKitWebhook(request: APIRequestContext, event: unknown) {
  const keyFile = resolve(dirname(new URL(import.meta.url).pathname), "../../data-dev/e2e/keys/livekit.key");
  const [key, secret] = readFileSync(keyFile, "utf8").trim().split(/:\s*/) as [string, string];
  const body = JSON.stringify(event);
  const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: key, nbf: now - 5, exp: now + 300, sha256: createHash("sha256").update(body).digest("base64") };
  const head = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
  const jwt = `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
  const resp = await request.post(`${NODE}/api/v1/voice/webhook`, { headers: { Authorization: jwt, "Content-Type": "application/webhook+json" }, data: body });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

/** A short 16-bit mono WAV (a 440 Hz tone) for the soundboard. */
function toneWav(seconds = 0.5, rate = 16000): Buffer {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return buf;
}

async function uploadSound(request: APIRequestContext, owner: Account, roomId: string, name: string) {
  const resp = await request.post(`${NODE}/api/v1/rooms/${roomId}/soundboard`, {
    headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "audio/wav", "Tavrn-Sound-Name": encodeURIComponent(name), "Tavrn-Sound-Duration-Ms": "500" },
    data: toneWav(),
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

test.describe("Voice channels", () => {
  test("two people: tiles, encryption, speaking, mute, deafen, screen, soundboard, server mute, leave", async ({ browser, request }) => {
    test.setTimeout(240_000);
    const { owner, roomId, voiceId, code } = await setup(request);
    await uploadSound(request, owner, roomId, "Tusch");
    const alice = await voiceUser(browser, "valice");
    const bob = await voiceUser(browser, "vbob");
    await joinRoom(request, alice.page, code);
    await joinRoom(request, bob.page, code);

    // Alice joins by clicking the channel, Bob from the channel's join panel.
    await joinFromSidebar(alice.page, roomId);
    // Alone in the channel: one large 16:9 tile (not a tall strip), on desktop and on phones.
    await expect(tile(alice.page, alice.address)).toBeVisible({ timeout: 20_000 });
    await expect16x9(tile(alice.page, alice.address));
    const stageBox = (await alice.page.getByTestId("stage-body").boundingBox())!;
    expect((await tile(alice.page, alice.address).boundingBox())!.width).toBeGreaterThan(stageBox.width * 0.6);
    await bob.page.goto(`/rooms/${roomId}`);
    await openNavIfMobile(bob.page);
    await expect(row(bob.page, alice.address)).toBeAttached({ timeout: 15_000 });
    await bob.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await expect(bob.page.getByTestId("voice-join-panel")).toBeVisible();
    await bob.page.getByTestId("voice-join").click();
    await expect(bob.page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });

    // Notification sounds: Bob hears his own join, Alice hears Bob joining, scheduled on a running context.
    await expect.poll(() => cues(bob.page)).toContainEqual({ cue: "join", own: true });
    await expect.poll(() => cues(alice.page), { timeout: 15_000 }).toContainEqual({ cue: "join", own: false });
    await expect.poll(() => scheduledCues(bob.page)).toContainEqual(expect.objectContaining({ cue: "join", state: "running" }));
    await expect.poll(() => scheduledCues(alice.page)).toContainEqual(expect.objectContaining({ cue: "join", state: "running" }));

    // Both see each other's tiles and sidebar rows.
    for (const u of [alice, bob]) {
      await expect(tile(u.page, alice.address)).toBeVisible({ timeout: 20_000 });
      await expect(tile(u.page, bob.address)).toBeVisible({ timeout: 20_000 });
      await expect(row(u.page, alice.address)).toHaveCount(1, { timeout: 20_000 });
      await expect(row(u.page, bob.address)).toHaveCount(1);
    }

    // Phones get the swipeable grid (pages of four) and the bottom control bar, larger screens the grid.
    // Two people: 16:9 tiles side by side on desktop, stacked on phones.
    const phone = (alice.page.viewportSize()?.width ?? 1280) < 768;
    if (phone) {
      await expect(alice.page.getByTestId("voice-pages")).toBeVisible();
      await expect(alice.page.getByTestId("voice-page")).toHaveCount(1);
      await expect(alice.page.getByTestId("voice-page").getByTestId("voice-tile")).toHaveCount(2);
    } else {
      await expect(alice.page.getByTestId("voice-grid")).toBeVisible();
    }
    for (const address of [alice.address, bob.address]) await expect16x9(tile(alice.page, address));
    const [a, b] = [(await tile(alice.page, alice.address).boundingBox())!, (await tile(alice.page, bob.address).boundingBox())!];
    if (phone) {
      expect(Math.abs(a.x - b.x)).toBeLessThan(2);
      expect(Math.abs(a.y - b.y)).toBeGreaterThan(a.height - 2);
    } else {
      expect(Math.abs(a.y - b.y)).toBeLessThan(2);
      expect(Math.abs(a.x - b.x)).toBeGreaterThan(a.width - 2);
    }
    await expect(alice.page.getByTestId("voice-controls")).toBeVisible();

    // End-to-end encryption, as LiveKit reports it: enabled for this device, every published and received
    // track encrypted; Alice decodes Bob's audio, so both derived the same frame key after Bob's self update.
    for (const u of [alice, bob]) {
      await expect.poll(async () => (await hooks(u.page)).e2eeEnabled, { timeout: 15_000 }).toBe(true);
      const s = await hooks(u.page);
      expect(s.localEncrypted).toBe(true);
      expect(s.local.tracks.length).toBeGreaterThan(0);
      expect(s.local.tracks.every((t) => t.encrypted)).toBe(true);
    }
    await expect.poll(async () => (await hooks(alice.page)).remote.find((r) => r.identity.startsWith(bob.address))?.tracks.every((t) => t.encrypted && t.subscribed) ?? false, { timeout: 20_000 }).toBe(true);
    const aliceState = await hooks(alice.page);
    const bobState = await hooks(bob.page);
    expect(aliceState.epoch).toBe(bobState.epoch);
    expect(aliceState.keyIndex).toBe((aliceState.epoch ?? 0) % 256);
    const bobIdentity = bobState.local.identity;
    await expect
      .poll(() => alice.page.evaluate((id) => (window as unknown as { __tavrnVoice: { inboundAudioPeak: (i: string) => Promise<number> } }).__tavrnVoice.inboundAudioPeak(id), bobIdentity), { timeout: 30_000 })
      .toBeGreaterThan(0.05);

    // Speaking: Alice mutes herself, Bob's fake microphone plays its tone; Alice sees Bob's tile light up.
    await alice.page.getByTestId("voice-mute").click();
    await expect(alice.page.getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => cues(alice.page)).toContainEqual({ cue: "mute", own: true });
    await expect(tile(alice.page, bob.address)).toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    // …and Bob sees Alice muted.
    await expect(tile(bob.page, alice.address).getByTestId("flag-muted")).toBeVisible({ timeout: 15_000 });
    await expect(row(bob.page, alice.address).getByTestId("flag-muted")).toBeAttached();

    // Deafen reflects on the other side too.
    await bob.page.getByTestId("voice-deafen").click();
    await expect(tile(alice.page, bob.address).getByTestId("flag-deafened")).toBeVisible({ timeout: 15_000 });
    await bob.page.getByTestId("voice-deafen").click();
    await expect(tile(alice.page, bob.address).getByTestId("flag-deafened")).toHaveCount(0, { timeout: 15_000 });

    // Camera: Bob's tile shows his video on Alice's side (16:9, cropped to fill), his row the camera flag.
    await bob.page.getByTestId("voice-camera").click();
    await expect(tile(alice.page, bob.address).getByTestId("video-camera")).toBeVisible({ timeout: 30_000 });
    await expect(row(alice.page, bob.address).getByTestId("flag-camera")).toBeAttached({ timeout: 15_000 });
    await expect16x9(tile(alice.page, bob.address));
    await expect(tile(alice.page, bob.address).getByTestId("video-camera")).toHaveAttribute("data-fit", "cover");
    // A camera tile goes fullscreen on its own; the controls overlay (mute, leave) is there, Escape leaves.
    await tile(alice.page, bob.address).hover();
    await tile(alice.page, bob.address).getByTestId("tile-fullscreen").click();
    await expect.poll(() => fullscreenOf(alice.page)).toBe("voice-tile");
    await expect(tile(alice.page, bob.address).getByTestId("fullscreen-controls")).toBeVisible();
    await expect(tile(alice.page, bob.address).getByTestId("fullscreen-leave")).toBeVisible();
    await alice.page.keyboard.press("Escape");
    await expect.poll(() => fullscreenOf(alice.page)).toBeNull();
    await bob.page.getByTestId("voice-camera").click();
    await expect(tile(alice.page, bob.address).getByTestId("video-camera")).toHaveCount(0, { timeout: 15_000 });

    // Screen share (a canvas capture track headless): a large tile on the other side, focusable.
    await bob.page.getByTestId("voice-screen").click();
    await bob.page.getByTestId("screen-share-start").click();
    const screen = alice.page.getByTestId("screen-tile").and(alice.page.locator(`[data-user="${bob.address}"]`));
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await expect(row(alice.page, bob.address).getByTestId("flag-streaming")).toBeAttached({ timeout: 15_000 });
    await screen.getByTestId("screen-focus").click();
    await expect(alice.page.locator('[data-testid="screen-tile"][data-focused]')).toBeVisible();
    // The focused share is one large 16:9 tile, the people a strip of small 16:9 tiles.
    await expect16x9(alice.page.locator('[data-testid="screen-tile"][data-focused]'));
    await expect16x9(tile(alice.page, alice.address));
    // Fullscreen (Fullscreen API): the button on the focused share, controls on tap/hover, Escape leaves; `F` toggles.
    await screen.getByTestId("screen-fullscreen").click();
    await expect.poll(() => fullscreenOf(alice.page)).toBe("screen-tile");
    const controls = screen.getByTestId("fullscreen-controls");
    await screen.click({ position: { x: 40, y: 80 } });
    await expect(controls).toHaveAttribute("data-shown", "true");
    // Mute from the overlay (Alice is muted: unmute and mute again).
    await controls.getByTestId("fullscreen-mute").click();
    await expect(alice.page.getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "false");
    await controls.getByTestId("fullscreen-mute").click();
    await expect(alice.page.getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "true");
    await alice.page.keyboard.press("Escape");
    await expect.poll(() => fullscreenOf(alice.page)).toBeNull();
    if (!phone) {
      await alice.page.keyboard.press("f");
      await expect.poll(() => fullscreenOf(alice.page)).toBe("screen-tile");
      await alice.page.keyboard.press("f");
      await expect.poll(() => fullscreenOf(alice.page)).toBeNull();
    }
    await bob.page.getByTestId("voice-screen").click();
    await expect(screen).toHaveCount(0, { timeout: 15_000 });

    // Soundboard: Bob opens the room's clips and plays one into his (encrypted) microphone track.
    await bob.page.getByTestId("voice-soundboard").click();
    await expect(bob.page.getByTestId("soundboard-panel")).toBeVisible();
    await bob.page.getByTestId("soundboard-clip").filter({ hasText: "Tusch" }).click();
    await bob.page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
    // A personal clip (design note 4.13) is offered in its own group and plays with use_external_sounds (default).
    const personal = await request.post(`${NODE}/api/v1/users/me/sounds`, {
      headers: { Authorization: `Bearer ${await tokenOf(bob.page)}`, "Content-Type": "audio/wav", "Tavrn-Sound-Name": "Meins", "Tavrn-Sound-Duration-Ms": "500", "Tavrn-Sound-Emoji": encodeURIComponent("🎺") },
      data: toneWav(),
    });
    expect(personal.status(), await personal.text()).toBe(201);
    await bob.page.getByTestId("voice-soundboard").click();
    const mine = bob.page.getByTestId("soundboard-external-clip").filter({ hasText: "Meins" });
    await expect(mine).toContainText("🎺");
    await expect(mine).not.toHaveAttribute("aria-disabled", "true");
    const played = bob.page.waitForResponse((r) => r.url().includes("/soundboard/play") && r.status() === 200);
    await mine.click();
    await played;
    await bob.page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();

    // A moderator (the room owner, in a third context) server-mutes Bob from the channel list.
    const modContext = await browser.newContext({ ...test.info().project.use });
    opened.push(modContext);
    const mod = await modContext.newPage();
    await loginAs(mod, owner);
    await mod.goto(`/rooms/${roomId}`);
    await openNavIfMobile(mod);
    await expect(row(mod, bob.address)).toHaveCount(1, { timeout: 20_000 });
    // The participant's menu is the member list's dropdown (design note 4.13 item 3), opened with its ⋯ button.
    await row(mod, bob.address).getByRole("button", { name: /Optionen für/ }).click();
    await mod.getByTestId("member-menu").getByRole("menuitem", { name: "Serverseitig stummschalten" }).click();
    for (const p of [alice.page, bob.page]) await expect(row(p, bob.address).getByTestId("flag-server-muted")).toBeAttached({ timeout: 15_000 });
    // Bob cannot unmute himself while server-muted.
    await bob.page.getByTestId("voice-mute").click();
    await expect(bob.page.getByText("Ein Moderator hat dich stummgeschaltet")).toBeVisible();
    await row(mod, bob.address).getByRole("button", { name: /Optionen für/ }).click();
    await mod.getByTestId("member-menu").getByRole("menuitem", { name: "Stummschaltung aufheben" }).click();
    await expect(row(alice.page, bob.address).getByTestId("flag-server-muted")).toHaveCount(0, { timeout: 15_000 });

    // The member list marks people in voice; the voice bar follows into text channels.
    await openNavIfMobile(bob.page);
    await bob.page.getByRole("link", { name: /allgemein/ }).click();
    await expect(bob.page.getByTestId("voice-stage")).toHaveCount(0);
    await expect(bob.page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected");
    await expect(bob.page.getByTestId("member-voice").first()).toBeAttached();

    // Leave from the voice bar: Alice is alone again.
    await openNavIfMobile(bob.page);
    await bob.page.getByTestId("voice-bar-leave").click();
    await expect(bob.page.getByTestId("voice-bar")).toHaveCount(0);
    await expect(tile(alice.page, bob.address)).toHaveCount(0, { timeout: 20_000 });
    await expect(row(alice.page, bob.address)).toHaveCount(0, { timeout: 20_000 });
    await alice.page.getByTestId("voice-leave").click();
    await expect(alice.page.getByTestId("voice-join-panel")).toBeVisible();
  });

  test("Connection problems: plug icon, reconnecting without duplicates, removal after the grace period", async ({ browser, request }) => {
    test.setTimeout(180_000);
    const { roomId, voiceId, code } = await setup(request);
    // Alice switched all notification sounds off.
    const alice = await voiceUser(browser, "valice", { cuesOff: true });
    const bob = await voiceUser(browser, "vbob");
    await joinRoom(request, alice.page, code);
    await joinRoom(request, bob.page, code);
    await joinFromSidebar(alice.page, roomId);
    await joinFromSidebar(bob.page, roomId);
    await expect(row(alice.page, bob.address)).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => cues(bob.page)).toContainEqual({ cue: "join", own: true });
    expect(await cues(alice.page)).toEqual([]);
    const bobIdentity = (await hooks(bob.page)).local.identity;
    const lkRoom = `${roomId}:${voiceId}`;

    // The node loses Bob's connection (LiveKit's webhook): Alice sees the plug glyph instead of a ring.
    await liveKitWebhook(request, { event: "participant_connection_aborted", room: { name: lkRoom }, participant: { identity: bobIdentity } });
    await expect(row(alice.page, bob.address)).toHaveAttribute("data-connection", "reconnecting", { timeout: 10_000 });
    await expect(row(alice.page, bob.address).getByTestId("connection-problems")).toBeAttached();
    await expect(row(alice.page, bob.address)).not.toHaveAttribute("data-speaking", "true");
    await expect(tile(alice.page, bob.address).getByTestId("connection-problems")).toBeVisible();
    // Back: normal state, listed once.
    await liveKitWebhook(request, { event: "participant_joined", room: { name: lkRoom }, participant: { identity: bobIdentity } });
    await expect(row(alice.page, bob.address)).not.toHaveAttribute("data-connection", "reconnecting", { timeout: 10_000 });
    await expect(row(alice.page, bob.address)).toHaveCount(1);

    // Bob's own connection breaks: his client rejoins by itself (voice bar "reconnecting"), E2EE again.
    await bob.page.evaluate(() => void (window as unknown as { __tavrnVoice: { drop: () => Promise<void> } }).__tavrnVoice.drop());
    await expect(bob.page.getByTestId("voice-stage")).toBeVisible();
    await expect.poll(async () => bob.page.evaluate(() => !!(window as unknown as { __tavrnVoice?: { state: () => { e2eeEnabled: boolean } } }).__tavrnVoice?.state().e2eeEnabled), { timeout: 30_000 }).toBe(true);
    await expect(row(alice.page, bob.address)).toHaveCount(1, { timeout: 20_000 });
    await expect(tile(alice.page, bob.address)).toHaveCount(1);

    // A drop longer than the grace period (5 s on the test nodes): LiveKit drops Bob and his client cannot
    // rejoin (offline). Alice sees him reconnecting, then he is gone; Bob's client gives up.
    await bob.page.evaluate(() => (window as unknown as { __tavrnVoice: { room: { simulateScenario: (s: string) => Promise<void> } } }).__tavrnVoice.room.simulateScenario("server-leave"));
    await bob.page.context().setOffline(true);
    await expect(row(alice.page, bob.address)).toHaveAttribute("data-connection", "reconnecting", { timeout: 15_000 });
    await expect(row(alice.page, bob.address)).toHaveCount(0, { timeout: 15_000 });
    await expect(bob.page.getByTestId("voice-join-panel")).toBeVisible({ timeout: 15_000 });
    await bob.page.context().setOffline(false);
  });

  test("full channel: user_limit 1 is reported with the limit", async ({ browser, request }) => {
    test.setTimeout(150_000);
    const { roomId, code } = await setup(request, { userLimit: 1 });
    const alice = await voiceUser(browser, "valice");
    const bob = await voiceUser(browser, "vbob");
    await joinRoom(request, alice.page, code);
    await joinRoom(request, bob.page, code);
    await joinFromSidebar(alice.page, roomId);
    await bob.page.goto(`/rooms/${roomId}`);
    await openNavIfMobile(bob.page);
    await expect(bob.page.getByTestId("voice-count")).toHaveText("1/1", { timeout: 20_000 });
    await bob.page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
    await expect(bob.page.getByTestId("voice-error")).toContainText("höchstens 1 Teilnehmer", { timeout: 30_000 });
    await expect(bob.page.getByTestId("voice-stage")).toHaveCount(0);
  });

  test("Voice & video settings: devices, levels, voice activation/push-to-talk, noise suppression; manage the soundboard", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { owner, roomId } = await setup(request);
    await loginAs(page, owner);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/settings/voice");
    await expect(page.getByTestId("voice-settings")).toBeVisible();

    // Microphone check: the meter moves with the fake input and the voice activation light reacts.
    await page.getByTestId("mic-check-start").click();
    await expect.poll(async () => Number(await page.getByTestId("mic-meter").getAttribute("data-level")), { timeout: 15_000 }).toBeGreaterThan(-90);
    // Devices are listed once the permission was granted.
    await expect.poll(async () => page.getByTestId("mic-select").locator("option").count(), { timeout: 10_000 }).toBeGreaterThan(1);
    await expect.poll(async () => page.getByTestId("camera-select").locator("option").count()).toBeGreaterThan(1);
    await page.getByTestId("vad-threshold").fill("-100");
    await expect(page.getByTestId("vad-indicator")).toHaveAttribute("data-open", "true", { timeout: 10_000 });

    // Noise suppression levels switch live without errors (RNNoise loads its WASM worklet).
    for (const level of ["rnnoise", "off", "browser"]) {
      await page.getByTestId(`ns-${level}`).check();
      await expect(page.getByTestId(`ns-${level}`)).toBeChecked();
      await expect.poll(async () => Number(await page.getByTestId("mic-meter").getAttribute("data-level")), { timeout: 15_000 }).toBeGreaterThan(-90);
    }

    // Push-to-talk: the gate stays closed without the key; the key can be changed.
    await page.getByTestId("mode-ptt").check();
    await expect(page.getByTestId("ptt-settings")).toBeVisible();
    await expect(page.getByTestId("vad-indicator")).not.toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await page.getByTestId("ptt-capture").click();
    await page.keyboard.press("KeyB");
    await expect(page.getByTestId("ptt-key")).toHaveText("KeyB");
    await page.getByTestId("mode-vad").check();
    await expect(page.getByTestId("ptt-settings")).toHaveCount(0);
    await page.getByTestId("mic-check-stop").click();

    // Notification sounds: one switch for all, and one per cue.
    await page.getByTestId("cue-join").uncheck();
    await page.getByTestId("cues-off").check();
    await expect(page.getByTestId("cue-leave")).toBeDisabled();
    await page.getByTestId("cues-off").uncheck();
    await expect(page.getByTestId("cue-leave")).toBeChecked();
    await expect(page.getByTestId("cue-join")).not.toBeChecked();

    // Settings persist per device.
    await page.reload();
    await expect(page.getByTestId("ns-browser")).toBeChecked();
    await expect(page.getByTestId("vad-threshold")).toHaveValue("-100");
    await expect(page.getByTestId("cue-join")).not.toBeChecked();

    // Camera preview with the fake camera.
    await page.getByTestId("camera-preview-toggle").click();
    await expect.poll(() => page.getByTestId("camera-preview").evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByTestId("camera-preview-toggle").click();

    // Animated backgrounds wait for the media pipeline (phase 4C).
    await page.getByTestId("bg-upload").setInputFiles({ name: "loop.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
    await expect(page.getByTestId("bg-note")).toBeVisible();
    expect(errors).toEqual([]);

    // Soundboard management in the room settings (manage_emojis).
    await page.goto(`/rooms/${roomId}/settings/soundboard`);
    const form = page.getByTestId("soundboard-upload");
    await form.getByLabel("Name").fill("Gong");
    await form.getByLabel("Audiodatei").setInputFiles({ name: "gong.wav", mimeType: "audio/wav", buffer: toneWav() });
    await form.getByRole("button", { name: "Hochladen" }).click();
    await expect(page.getByTestId("soundboard-list")).toContainText("Gong");
    await page.getByRole("button", { name: "Gong löschen" }).click();
    await expect(page.getByTestId("soundboard-list")).not.toContainText("Gong");
  });
  test("Hear yourself: the live loopback starts, shows its timer and stops next to record and play back; leaving the settings ends it", async ({ page, request }) => {
    test.setTimeout(90_000);
    const { owner } = await setup(request);
    await loginAs(page, owner);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/settings/voice");
    await expect(page.getByTestId("voice-settings")).toBeVisible();

    // One click starts the microphone pipeline (the chain a call publishes) and plays it back live, with a timer.
    await page.getByTestId("mic-loopback").click();
    await expect(page.getByTestId("mic-loopback-stop")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("loopback-timer")).toContainText("0:00 / 1:00");
    await expect(page.getByTestId("loopback-timer")).toContainText(/0:0[2-9] \/ 1:00/, { timeout: 10_000 });
    await expect.poll(async () => Number(await page.getByTestId("mic-meter").getAttribute("data-level")), { timeout: 15_000 }).toBeGreaterThan(-90);
    // Record and play back stays, next to it.
    await page.getByTestId("mic-record").click();
    await expect(page.getByTestId("mic-playback")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("mic-loopback-stop").click();
    await expect(page.getByTestId("loopback-timer")).toHaveCount(0);
    await expect(page.getByTestId("mic-loopback")).toBeEnabled();

    // Leaving the settings ends it; it is off when the user comes back.
    await page.getByTestId("mic-loopback").click();
    await expect(page.getByTestId("loopback-timer")).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      history.pushState({}, "", "/settings/profile");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByTestId("voice-settings")).toHaveCount(0);
    await page.evaluate(() => {
      history.pushState({}, "", "/settings/voice");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByTestId("voice-settings")).toBeVisible();
    await expect(page.getByTestId("loopback-timer")).toHaveCount(0);
    await expect(page.getByTestId("mic-loopback")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Moving: drag onto another channel, move everyone with confirmation; animated avatar only while speaking", async ({ browser, request }) => {
    test.setTimeout(240_000);
    const { owner, roomId, voiceId, code } = await setup(request);
    const raid = await request.post(`${NODE}/api/v1/rooms/${roomId}/channels`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { kind: "voice", name: "Raid" } });
    expect(raid.ok(), await raid.text()).toBeTruthy();
    const raidId = (await raid.json()).id as string;
    const alice = await voiceUser(browser, "valice");
    const bob = await voiceUser(browser, "vbob");
    // Alice has an animated avatar (design note 4.5 item 6: on the stage it plays only while she speaks).
    const avatar = await alice.page.request.put(`${NODE}/api/v1/users/me/avatar`, { headers: { Authorization: `Bearer ${await tokenOf(alice.page)}`, "Content-Type": "image/gif" }, data: readFileSync(ANIMATED_GIF) });
    expect(avatar.ok(), await avatar.text()).toBeTruthy();
    await joinRoom(request, alice.page, code);
    await joinRoom(request, bob.page, code);
    await joinFromSidebar(alice.page, roomId);
    await joinFromSidebar(bob.page, roomId);

    // Alice's fake microphone plays a tone: Bob sees her tile speaking and her avatar animated; muted, the
    // tile shows the still frame (also when hovered).
    const aliceAvatar = tile(bob.page, alice.address).locator(".voice-avatar");
    await expect(aliceAvatar).toHaveAttribute("data-has-animation", "true", { timeout: 20_000 });
    await expect(tile(bob.page, alice.address)).toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    await expect(aliceAvatar).toHaveAttribute("data-animate", "true");
    await expect(aliceAvatar.getByTestId("avatar-image")).toHaveAttribute("src", /\/animated$/);
    await alice.page.getByTestId("voice-mute").click();
    await expect(tile(bob.page, alice.address)).not.toHaveAttribute("data-speaking", "true", { timeout: 20_000 });
    await expect(aliceAvatar).not.toHaveAttribute("data-animate", "true");
    await aliceAvatar.hover();
    await expect(aliceAvatar.getByTestId("avatar-image")).not.toHaveAttribute("src", /\/animated$/);

    // The owner moves Bob: dragging his row onto "Raid" (phones: the participant menu).
    const modContext = await browser.newContext({ ...test.info().project.use });
    opened.push(modContext);
    const mod = await modContext.newPage();
    await loginAs(mod, owner);
    await mod.goto(`/rooms/${roomId}`);
    await openNavIfMobile(mod);
    const channel = (id: string) => mod.getByTestId("voice-channel").and(mod.locator(`[data-channel="${id}"]`));
    const inChannel = (id: string, address: string) => channel(id).locator(`[data-testid="voice-participant"][data-user="${address}"]`);
    await expect(inChannel(voiceId, bob.address)).toHaveCount(1, { timeout: 20_000 });
    if ((mod.viewportSize()?.width ?? 1280) >= 768) {
      await inChannel(voiceId, bob.address).dragTo(channel(raidId));
    } else {
      await inChannel(voiceId, bob.address).getByRole("button", { name: /Optionen für/ }).click();
      await mod.getByTestId("member-menu").getByRole("menuitem", { name: "Verschieben nach" }).click();
      await mod.getByTestId("context-submenu").getByRole("menuitem", { name: "Raid" }).click();
    }
    // Bob's client follows the move into the other channel (another MLS group and key).
    await expect(inChannel(raidId, bob.address)).toHaveCount(1, { timeout: 30_000 });
    await expect(inChannel(voiceId, bob.address)).toHaveCount(0);
    await expect(bob.page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected", { timeout: 30_000 });

    // Mass move from the channel's context menu (the same dropdown as text channels): everybody in voice
    // into "Raid", after a confirmation.
    await channel(raidId).getByTestId("voice-channel-menu-button").click();
    await mod.getByTestId("channel-menu").getByRole("menuitem", { name: "Alle hierher verschieben (1)" }).click();
    await expect(mod.getByTestId("move-all-confirm")).toContainText("(1)");
    await mod.getByTestId("move-all-confirm-button").click();
    await expect(inChannel(raidId, alice.address)).toHaveCount(1, { timeout: 30_000 });
    await expect(channel(voiceId).getByTestId("voice-participant")).toHaveCount(0);
    // …and everybody from "Raid" back.
    await channel(raidId).getByTestId("voice-channel-menu-button").click();
    await mod.getByTestId("channel-menu").getByRole("menuitem", { name: /Alle von hier \(2\) verschieben nach/ }).click();
    await mod.getByTestId("context-submenu").getByRole("menuitem", { name: "Sprache" }).click();
    await expect(mod.getByTestId("move-all-confirm")).toContainText("(2)");
    await mod.getByTestId("move-all-confirm-button").click();
    await expect(inChannel(voiceId, alice.address)).toHaveCount(1, { timeout: 30_000 });
    await expect(inChannel(voiceId, bob.address)).toHaveCount(1, { timeout: 30_000 });
    await expect(channel(raidId).getByTestId("voice-participant")).toHaveCount(0);
  });

  test("Connection test and background: every path to the media server, blur strength and quality", async ({ page, request }) => {
    test.setTimeout(180_000);
    const { owner } = await setup(request);
    await loginAs(page, owner);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/settings/voice");

    // The connection test (VOICE.md §10.4): every announced address over UDP, ICE over TCP, TURN over UDP.
    await page.getByTestId("connection-test-run").click();
    const summary = page.getByTestId("connection-test-summary");
    await expect(summary).toBeVisible({ timeout: 120_000 });
    await expect(summary).toHaveText("Sprache und Video können sich von diesem Gerät aus verbinden.");
    const rows = page.getByTestId("connection-test-row");
    await expect(rows.and(page.locator('[data-kind="any"]'))).toHaveAttribute("data-ok", "true");
    await expect(rows.and(page.locator('[data-kind="udp"][data-ok="true"]')).first()).toBeVisible();
    await expect(rows.and(page.locator('[data-kind="tcp"]')).first()).toHaveAttribute("data-ok", "true");
    await expect(rows.and(page.locator('[data-kind="turn_udp"]'))).toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("connection-test-config")).toContainText("Medienports: UDP");

    // Background blur: strength and quality, the honest limits, and a live preview without errors.
    await page.getByTestId("bg-blur").check();
    await expect(page.getByTestId("blur-strength")).toHaveValue("60");
    await page.getByTestId("blur-strength").fill("90");
    await page.getByTestId("bg-quality").selectOption("high");
    await expect(page.getByTestId("bg-limits")).toContainText("wenig Licht");
    // The live preview runs MediaPipe on the GPU. Headless Chromium's software GL with phone emulation crashes
    // the renderer when the processor restarts (also without tavrn's mask smoothing), so phones only check
    // the settings here; the desktop project runs the effect.
    const phone = (page.viewportSize()?.width ?? 1280) < 768;
    const warnings: string[] = [];
    page.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
    if (!phone) {
      await page.getByTestId("camera-preview-toggle").click();
      await expect.poll(() => page.getByTestId("camera-preview").evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
      // A few seconds of frames through the mask smoothing ("high"), which falls back with a warning on failure.
      await page.waitForTimeout(3000);
      expect(warnings.filter((w) => w.includes("mask smoothing off"))).toEqual([]);
      await expect(page.getByText("background effects are not supported")).toHaveCount(0);
      // The processor replaced the camera track with its own canvas output.
      expect(await page.getByTestId("camera-preview").evaluate((v) => ((v as HTMLVideoElement).srcObject as MediaStream | null)?.getVideoTracks()[0]?.label ?? "")).not.toMatch(/fake/i);
    }
    await page.getByTestId("blur-strength").fill("20");
    await page.getByTestId("bg-quality").selectOption("fast");
    if (!phone) {
      await expect.poll(() => page.getByTestId("camera-preview").evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
      await page.getByTestId("camera-preview-toggle").click();
    }
    await page.reload();
    await expect(page.getByTestId("blur-strength")).toHaveValue("20");
    await expect(page.getByTestId("bg-quality")).toHaveValue("fast");
    expect(errors).toEqual([]);
  });
});
