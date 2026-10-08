// SPDX-License-Identifier: Apache-2.0
// Voice channel quality (tavrn-protocol/VOICE.md §4a): an owner picks a preset in the channel settings, the voice
// panel shows it, and the microphone is captured and published with it (bitrate, in-band FEC negotiated, music
// mode without microphone processing and stereo only for a two-channel capture). Checked through Chromium's
// RTCRtpSender of the published microphone (`window.__tavrnVoice`, development builds only).
import { expect, test, type Page } from "@playwright/test";
import { createRoomViaApi, openNavIfMobile, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, hooks, voiceUser } from "./voice-helpers";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

/** Records the audio constraints of every `getUserMedia` call and the channel count the device delivered. */
function recordCaptures() {
  const w = window as unknown as { __captures: { constraints: unknown; channelCount?: number }[] };
  w.__captures = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
    const stream = await original(c);
    if (c?.audio) w.__captures.push({ constraints: c.audio, channelCount: stream.getAudioTracks()[0]?.getSettings().channelCount });
    return stream;
  };
}

interface Sent {
  maxBitrate?: number;
  fmtp: string;
}

/** Bitrate and negotiated Opus parameters of the published microphone. */
async function sent(page: Page): Promise<Sent | null> {
  return page.evaluate(() => {
    const room = (window as unknown as { __tavrnVoice?: { room: { localParticipant: { getTrackPublication: (s: string) => { track?: { sender?: RTCRtpSender } } | undefined } } } }).__tavrnVoice?.room;
    const sender = room?.localParticipant.getTrackPublication("microphone")?.track?.sender;
    if (!sender) return null;
    const p = sender.getParameters();
    const opus = p.codecs?.find((c) => c.mimeType.toLowerCase() === "audio/opus");
    return { maxBitrate: p.encodings?.[0]?.maxBitrate, fmtp: opus?.sdpFmtpLine ?? "" };
  });
}

async function choosePreset(page: Page, roomId: string, channelId: string, preset: string) {
  await page.goto(`/rooms/${roomId}/settings/channels?channel=${channelId}`);
  const editor = page.getByTestId("channel-editor");
  await expect(editor.getByText("Sprachqualität", { exact: true })).toBeVisible();
  await editor.getByTestId(`quality-preset-${preset}`).check();
  await editor.getByTestId("voice-quality-save").click();
  await expect(page.getByRole("status").filter({ hasText: "Channel gespeichert" })).toBeVisible();
  await expect(editor.getByTestId(`quality-preset-${preset}`)).toBeChecked();
}

async function join(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
  await hooks(page);
  // The voice bar sits at the bottom of the channel list (the drawer on phones).
  await openNavIfMobile(page);
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected", { timeout: 30_000 });
}

test("an owner picks a quality preset; the voice panel shows it and the microphone publishes with it", async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await voiceUser(browser, "vq");
  const page = owner.page;
  await page.context().addInitScript(recordCaptures);
  const room = await createRoomViaApi(page.request, await tokenOf(page), "Proberaum");
  const voice = room.channels.find((c: { kind: string }) => c.kind === "voice") as { id: string };

  // New channels start at High (64 kbps); the default node allows every preset up to Music.
  await page.goto(`/rooms/${room.id}/settings/channels?channel=${voice.id}`);
  const editor = page.getByTestId("channel-editor");
  await expect(editor.getByTestId("quality-preset-high")).toBeChecked();
  await expect(editor.getByTestId("quality-preset-music")).toBeEnabled();
  await choosePreset(page, room.id, voice.id, "studio");

  await join(page, room.id);
  const badge = page.getByTestId("voice-quality");
  await expect(badge).toContainText("Studio");
  await expect(badge).toHaveAttribute("title", "Sprachqualität: Studio, Opus 128 kbit/s");
  await expect.poll(() => sent(page), { timeout: 30_000 }).toMatchObject({ maxBitrate: 128_000 });
  // Opus in-band FEC is negotiated by the node's media server (limits.audio_fec).
  expect((await sent(page))!.fmtp).toContain("useinbandfec=1");
  // Speech keeps the user's processing and a mono capture.
  const speech = await page.evaluate(() => (window as unknown as { __captures: { constraints: MediaTrackConstraints }[] }).__captures.at(-1)!.constraints);
  expect(speech).toMatchObject({ echoCancellation: true, channelCount: 1 });
  await page.getByTestId("voice-bar-leave").click();
  await expect(page.getByTestId("voice-bar")).toHaveCount(0);

  // Music: stereo at 192 kbps, microphone processing off; the fake microphone decides mono or stereo.
  await choosePreset(page, room.id, voice.id, "music");
  await expect(page.getByTestId("channel-editor").getByText(/Musikmodus: Stereo/)).toBeVisible();
  await join(page, room.id);
  await expect(badge).toContainText("Musik");
  await expect(badge).toHaveAttribute("title", /Opus 192 kbit\/s, Stereo, etwa 86 MB pro Stunde/);
  await expect.poll(() => sent(page), { timeout: 30_000 }).toMatchObject({ maxBitrate: 192_000 });
  const music = await page.evaluate(() => (window as unknown as { __captures: { constraints: MediaTrackConstraints; channelCount?: number }[] }).__captures.at(-1)!);
  expect(music.constraints).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } });
  // Stereo Opus only for a two-channel capture: a mono microphone is published as mono.
  const fmtp = (await sent(page))!.fmtp;
  if (music.channelCount === 2) expect(fmtp).toContain("stereo=1");
  else expect(fmtp).not.toMatch(/(^|;)\s*stereo=1/);
});
