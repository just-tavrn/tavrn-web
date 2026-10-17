// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { joinRoom } from "./menu-helpers";

/** Top edge of the last message row and the list's scroll position: both must stay put while the composer grows. */
async function lastRow(page: Page) {
  const box = await page.getByTestId("message").last().boundingBox();
  const scrollTop = await page.getByTestId("message-list").evaluate((el) => el.scrollTop);
  return { y: Math.round(box!.y), scrollTop: Math.round(scrollTop) };
}

const LONG = Array.from({ length: 14 }, (_, i) => `Zeile ${i + 1} eines längeren Textes`).join("\n");

// design note 4.13 item 14: the focused composer grows as an overlay (no reflow of the message list),
// up to 40 % of the viewport, and collapses on blur, Escape and send; phones keep the single line.
test("The input field grows as an overlay while typing and shrinks after sending", async ({ page, request }) => {
  const account = await registerViaApi(request, "grow");
  const room = await createRoomViaApi(request, account.token, "Wachstum");
  await loginAs(page, account);
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");

  const box = page.getByLabel("Nachricht", { exact: true });
  for (let i = 1; i <= 8; i++) {
    await box.fill(`Nachricht ${i}`);
    await box.press("Enter");
    await expect(page.getByTestId("message").filter({ hasText: `Nachricht ${i}` })).toBeVisible();
  }
  const composer = page.getByTestId("composer");
  await box.click();
  await expect(composer).not.toHaveAttribute("data-expanded");
  const before = await lastRow(page);
  const collapsed = (await box.boundingBox())!.height;

  await box.fill(LONG);
  const phone = (page.viewportSize()?.width ?? 0) < 640;
  if (phone) {
    // The on-screen keyboard takes the space: no overlay, the input keeps its single line.
    await expect(composer).not.toHaveAttribute("data-expanded");
    expect((await box.boundingBox())!.height).toBeLessThanOrEqual(collapsed + 1);
    expect(await lastRow(page)).toEqual(before);
  } else {
    await expect(composer).toHaveAttribute("data-expanded", "true");
    await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(collapsed * 4);
    // Capped at 40 % of the viewport (text plus toolbar), with an internal scrollbar for the rest.
    const viewport = page.viewportSize()!.height;
    const panel = (await page.getByTestId("composer-panel").boundingBox())!;
    expect(panel.height).toBeLessThanOrEqual(viewport * 0.4 + 1);
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // The message list neither reflowed nor scrolled; the overlay floats above its last rows.
    expect(await lastRow(page)).toEqual(before);

    // The emoji picker (portaled popup) counts as inside: the composer stays expanded.
    await page.getByRole("button", { name: "Emoji einfügen" }).click();
    await expect(page.getByTestId("emoji-picker")).toBeVisible();
    await expect(composer).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);

    // Escape collapses, the next change grows again; blur collapses as well.
    await box.focus();
    await expect(composer).toHaveAttribute("data-expanded", "true");
    await box.press("Escape");
    await expect(composer).not.toHaveAttribute("data-expanded");
    await box.press("End");
    await box.pressSequentially("!");
    await expect(composer).toHaveAttribute("data-expanded", "true");
    await page.getByTestId("channel-name").click();
    await expect(composer).not.toHaveAttribute("data-expanded");
    expect(await lastRow(page)).toEqual(before);
    await box.focus();
    await expect(composer).toHaveAttribute("data-expanded", "true");
  }

  await box.press("Enter");
  await expect(page.getByTestId("message").filter({ hasText: "Zeile 14 eines längeren Textes" })).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(composer).not.toHaveAttribute("data-expanded");
  await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThanOrEqual(collapsed + 1);
});

/** A channel row of the sidebar, clicked (client-side navigation: the app keeps its memory). */
async function openChannel(page: Page, channelId: string) {
  await openNavIfMobile(page);
  await page.locator(`[data-testid="channel-row"][data-channel="${channelId}"]`).getByRole("link").click();
}

