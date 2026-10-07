// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import { createRoomViaApi, loginAs, registerViaApi } from "./helpers";

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
