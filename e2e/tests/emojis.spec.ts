// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, registerViaApi, type Account } from "./helpers";
import { expectInsideViewport, isTouch } from "./menu-helpers";

/**
 * Feature round 3 (design note 4.13 items 4 and 5): the emoji picker, personal emojis and sounds with the external
 * permission gates, sound emojis, spoilers (text and attachments) and code blocks.
 */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A short 16-bit mono WAV (a quiet tone). */
function wav(ms = 400, rate = 8000): Buffer {
  const frames = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 3000), 44 + i * 2);
  return buf;
}

const auth = (a: Account) => ({ Authorization: `Bearer ${a.token}` });

async function openRoom(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await box.fill(text);
  await box.press("Enter");
}

async function personalEmoji(request: APIRequestContext, a: Account, name: string) {
  const resp = await request.post(`${NODE}/api/v1/users/me/emojis`, { headers: { ...auth(a), "Content-Type": "image/png", "Tavrn-Emoji-Name": name }, data: PNG });
  expect(resp.status(), await resp.text()).toBe(201);
  return (await resp.json()) as { id: string };
}

test.describe("Emojis, sounds and formatting (design note 4.13)", () => {
  test("picker: search in German, skin tone, insert into the message, quick reactions stay", async ({ page, request }) => {
    const owner = await registerViaApi(request, "pick");
    const room = await createRoomViaApi(request, owner.token, "Picker-Raum");
    await loginAs(page, owner);
    await openRoom(page, room.id);
    await page.getByRole("button", { name: "Emoji einfügen" }).click();
    const picker = page.getByTestId("emoji-picker");
    await expect(picker.getByRole("group", { name: "Smileys & Emotionen" })).toBeVisible();
    await picker.getByLabel("Hautfarbe").selectOption("3");
    await picker.getByLabel("Emojis suchen").fill("daumen hoch");
    const results = picker.getByRole("group", { name: "Suchergebnisse" });
    await results.getByRole("menuitem").first().click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue("👍🏽");
    await page.getByLabel("Nachricht", { exact: true }).press("Enter");
    const message = page.getByTestId("message").filter({ hasText: "👍🏽" });
    await expect(message).toBeVisible();

    // Reactions use the same picker; the recently used emoji is offered first.
    await message.hover();
    await message.getByRole("button", { name: "Reagieren" }).click();
    await page.getByTestId("emoji-picker").getByRole("group", { name: "Zuletzt verwendet" }).getByRole("menuitem", { name: "👍🏽" }).click();
    await expect(message.getByRole("button", { name: "👍🏽 1" })).toHaveAttribute("aria-pressed", "true");
    // Keyboard: typing in the grid jumps into the search, Escape closes.
    await message.hover();
    await message.getByRole("button", { name: "Reagieren" }).click();
    await expect(page.getByTestId("emoji-picker").getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.type("feuer");
    await expect(page.getByTestId("emoji-search")).toHaveValue("feuer");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);
  });

  test("picker: a fixed size inside the viewport, no growth when the emoji data arrives", async ({ page, request }) => {
    const owner = await registerViaApi(request, "size");
    const room = await createRoomViaApi(request, owner.token, "Größen-Raum");
    const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await request.post(`${NODE}/api/v1/conversations/${channelId}/messages`, { headers: auth(owner), data: { content: { type: "text", body: "Ganz oben" } } });
    await loginAs(page, owner);
    // Hold the lazily imported Unicode data back, so the panel is measured before and after it arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/emojibase-data/, async (route) => {
      await gate;
      await route.continue();
    });
    await openRoom(page, room.id);

    // The composer sits at the bottom: the picker opens above it, completely visible.
    await page.getByRole("button", { name: "Emoji einfügen" }).click();
    const picker = page.getByTestId("emoji-picker");
    await expectInsideViewport(page, picker);
    await expect(picker.getByText("Lade…")).toBeVisible();
    const before = (await picker.boundingBox())!;
    release();
    // All categories rendered (chunked, frame by frame): the panel kept its place and size.
    await expect(picker.getByRole("group", { name: "Flaggen" })).toBeAttached();
    await expect(picker.getByText("Lade…")).toHaveCount(0);
    const after = (await picker.boundingBox())!;
    expect(Math.round(after.height)).toBe(Math.round(before.height));
    expect(Math.round(after.y)).toBe(Math.round(before.y));
    await expectInsideViewport(page, picker);
    // The grid scrolls inside the panel; the keyboard still lands in it.
    const grid = picker.getByRole("menu");
    expect(await grid.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(picker.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    if (!isTouch()) {
      // The reaction picker of a message near the top opens below its button, also inside the viewport.
      const message = page.getByTestId("message").filter({ hasText: "Ganz oben" });
      await message.hover();
      await message.getByRole("button", { name: "Reagieren" }).click();
      await expectInsideViewport(page, picker);
      await page.keyboard.press("Escape");
    }
  });

  test("personal emoji: upload in the settings, use it in another room, greyed out without the permission", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const bob = await registerViaApi(request, "bob");
    const open = await createRoomViaApi(request, owner.token, "Offen");
    const strict = await createRoomViaApi(request, owner.token, "Streng");
    for (const r of [open, strict]) {
      const code = await inviteCode(request, owner.token, r.id);
      expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: auth(bob), data: {} })).ok()).toBe(true);
    }
    // No external emojis for @everyone in the strict room.
    const everyone = strict.roles.find((r: { is_everyone: boolean }) => r.is_everyone);
    const perms = BigInt(everyone.permissions) & ~(1n << 31n);
    expect((await request.patch(`${NODE}/api/v1/rooms/${strict.id}/roles/${everyone.id}`, { headers: auth(owner), data: { permissions: perms.toString() } })).ok()).toBe(true);

    await loginAs(page, bob);
    await page.goto("/settings/emojis");
    const form = page.getByTestId("personal-emoji-upload");
    await form.getByLabel("Name (a-z, 0-9, _)").fill("winke");
    await form.getByLabel("Bilddatei").setInputFiles({ name: "w.png", mimeType: "image/png", buffer: PNG });
    await form.getByRole("button", { name: "Emoji hinzufügen" }).click();
    await expect(page.locator('[data-testid="personal-emoji"][data-name="winke"]')).toBeVisible();
    await expect(page.getByTestId("personal-emoji-limit")).toContainText("1 von 20");

    await openRoom(page, open.id);
    await page.getByRole("button", { name: "Emoji einfügen" }).click();
    const picker = page.getByTestId("emoji-picker");
    await picker.getByRole("group", { name: "Persönlich" }).getByRole("menuitem", { name: ":winke:" }).click();
    await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue(/^<:winke:[0-9A-Z]{26}>$/);
    await page.getByLabel("Nachricht", { exact: true }).press("Enter");
    const img = page.getByTestId("message").locator("img.emoji[alt=':winke:']");
    await expect(img).toBeVisible();
    expect(await img.getAttribute("src")).toMatch(/\/api\/v1\/emojis\/[0-9A-Z]{26}\/image/);

    await openRoom(page, strict.id);
    await page.getByRole("button", { name: "Emoji einfügen" }).click();
    const denied = page.getByTestId("emoji-picker").getByRole("menuitem", { name: ":winke:" }).first();
    await expect(denied).toHaveAttribute("aria-disabled", "true");
    await expect(denied).toHaveAttribute("title", /Externe Emojis verwenden/);
    await denied.click({ force: true });
    await expect(page.getByTestId("emoji-external-note")).toBeVisible();
    await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue("");
  });

  test("personal and room sounds: upload with an emoji, edit the emoji", async ({ page, request }) => {
    const owner = await registerViaApi(request, "snd");
    const room = await createRoomViaApi(request, owner.token, "Sound-Raum");
    await loginAs(page, owner);
    await page.goto("/settings/sounds");
    const form = page.getByTestId("personal-sound-upload");
    await form.getByLabel("Name").fill("Tusch");
    await form.getByLabel("Emoji", { exact: true }).fill("🎺");
    await form.getByLabel("Audiodatei").setInputFiles({ name: "t.wav", mimeType: "audio/wav", buffer: wav() });
    await form.getByRole("button", { name: "Hochladen" }).click();
    const row = page.locator('[data-testid="personal-sound"][data-name="Tusch"]');
    await expect(row).toBeVisible();
    await expect(row.getByLabel("Emoji von Tusch")).toHaveValue("🎺");
    await row.getByLabel("Emoji von Tusch").fill("🥁");
    await row.getByTestId("sound-save").click();
    await expect.poll(async () => (await (await request.get(`${NODE}/api/v1/users/me/sounds`, { headers: auth(owner) })).json()).items[0]?.emoji).toBe("🥁");

    // Room clips: the emoji is editable in the soundboard tab.
    const clip = await request.post(`${NODE}/api/v1/rooms/${room.id}/soundboard`, { headers: { ...auth(owner), "Content-Type": "audio/wav", "Tavrn-Sound-Name": "Horn", "Tavrn-Sound-Duration-Ms": "400" }, data: wav() });
    expect(clip.status()).toBe(201);
    await page.goto(`/rooms/${room.id}/settings/soundboard`);
    const field = page.getByTestId("room-sound-emoji").getByLabel("Emoji von Horn");
    await field.fill("📣");
    await page.getByTestId("room-sound-emoji").getByTestId("sound-save").click();
    await expect.poll(async () => (await (await request.get(`${NODE}/api/v1/rooms/${room.id}/soundboard`, { headers: auth(owner) })).json())[0]?.emoji).toBe("📣");
  });

  test("spoilers: text hidden until clicked, attachment blurred until revealed", async ({ page, request }) => {
    const owner = await registerViaApi(request, "spoil");
    const room = await createRoomViaApi(request, owner.token, "Spoiler-Raum");
    await loginAs(page, owner);
    await openRoom(page, room.id);
    await send(page, "Das Ende: ||alle sterben||");
    const message = page.getByTestId("message").filter({ hasText: "Das Ende" });
    const spoiler = message.locator("span.spoiler");
    await expect(spoiler).toHaveAttribute("role", "button");
    await expect(spoiler).not.toHaveClass(/revealed/);
    await spoiler.click();
    await expect(spoiler).toHaveClass(/revealed/);

    // Composer button wraps the selection.
    const box = page.getByLabel("Nachricht", { exact: true });
    await box.fill("geheim");
    await box.selectText();
    await page.getByTestId("composer-spoiler").click();
    await expect(box).toHaveValue("||geheim||");
    await box.fill("");

    await page.getByLabel("Datei auswählen").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "pixel.png als Spoiler markieren" }).click();
    await send(page, "Bild mit Spoiler");
    const withFile = page.getByTestId("message").filter({ hasText: "Bild mit Spoiler" });
    const cover = withFile.getByTestId("attachment-spoiler");
    await expect(cover).toBeVisible();
    await expect(cover.getByTestId("spoiler-reveal")).toHaveText("Spoiler, zum Anzeigen klicken");
    await cover.getByTestId("spoiler-reveal").click();
    await expect(withFile.getByTestId("attachment-spoiler")).toHaveCount(0);
    await expect(withFile.getByTestId("attachment-image").locator("img")).toBeVisible();
  });

  test("code blocks: highlighted with a label, copy and wrap; quotes; deleted reply originals", async ({ page, request, context, browserName }) => {
    if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const owner = await registerViaApi(request, "code");
    const room = await createRoomViaApi(request, owner.token, "Code-Raum");
    await loginAs(page, owner);
    await openRoom(page, room.id);
    await send(page, "```js\nconst answer = 42;\n```");
    const block = page.getByTestId("message").locator("div.codeblock").first();
    await expect(block.locator(".codeblock-lang")).toHaveText("javascript");
    await expect(block.locator("span.hljs-keyword").first()).toHaveText("const");
    await block.getByRole("button", { name: "Code kopieren" }).click();
    await expect(page.getByText("Kopiert")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("const answer = 42;");
    const wrap = block.getByRole("button", { name: "Lange Zeilen umbrechen" });
    await wrap.click();
    await expect(wrap).toHaveAttribute("aria-pressed", "true");

    await send(page, "> zitiert\n\nnormal");
    await expect(page.getByTestId("message").locator("blockquote")).toHaveText("zitiert");

    // A reply whose original was deleted says so (never a copy).
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const base = `${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`;
    const original = await (await request.post(base, { headers: auth(owner), data: { content: { type: "text", body: "Original" } } })).json();
    await request.post(base, { headers: auth(owner), data: { content: { type: "text", body: "Antwort" }, reply_to_id: original.id } });
    await request.delete(`${base}/${original.id}`, { headers: auth(owner) });
    await page.reload();
    await expect(page.getByTestId("message").filter({ hasText: "Antwort" }).getByTestId("reply-deleted")).toHaveText("Nachricht gelöscht");
  });
});
