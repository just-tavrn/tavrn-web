// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi, registerViaUi, tokenOf } from "./helpers";
import { scaled } from "./timeouts";

// Feature round 3 (design note 4.13 items 6 and 7): metadata removal before upload, click-to-play embeds and
// sender-generated link previews. No test reaches the internet: provider thumbnails, players and the
// node's unfurl answer are served by Playwright routes.

/** 8×8 JPEG made by ffmpeg (APP0 JFIF and a COM comment). */
const BASE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCZAKp+/9k=",
  "base64",
);
/** A 64×36 PNG (provider thumbnail stand-in). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAARUlEQVR4nO3PQQkAIADAQAVza3VD+DiEXYJtjn3Gz5YOeNWA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oB2AXQ5AYsJOSlIAAAAAElFTkSuQmCC",
  "base64",
);

/** The JPEG with an EXIF APP1 segment (camera make "TestCam", orientation 1) right after SOI. */
function jpegWithExif(): Buffer {
  const tiff = Buffer.alloc(46);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8); // two IFD0 entries
  tiff.writeUInt16BE(0x010f, 10); // Make, ASCII, 8 bytes at offset 38
  tiff.writeUInt16BE(2, 12);
  tiff.writeUInt32BE(8, 14);
  tiff.writeUInt32BE(38, 18);
  tiff.writeUInt16BE(0x0112, 22); // Orientation, SHORT, 1
  tiff.writeUInt16BE(3, 24);
  tiff.writeUInt32BE(1, 26);
  tiff.writeUInt16BE(1, 30);
  tiff.writeUInt32BE(0, 34); // no next IFD
  tiff.write("TestCam\0", 38, "latin1");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), header, payload, BASE_JPEG.subarray(2)]);
}

async function openRoom(page: Page, prefix: string) {
  const request = page.request;
  const owner = await registerViaApi(request, prefix);
  const room = await createRoomViaApi(request, owner.token, `Raum ${prefix}`);
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
  return { owner, room, channel };
}

