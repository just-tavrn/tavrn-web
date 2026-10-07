// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { NODE, type Account } from "./helpers";

/** Phones and tablets in the touch projects. */
export function isTouch(): boolean {
  return !!test.info().project.use.hasTouch;
}

/** A long press (≥ 500 ms without moving) through the DevTools protocol (Chromium only). */
export async function longPress(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("long press: element not visible");
  const x = box.x + Math.min(box.width / 2, 40);
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Opens the context menu of `target`: right-click with a mouse, long press on touch devices. */
export async function openContextMenu(page: Page, target: Locator) {
  if (isTouch()) await longPress(page, target);
  else await target.click({ button: "right", position: { x: 12, y: 12 } });
}

/** The member list is a drawer below 1280 px. */
export async function openMembers(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) !== "true") await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function joinRoom(request: APIRequestContext, owner: Account, roomId: string, member: Account) {
  const inv = await request.post(`${NODE}/api/v1/rooms/${roomId}/invites`, { headers: auth(owner.token), data: {} });
  const code = (await inv.json()).code as string;
  const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: auth(member.token), data: {} });
  expect(join.ok()).toBeTruthy();
}

export async function createRole(request: APIRequestContext, owner: Account, roomId: string, data: { name: string; hoist?: boolean; position?: number; permissions?: string }) {
  const resp = await request.post(`${NODE}/api/v1/rooms/${roomId}/roles`, { headers: auth(owner.token), data: { permissions: "0", ...data } });
  if (!resp.ok()) throw new Error(`role: ${resp.status()} ${await resp.text()}`);
  return (await resp.json()) as { id: string; name: string; position: number };
}

export async function setRoles(request: APIRequestContext, owner: Account, roomId: string, userId: string, roles: string[]) {
  const resp = await request.patch(`${NODE}/api/v1/rooms/${roomId}/members/${userId}`, { headers: auth(owner.token), data: { roles } });
  if (!resp.ok()) throw new Error(`member roles: ${resp.status()} ${await resp.text()}`);
}

export async function memberRoles(request: APIRequestContext, token: string, roomId: string, userId: string): Promise<string[]> {
  const resp = await request.get(`${NODE}/api/v1/rooms/${roomId}/members`, { headers: auth(token) });
  const list = (await resp.json()) as { user: { id: string }; roles: string[] }[];
  return list.find((m) => m.user.id === userId)?.roles ?? [];
}

export async function postMessage(request: APIRequestContext, token: string, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const resp = await request.post(`${NODE}/api/v1/conversations/${conversationId}/messages`, { headers: auth(token), data: { content: { type: "text", body }, ...extra } });
  if (!resp.ok()) throw new Error(`message: ${resp.status()} ${await resp.text()}`);
  return (await resp.json()) as { id: string };
}

/** Uploads a plaintext attachment and sends it in a message. */
export async function postAttachment(request: APIRequestContext, token: string, conversationId: string, file: { name: string; mime: string; buffer: Buffer }, body = "") {
  const up = await request.post(`${NODE}/api/v1/conversations/${conversationId}/uploads`, {
    headers: { ...auth(token), "Content-Type": file.mime, "Tavrn-File-Name": encodeURIComponent(file.name) },
    data: file.buffer,
  });
  if (!up.ok()) throw new Error(`upload: ${up.status()} ${await up.text()}`);
  const attachment = (await up.json()) as { id: string };
  return postMessage(request, token, conversationId, body || "📎", { attachments: [attachment.id] });
}

/** Is the element's box completely inside the viewport? */
export async function expectInsideViewport(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  // Wait for the placement (the card is measured, then placed).
  await expect.poll(async () => (await target.evaluate((el) => getComputedStyle(el).visibility)) === "visible").toBe(true);
  const box = (await target.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
}
