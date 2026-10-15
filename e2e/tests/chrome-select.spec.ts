// SPDX-License-Identifier: Apache-2.0
// No text selection on the app chrome (docs/CLIENT.md "UI conventions", tavrn-web#186): a mouse press on the room
// rail dragged across the channel sidebar and the channel header selects nothing; a drag inside a message selects its
// text. Mouse only (Chromium): touch devices select by long press, which opens the menus here.
import { expect, test, type Page } from "@playwright/test";
import { createRoomViaApi, loginAs, message, registerViaApi } from "./helpers";
import { postMessage } from "./menu-helpers";

const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");

test("a drag across the rail, the sidebar and the header selects nothing; a drag in a message selects its text", async ({ page, request }, info) => {
  test.skip(info.project.name !== "chromium", "mouse selection on the desktop layout");
  const owner = await registerViaApi(request, "sel");
  const room = await createRoomViaApi(request, owner.token, "Auswahl");
  const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
  const text = "Diesen Satz darf man kopieren";
  await postMessage(request, owner.token, channelId, text);

  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/channels/${channelId}`);
  const body = message(page, text).locator(".markdown");
  await expect(body).toHaveText(text);

  // From the empty end of the rail (no draggable room there) across the channel list to the channel header.
  const start = await page.getByTestId("rail-end").boundingBox();
  const sidebar = await page.getByRole("complementary", { name: "Channels" }).boundingBox();
  const header = await page.getByTestId("channel-name").boundingBox();
  expect(start && sidebar && header).toBeTruthy();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(sidebar!.x + sidebar!.width / 2, sidebar!.y + sidebar!.height / 3, { steps: 10 });
  await page.mouse.move(sidebar!.x + sidebar!.width / 2, sidebar!.y + 20, { steps: 10 });
  await page.mouse.move(header!.x + header!.width + 40, header!.y + header!.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(await selection(page)).toBe("");

  // Inside the message: from the first character to just past the last one (the text's own box, so the drag never
  // reaches the row's hover toolbar).
  const line = await body.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { left: r.left, right: r.right, y: r.top + r.height / 2 };
  });
  await page.mouse.move(line.left + 1, line.y);
  await page.mouse.down();
  await page.mouse.move(line.right + 2, line.y, { steps: 10 });
  await page.mouse.up();
  expect((await selection(page)).trim()).toBe(text);
});