async function messagesOf(page: Page, token: string, channel: string) {
  const resp = await page.request.get(`${NODE}/api/v1/conversations/${channel}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  return (await resp.json()) as { content: Record<string, unknown>; attachments?: { id: string }[] }[];
}

test.describe("Privacy settings for content (design note 4.13)", () => {
  test("Set metadata, embeds and link previews; persists after a reload", async ({ page, request }) => {
    const user = await registerViaApi(request, "prv");
    await loginAs(page, user);
    await page.goto("/settings/privacy");
    const metadata = page.getByTestId("metadata-mode");
    await expect(metadata.getByLabel("Immer entfernen (empfohlen)")).toBeChecked();
    await metadata.getByLabel("Fragen, wenn welche gefunden werden").check();
    const embeds = page.getByTestId("embed-mode");
    await expect(embeds.getByLabel("Vorschaubild, Abspielen per Klick")).toBeChecked();
    await expect(page.getByText("übermittelt deine IP-Adresse an den Anbieter")).toBeVisible();
    await embeds.getByLabel("Aus").check();
    await expect(page.getByTestId("create-previews")).toBeChecked();
    await expect(page.getByText("Dein Heimatknoten lädt die Seite für die Vorschau und sieht dabei den Link.")).toBeVisible();
    // Previews while typing in encrypted conversations: off by default, explained, only with the general switch.
    await expect(page.getByTestId("encrypted-previews")).not.toBeChecked();
    await expect(page.getByText("Standardmäßig aus.")).toBeVisible();
    await page.getByTestId("encrypted-previews").check();
    await page.reload();
    await expect(page.getByTestId("encrypted-previews")).toBeChecked();
    await page.getByTestId("create-previews").uncheck();
    await expect(page.getByTestId("encrypted-previews")).toBeDisabled();
    await page.getByTestId("show-previews").uncheck();
    await page.reload();
    await expect(page.getByTestId("metadata-mode").getByLabel("Fragen, wenn welche gefunden werden")).toBeChecked();
    await expect(page.getByTestId("embed-mode").getByLabel("Aus")).toBeChecked();
    await expect(page.getByTestId("create-previews")).not.toBeChecked();
    await expect(page.getByTestId("show-previews")).not.toBeChecked();
  });
});

test.describe("Metadata removal before upload (design note 4.13 item 6)", () => {
  test('JPEG with EXIF: notice "Metadaten entfernt", the node receives the file without EXIF', async ({ page }) => {
    const { owner, channel } = await openRoom(page, "exif");
    await page.getByLabel("Datei auswählen").setInputFiles({ name: "urlaub.jpg", mimeType: "image/jpeg", buffer: jpegWithExif() });
    const chip = page.getByTestId("pending-uploads");
    await expect(chip).toContainText("urlaub.jpg");
    await expect(chip.getByTestId("metadata-note")).toHaveText("Metadaten entfernt");
    await page.getByLabel("Nachricht", { exact: true }).fill("Foto");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message").filter({ hasText: "Foto" }).getByTestId("attachment-image")).toBeVisible();
    const [message] = (await messagesOf(page, owner.token, channel)).filter((m) => m.attachments?.length);
    const blob = await page.request.get(`${NODE}/api/v1/blobs/${message!.attachments![0]!.id}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    const bytes = await blob.body();
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(bytes.includes(Buffer.from("TestCam"))).toBe(false);
    expect(bytes.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    expect(bytes.includes(Buffer.from("Lavc"))).toBe(false);
  });

  test('"Fragen": dialog with remove/keep', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("tavrn.privacy.content", JSON.stringify({ metadata: "ask" })));
    await openRoom(page, "ask");
    await page.getByLabel("Datei auswählen").setInputFiles({ name: "behalten.jpg", mimeType: "image/jpeg", buffer: jpegWithExif() });
    const dialog = page.getByTestId("metadata-dialog");
    await expect(dialog).toContainText("behalten.jpg enthält EXIF-Daten");
    await dialog.getByRole("button", { name: "Behalten" }).click();
    await expect(page.getByTestId("pending-uploads")).toContainText("behalten.jpg");
    await expect(page.getByTestId("metadata-note")).toHaveCount(0);

    await page.getByLabel("Datei auswählen").setInputFiles({ name: "entfernen.jpg", mimeType: "image/jpeg", buffer: jpegWithExif() });
    await page.getByTestId("metadata-dialog").getByRole("button", { name: "Entfernen" }).click();
    await expect(page.getByTestId("pending-uploads").locator("li").filter({ hasText: "entfernen.jpg" }).getByTestId("metadata-note")).toHaveText("Metadaten entfernt");
  });
});