// docs/CLIENT.md "The composer": @ suggests who is in this channel, Enter picks, the mention is sent as a pill.
test("@ suggests the channel's members and inserts a mention that is sent as one", async ({ page, request }) => {
  const owner = await registerViaApi(request, "mentown");
  const member = await registerViaApi(request, "mentmem");
  const room = await createRoomViaApi(request, owner.token, "Erwähnungen");
  await joinRoom(request, owner, room.id, member);
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}`);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled();
  await box.click();
  await box.pressSequentially(`Hallo @${member.username.slice(0, 6)}`);
  const list = page.getByRole("listbox", { name: "Personen und Rollen zum Erwähnen" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option").first()).toHaveAttribute("data-key", `${member.username}@localhost`);
  await expect(box).toHaveAttribute("aria-activedescendant", (await list.getByRole("option").first().getAttribute("id"))!);
  await box.press("Enter");
  await expect(box).toHaveValue(`Hallo @${member.username} `);
  await expect(list).toHaveCount(0);
  // Escape leaves a typed @ alone; an e-mail address never opens the list.
  await box.pressSequentially("mail an x@y und @");
  await expect(list).toBeVisible();
  await box.press("Escape");
  await expect(list).toHaveCount(0);
  await box.pressSequentially("!");
  await box.press("Enter");
  const row = page.getByTestId("message").filter({ hasText: "mail an x@y" });
  await expect(row.locator('[data-mention="user"]')).toHaveText(`@${member.username}`);
});

// Unsent text per conversation, in memory while the app runs (docs/CLIENT.md "The composer").
test("unsent text stays per channel while switching to another channel and the settings", async ({ page, request }) => {
  const owner = await registerViaApi(request, "draft");
  const room = await createRoomViaApi(request, owner.token, "Entwürfe");
  const first = room.channels.find((c: { kind: string }) => c.kind === "text") as { id: string };
  const second = await (
    await request.post(`${NODE}/api/v1/rooms/${room.id}/channels`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { kind: "text", name: "zweiter", encrypted: false } })
  ).json();
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/channels/${first.id}`);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled();
  await box.fill("halb geschrieben im ersten");
  await openChannel(page, second.id);
  await expect(page.getByTestId("channel-name")).toHaveText("zweiter");
  await expect(box).toHaveValue("");
  await box.fill("im zweiten");
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Benutzereinstellungen" }).click();
  await expect(page).toHaveURL(/\/settings/);
  await page.goBack();
  await expect(page.getByTestId("channel-name")).toHaveText("zweiter");
  await expect(box).toHaveValue("im zweiten");
  await openChannel(page, first.id);
  await expect(box).toHaveValue("halb geschrieben im ersten");
  // Sending clears it; a reload (a closed app) keeps nothing.
  await box.press("Enter");
  await expect(page.getByTestId("message").filter({ hasText: "halb geschrieben im ersten" })).toBeVisible();
  await openChannel(page, second.id);
  await openChannel(page, first.id);
  await expect(box).toHaveValue("");
  await page.reload();
  await openChannel(page, second.id);
  await expect(box).toHaveValue("");
});

// The formatting bar and the styled input (docs/CLIENT.md "The composer").
test("the formatting bar wraps the selection and the styled input shows the formats in place", async ({ page, request }) => {
  const owner = await registerViaApi(request, "format");
  const room = await createRoomViaApi(request, owner.token, "Formate");
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}`);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled();
  const toggle = page.getByTestId("composer-format-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const bar = page.getByRole("toolbar", { name: "Formatierung" });
  await expect(bar).toBeVisible();
  await box.fill("ganz wichtig");
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 12));
  await bar.getByTestId("format-bold").click();
  await expect(box).toHaveValue("ganz **wichtig**");
  await expect(box).toBeFocused();
  // Ctrl+Z undoes the step.
  await box.press("Control+z");
  await expect(box).toHaveValue("ganz wichtig");
  await box.press("Control+Shift+z");
  await expect(box).toHaveValue("ganz **wichtig**");
  // Styled input: the layer behind the textarea has the same text and the same box (the caret aligns).
  await bar.getByTestId("format-styled").click();
  const layer = page.getByTestId("styled-layer");
  await expect(layer).toHaveText("ganz **wichtig**");
  const [a, b] = [await box.boundingBox(), await layer.boundingBox()];
  expect(b).toEqual(a);
  await box.press("End");
  await box.pressSequentially(" und `code`");
  await box.press("Shift+Enter");
  await box.pressSequentially("> zitat");
  expect(await layer.evaluate((el) => el.textContent)).toBe(await box.inputValue());
  await expect(layer.locator(".cs-bold")).toHaveText("wichtig");
  await box.press("Enter");
  const row = page.getByTestId("message").filter({ hasText: "ganz" });
  await expect(row.locator("strong")).toHaveText("wichtig");
  // The choices are remembered on this device.
  await page.reload();
  await expect(page.getByTestId("composer-format-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("format-styled")).toHaveAttribute("aria-pressed", "true");
});

