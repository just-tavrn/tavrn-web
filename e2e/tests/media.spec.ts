// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";
import { joinRoom, postAttachment } from "./menu-helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A short WAV file (16-bit PCM mono, 8 kHz): a quiet 440 Hz tone, the "fake audio" fixture. */
function wav(seconds = 1.5): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), 44 + i * 2);
  return buf;
}

test.describe("Media in the chat (design note 4.11)", () => {
  test("Images open the viewer (browse, zoom, close), the download only comes via the icon", async ({ page, request }) => {
    const owner = await registerViaApi(request, "media");
    const room = await createRoomViaApi(request, owner.token, "Bilder-Raum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await postAttachment(request, owner.token, channelId, { name: "pixel.png", mime: "image/png", buffer: PNG }, "Screenshot");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    const message = page.getByTestId("message").filter({ hasText: "Screenshot" });
    const image = message.getByTestId("attachment-image").locator("img");
    await expect(image).toBeVisible();

    // A plain click opens the viewer and downloads nothing.
    let downloads = 0;
    page.on("download", () => downloads++);
    await image.click();
    const viewer = page.getByTestId("media-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("viewer-image")).toBeVisible();
    expect(downloads).toBe(0);

    await viewer.getByRole("button", { name: "Vergrößern" }).click();
    await expect(viewer.getByTestId("viewer-zoom")).toHaveText("125 %");

    const download = page.waitForEvent("download");
    await viewer.getByTestId("attachment-download").click();
    expect((await download).suggestedFilename()).toBe("pixel.png");

    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    // A click on the backdrop closes as well.
    await image.click();
    await expect(viewer).toBeVisible();
    await viewer.getByTestId("viewer-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(viewer).toHaveCount(0);
  });

  test("Audio attachments play in the inline player", async ({ page, request }) => {
    const owner = await registerViaApi(request, "audio");
    const room = await createRoomViaApi(request, owner.token, "Audio-Raum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await postAttachment(request, owner.token, channelId, { name: "ansage.wav", mime: "audio/wav", buffer: wav() }, "Hört mal");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    const player = page.getByTestId("message").filter({ hasText: "Hört mal" }).getByTestId("audio-player");
    await expect(player).toBeVisible();
    // Nothing is loaded before the user presses play.
    await expect(player.getByTestId("audio-element")).toHaveCount(0);
    await player.getByTestId("audio-play").click();
    await expect(player).toHaveAttribute("data-playing", "true");
    await expect(player.getByTestId("audio-time")).toContainText("0:01");
    await expect.poll(() => player.getByTestId("audio-element").evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
    await expect(player.getByTestId("attachment-download")).toBeVisible();
  });
});

test.describe("Automatic image previews (design note 4.12)", () => {
  test('With "Nie" a placeholder appears, "Laden" loads the image; the setting is stored on the node', async ({ page, request }) => {
    const owner = await registerViaApi(request, "never");
    const room = await createRoomViaApi(request, owner.token, "Vorschau-Raum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await postAttachment(request, owner.token, channelId, { name: "pixel.png", mime: "image/png", buffer: PNG }, "Mein Bild");
    await loginAs(page, owner);
    await page.goto("/settings/privacy");
    const radios = page.getByTestId("auto-preview");
    await expect(radios.getByLabel("Von Freunden und Mitgliedern gemeinsamer Räume")).toBeChecked();
    await radios.getByLabel("Nie", { exact: true }).check();
    await expect(radios.getByLabel("Nie", { exact: true })).toBeChecked();
    await expect(page.getByTestId("auto-preview-cap")).toContainText("5.0 MB");
    await expect
      .poll(async () => (await (await request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()).auto_preview)
      .toBe("never");

    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    const message = page.getByTestId("message").filter({ hasText: "Mein Bild" });
    const placeholder = message.getByTestId("preview-placeholder");
    await expect(placeholder).toContainText("pixel.png");
    await expect(placeholder).toContainText(`${PNG.length} B`);
    await expect(message.getByTestId("attachment-image")).toHaveCount(0);
    await placeholder.getByTestId("preview-load").click();
    await expect(message.getByTestId("attachment-image").locator("img")).toBeVisible();
    await expect(message.getByTestId("preview-placeholder")).toHaveCount(0);

    // After a reload the setting holds (from the node and the local mirror).
    await page.reload();
    await expect(page.getByTestId("message").filter({ hasText: "Mein Bild" }).getByTestId("preview-placeholder")).toBeVisible();
  });

  test("Default: images from room members load automatically, oversized ones show a placeholder", async ({ page, request }) => {
    const owner = await registerViaApi(request, "prevown");
    const bob = await registerViaApi(request, "prevbob");
    const room = await createRoomViaApi(request, owner.token, "Mitglieder-Raum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await joinRoom(request, owner, room.id, bob);
    await postAttachment(request, bob.token, channelId, { name: "klein.png", mime: "image/png", buffer: PNG }, "Kleines Bild");
    // Just over the node's default cap of 5 MiB (TAVRN_PREVIEW_AUTO_MAX_BYTES).
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - PNG.length)]);
    await postAttachment(request, bob.token, channelId, { name: "riesig.png", mime: "image/png", buffer: big }, "Großes Bild");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${channelId}`);
    const small = page.getByTestId("message").filter({ hasText: "Kleines Bild" });
    await expect(small.getByTestId("attachment-image").locator("img")).toBeVisible();
    await expect(small.getByTestId("preview-placeholder")).toHaveCount(0);
    const large = page.getByTestId("message").filter({ hasText: "Großes Bild" });
    await expect(large.getByTestId("preview-placeholder")).toContainText("riesig.png");
    await expect(large.getByTestId("preview-placeholder")).toContainText("5.0 MB");
    await expect(large.getByTestId("attachment-image")).toHaveCount(0);
  });
});
