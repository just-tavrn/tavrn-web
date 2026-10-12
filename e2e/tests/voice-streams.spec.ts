// SPDX-License-Identifier: Apache-2.0
// Stream audio apart from voice (tavrn-web issue #20, docs/CLIENT.md "Voice channels"): a screen share with
// audio gets its own volume per streamer (tile and member menu), the voice volume stays on the microphone, and
// a watched stream stays audible while the viewer is deafened; a stream that is not on screen goes silent.
// The volumes are read from the development hooks of the voice client (the gains LiveKit's Web Audio mix
// plays each source with). Also: "hear yourself" in the voice settings is refused while in a voice channel.
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

/** Headless Chromium has no screen: a canvas capture plus an oscillator as the shared tab's audio. */
function fakeScreenWithAudio() {
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
    const stream = canvas.captureStream(10);
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 660;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]!);
    return stream;
  };
}

interface Gains {
  microphone: number | null;
  stream: number | null;
}

/** The gains Alice's client plays Bob's microphone and stream with (null: no such track yet). */
async function gainsOf(page: Page, address: string): Promise<Gains | null> {
  return page.evaluate((a) => {
    const hooks = (window as unknown as { __tavrnVoice?: { state: () => { gains: Record<string, Gains> } } }).__tavrnVoice;
    const entry = Object.entries(hooks?.state().gains ?? {}).find(([identity]) => identity.startsWith(`${a}/`));
    return entry ? entry[1] : null;
  }, address);
}

/** Client-side navigation (keeps the voice session, unlike `page.goto`). */
async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test.describe("Stream audio", () => {
  test("own stream volume, voice volume apart, a watched stream stays audible while deafened; no loopback while connected", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const alice = await voiceUser(browser, "stali");
    const bob = await voiceUser(browser, "stbob");
    await bob.page.context().addInitScript(fakeScreenWithAudio);
    const token = await tokenOf(alice.page);
    const room = await createRoomViaApi(request, token, "Kino");
    const roomId = room.id as string;
    const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
    const code = await inviteCode(request, token, roomId);
    const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(bob.page)}` }, data: {} });
    expect(join.ok(), await join.text()).toBeTruthy();
    for (const u of [alice, bob]) {
      await u.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
      await u.page.getByTestId("voice-join").click();
      await expect(u.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 30_000 });
    }

    // Bob shares his screen with audio: nothing of it plays for Alice until she joins the stream (screen shares are
    // opt-in, voice-stream-join.spec.ts); joined, her tile offers the stream volume.
    await bob.page.getByTestId("voice-screen").click();
    await bob.page.getByTestId("screen-share-start").click();
    const screen = alice.page.getByTestId("screen-tile").and(alice.page.locator(`[data-user="${bob.address}"]`));
    await expect(screen).toHaveAttribute("data-state", "available", { timeout: 30_000 });
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.stream, { timeout: 5_000 }).toBeNull();
    await screen.getByTestId("stream-join").click();
    await expect(screen).toHaveAttribute("data-audio", "true", { timeout: 30_000 });
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.stream, { timeout: 30_000 }).toBeCloseTo(1, 1);
    expect((await gainsOf(alice.page, bob.address))?.microphone).toBeCloseTo(1, 1);

    // The stream's own slider changes only the stream (stored per device like the voice volume).
    await screen.getByTestId("stream-volume-button").click();
    const slider = alice.page.getByTestId("stream-volume").getByRole("slider");
    await slider.evaluate((el: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "50");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(alice.page.getByTestId("stream-volume")).toContainText("50 %");
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.stream, { timeout: 10_000 }).toBeCloseTo(0.5, 1);
    expect((await gainsOf(alice.page, bob.address))?.microphone).toBeCloseTo(1, 1);
    expect(await alice.page.evaluate((a) => JSON.parse(localStorage.getItem("tavrn.voice.settings") ?? "{}").streamVolumes?.[a], bob.address)).toBe(50);
    await screen.getByTestId("stream-volume-button").click();
    await expect(alice.page.getByTestId("stream-volume-panel")).toHaveCount(0);

    // Bob's participant menu has the stream volume next to the voice volume while he streams.
    const bobTile = alice.page.getByTestId("voice-tile").and(alice.page.locator(`[data-user="${bob.address}"]`));
    await bobTile.getByTestId("tile-menu-button").click();
    const menu = alice.page.getByTestId("member-menu");
    await expect(menu.getByTestId("menu-volume")).toBeVisible();
    await expect(menu.getByTestId("menu-stream-volume")).toContainText("50 %", { timeout: 15_000 });
    await alice.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Deafened: Bob's voice goes silent, the stream Alice watches keeps playing (with its badge).
    await alice.page.getByTestId("voice-deafen").click();
    await expect(alice.page.getByTestId("voice-deafen")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.microphone, { timeout: 10_000 }).toBeCloseTo(0, 1);
    expect((await gainsOf(alice.page, bob.address))?.stream).toBeCloseTo(0.5, 1);
    await expect(screen.getByTestId("stream-audible")).toBeVisible();

    // Away from the stage the stream is no longer watched: silent too. The voice settings refuse "hear
    // yourself" while connected.
    await navigate(alice.page, "/settings/voice");
    await expect(alice.page.getByTestId("voice-settings")).toBeVisible();
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.stream, { timeout: 10_000 }).toBeCloseTo(0, 1);
    await expect(alice.page.getByTestId("mic-loopback")).toBeDisabled();
    await expect(alice.page.getByTestId("loopback-busy")).toBeVisible();

    // Back on the stage the stream plays again; undeafened the voice is back too.
    await navigate(alice.page, `/rooms/${roomId}/channels/${voiceId}`);
    await expect(screen).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.stream, { timeout: 10_000 }).toBeCloseTo(0.5, 1);
    await alice.page.getByTestId("voice-deafen").click();
    await expect.poll(async () => (await gainsOf(alice.page, bob.address))?.microphone, { timeout: 10_000 }).toBeCloseTo(1, 1);
    await expect(screen.getByTestId("stream-audible")).toHaveCount(0);
  });
});
