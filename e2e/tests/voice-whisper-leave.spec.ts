// SPDX-License-Identifier: Apache-2.0
// A recipient leaving mid-whisper ends the whisper, not the sender's voice connection (VOICE.md §4d grace period).
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, hooks, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);
const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));
const whispering = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __tavrnVoice: { state(): { whispering: string[] } } }).__tavrnVoice.state().whispering);

test("the sender stays connected when a recipient leaves during a whisper", async ({ browser, request }) => {
  test.setTimeout(scaled(240_000));
  test.skip(process.env.E2E_VOICE === "false", "LiveKit unavailable");
  const alice = await voiceUser(browser, "wlali", undefined, { cuesOff: true });
  const bob = await voiceUser(browser, "wlbob", undefined, { cuesOff: true });
  const token = await tokenOf(alice.page);
  const room = await createRoomViaApi(request, token, "Whisper leave");
  const roomId = room.id as string;
  const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
  const code = await inviteCode(request, token, roomId);
  const res = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(bob.page)}` }, data: {} });
  expect(res.ok(), await res.text()).toBeTruthy();
  for (const user of [alice, bob]) {
    await user.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await user.page.getByTestId("voice-join").click();
    await expect(user.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: scaled(30_000) });
  }
  const hold = tile(alice.page, bob.address).getByTestId("whisper-hold");
  await expect(hold).toBeEnabled({ timeout: scaled(30_000) });
  await hooks(alice.page);
  const box = (await hold.boundingBox())!;
  await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await alice.page.mouse.down();
  await expect(bob.page.getByTestId("whisper-indicator")).toBeVisible({ timeout: scaled(30_000) });
  await expect.poll(() => whispering(alice.page)).toHaveLength(1);
  // Alice keeps holding while Bob leaves; the node hides the whisper and Alice's client ends it itself.
  const sid = await alice.page.evaluate(() => (window as unknown as { __tavrnVoice: { room: { localParticipant: { sid: string } } } }).__tavrnVoice.room.localParticipant.sid);
  await bob.page.getByTestId("voice-bar-leave").evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => whispering(alice.page), { timeout: scaled(15_000) }).toEqual([]);
  // Well past the node's grace period: the same SFU participant, never reconnecting.
  const seen = new Set<string>();
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    seen.add((await alice.page.getByTestId("voice-bar").getAttribute("data-status")) ?? "none");
    await alice.page.waitForTimeout(200);
  }
  expect([...seen]).toEqual(["connected"]);
  expect(await alice.page.evaluate(() => (window as unknown as { __tavrnVoice: { room: { localParticipant: { sid: string } } } }).__tavrnVoice.room.localParticipant.sid)).toBe(sid);
  await alice.page.mouse.up();
  await expect(alice.page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected");
});