test.describe("Embeds and link previews (design note 4.13 item 7)", () => {
  test("YouTube link: card with a thumbnail, player only after a click", async ({ page }) => {
    const thumbnails: string[] = [];
    await page.route("https://i.ytimg.com/**", (route) => {
      thumbnails.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    });
    let player = 0;
    await page.route("https://www.youtube-nocookie.com/**", (route) => {
      player++;
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>player</title><p>fake player</p>" });
    });
    await openRoom(page, "yt");
    await page.getByLabel("Nachricht", { exact: true }).fill("Schau mal https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42");
    await page.keyboard.press("Enter");
    const card = page.getByTestId("message").filter({ hasText: "Schau mal" }).getByTestId("embed-card");
    await expect(card).toHaveAttribute("data-provider", "youtube");
    await expect(card.getByTestId("embed-thumbnail")).toBeVisible();
    // The route handler records the request asynchronously: wait for it instead of reading it at once.
    await expect.poll(() => thumbnails).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]);
    await expect.poll(() => card.getByTestId("embed-thumbnail").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(player).toBe(0);
    await card.getByTestId("embed-play").click();
    const frame = card.getByTestId("embed-frame");
    await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=42");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    await expect(page.frameLocator('[data-testid="embed-frame"]').getByText("fake player")).toBeVisible();
    expect(player).toBe(1);
  });

  test("Link preview while typing, dismissable with X, and in the sent message", async ({ page }) => {
    const asked: string[] = [];
    await page.route("**/api/v1/unfurl?**", (route) => {
      const url = new URL(route.request().url()).searchParams.get("url")!;
      asked.push(url);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url, title: `Titel von ${new URL(url).pathname}`, description: "Eine Beschreibung", site: "Nachrichten", image_data_url: `data:image/png;base64,${PNG.toString("base64")}` }),
      });
    });
    const { owner, channel } = await openRoom(page, "unf");
    const input = page.getByLabel("Nachricht", { exact: true });
    await input.fill("Lesen: https://news.example/erster");
    const card = page.getByTestId("compose-preview");
    await expect(card).toContainText("Titel von /erster");
    await card.getByTestId("compose-preview-remove").click();
    await expect(card).toHaveCount(0);
    await input.fill("Lesen: https://news.example/zweiter");
    await expect(page.getByTestId("compose-preview")).toContainText("Titel von /zweiter");
    await page.keyboard.press("Enter");
    const shown = page.getByTestId("message").filter({ hasText: "Lesen:" }).getByTestId("link-preview");
    await expect(shown).toContainText("Nachrichten");
    await expect(shown.getByTestId("link-preview-title")).toHaveText("Titel von /zweiter");
    await expect(shown.getByTestId("link-preview-title")).toHaveAttribute("href", "https://news.example/zweiter");
    await expect(shown.getByTestId("link-preview-image")).toBeVisible();
    await expect(page.getByTestId("compose-preview")).toHaveCount(0);
    expect(asked).toEqual(["https://news.example/erster", "https://news.example/zweiter"]);
    // The preview travels in the content; readers never fetch.
    const [sent] = (await messagesOf(page, owner.token, channel)).filter((m) => typeof m.content.body === "string" && m.content.body.startsWith("Lesen:"));
    expect(sent!.content.preview).toMatchObject({ url: "https://news.example/zweiter", title: "Titel von /zweiter", site: "Nachrichten" });
  });

  test("Encrypted channel: no preview while typing by default; when switched on it travels encrypted inside the content", async ({ page }) => {
    test.setTimeout(scaled(90_000));
    let unfurls = 0;
    await page.route("**/api/v1/unfurl?**", (route) => {
      unfurls++;
      const url = new URL(route.request().url()).searchParams.get("url")!;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url, title: "Geheime Schlagzeile", description: "", site: "Nachrichten" }) });
    });
    await registerViaUi(page);
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Verschlusssache");
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    const input = page.getByLabel("Nachricht", { exact: true });
    // By default the link never reaches the home node while typing in an encrypted conversation.
    await input.fill("Siehe https://news.example/geheim");
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("compose-preview")).toHaveCount(0);
    expect(unfurls).toBe(0);
    // Switched on (Settings → Privacy & safety → "Fetch link previews in encrypted conversations").
    await page.evaluate(() => {
      const key = "tavrn.privacy.content";
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), encryptedPreviews: true }));
    });
    await page.reload();
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await input.fill("Siehe https://news.example/geheim");
    await expect(page.getByTestId("compose-preview")).toContainText("Geheime Schlagzeile");
    await page.keyboard.press("Enter");
    const message = page.getByTestId("message").filter({ hasText: "Siehe" });
    await expect(message.getByTestId("link-preview-title")).toHaveText("Geheime Schlagzeile");
    // The node stores ciphertext only: neither the link nor the preview is readable there.
    const channel = new URL(page.url()).pathname.split("/").at(-1)!;
    const resp = await page.request.get(`${NODE}/api/v1/conversations/${channel}/messages`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
    const stored = JSON.stringify(await resp.json());
    expect(stored).not.toContain("Geheime Schlagzeile");
    expect(stored).not.toContain("news.example");
    // After a reload the decrypted message still shows the preview.
    await page.reload();
    await expect(page.getByTestId("message").filter({ hasText: "Siehe" }).getByTestId("link-preview-title")).toHaveText("Geheime Schlagzeile", { timeout: 20_000 });
  });
});
