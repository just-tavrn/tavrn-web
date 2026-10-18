// SPDX-License-Identifier: Apache-2.0
// Real SFU authorization, decrypted audio, late joins and hold-only controls in independent contexts.
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, hooks, inboundPeak, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);
interface WhisperState {
  whispering: string[];
  whisperedBy: Record<string, true>;
  lastWhisperer: string | null;
  remote: { identity: string; tracks: { name: string; source: string; subscribed: boolean; encrypted: boolean }[] }[];
}
const state = (page: Page): Promise<WhisperState> => page.evaluate(() => (window as unknown as { __tavrnVoice: { state(): WhisperState } }).__tavrnVoice.state());
const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));

async function hold(page: Page, address: string): Promise<() => Promise<void>> {
  const button = tile(page, address).getByTestId("whisper-hold");
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (test.info().project.name === "mobile-android") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
    return async () => { await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach(); };
  }
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return () => page.mouse.up();
}

async function recordPackets(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __whisperPackets: number; __tavrnVoice: { room: { on(e: string, cb: (data: Uint8Array, p: unknown, kind: unknown, topic: string) => void): void } } };
    w.__whisperPackets = 0;
    w.__tavrnVoice.room.on("dataReceived", (_data, _p, _kind, topic) => { if (topic === "tavrn.whisper") w.__whisperPackets++; });
  });
}

async function denyExplicitSubscription(page: Page, sender: string) {
  await expect.poll(async () => (await state(page)).remote.find((p) => p.identity === sender)?.tracks.some((p) => p.name === "whisper")).toBe(true);
  await page.evaluate((id) => {
    const room = (window as unknown as { __tavrnVoice: { room: { remoteParticipants: Map<string, { audioTrackPublications: Map<string, { trackName: string; setSubscribed(on: boolean): void }> }> } } }).__tavrnVoice.room;
    [...room.remoteParticipants.get(id)!.audioTrackPublications.values()].find((p) => p.trackName === "whisper")!.setSubscribed(true);
  }, sender);
  // This flag is changed by the SFU's permission response. UI filtering alone cannot make it pass.
  await expect.poll(() => page.evaluate((id) => {
    const room = (window as unknown as { __tavrnVoice: { room: { remoteParticipants: Map<string, { audioTrackPublications: Map<string, { trackName: string; permissionStatus: string; isSubscribed: boolean }> }> } } }).__tavrnVoice.room;
    const pub = [...room.remoteParticipants.get(id)!.audioTrackPublications.values()].find((p) => p.trackName === "whisper");
    return pub && { permission: pub.permissionStatus, subscribed: pub.isSubscribed };
  }, sender), { timeout: scaled(30_000) }).toEqual({ permission: "not_allowed", subscribed: false });
}

test("only addressed participants hear whisper; the SFU rejects outsiders and normal voice returns on release", async ({ browser, request }) => {
  test.setTimeout(scaled(300_000));
  test.skip(process.env.E2E_VOICE === "false", "LiveKit unavailable");
  const alice = await voiceUser(browser, "whali", undefined, { cuesOff: true });
  const bob = await voiceUser(browser, "whbob", undefined, { cuesOff: true });
  const carol = await voiceUser(browser, "whcar", undefined, { cuesOff: true });
  const token = await tokenOf(alice.page);
  const room = await createRoomViaApi(request, token, "Whisper");
  const roomId = room.id as string;
  const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
  const code = await inviteCode(request, token, roomId);
  for (const user of [bob, carol]) {
    const res = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(user.page)}` }, data: {} });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  for (const user of [alice, bob, carol]) {
    await user.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await expect(user.page.getByTestId("voice-join")).toBeVisible();
    if (user === carol) continue;
    await user.page.getByTestId("voice-join").click();
    await expect(user.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: scaled(30_000) });
  }
  const aliceId = (await hooks(alice.page)).local!.identity;
  const bobId = (await hooks(bob.page)).local!.identity;
  // The menu selects a destination. It must never leave an unattended transmission running.
  await tile(alice.page, bob.address).getByTestId("tile-menu-button").click();
  await alice.page.getByRole("menuitem", { name: /^Zu .* flüstern$/ }).click();
  expect((await state(alice.page)).whispering).toEqual([]);

  let first = true;
  for (const [sender, receiver, senderId, receiverId] of [[alice, bob, aliceId, bobId], [bob, alice, bobId, aliceId]] as const) {
    const release = await hold(sender.page, receiver.address);
    try {
      await expect.poll(async () => (await state(sender.page)).whispering).toEqual([receiverId]);
      await expect.poll(async () => (await state(receiver.page)).whisperedBy[senderId]).toBe(true);
      await expect.poll(() => inboundPeak(receiver.page, senderId), { timeout: scaled(30_000) }).toBeGreaterThan(0.05);
      const remote = (await state(receiver.page)).remote.find((p) => p.identity === senderId)!;
      expect(remote.tracks.find((p) => p.name === "whisper")).toMatchObject({ subscribed: true, encrypted: true });
      if (first) {
        // A DOM click avoids stealing the sender's focus: blur intentionally cancels a real hold.
        await carol.page.getByTestId("voice-join").evaluate((button: HTMLButtonElement) => button.click());
        await expect(carol.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: scaled(30_000) });
        await hooks(carol.page);
        await recordPackets(carol.page);
        // A new ordinary publication must remain available to the late, nonrecipient participant.
        await sender.page.getByTestId("voice-camera").evaluate((button: HTMLButtonElement) => button.click());
        await expect.poll(async () => (await state(carol.page)).remote.find((p) => p.identity === senderId)?.tracks.some((p) => p.source === "camera" && p.subscribed && p.encrypted)).toBe(true);
        first = false;
      }
      await denyExplicitSubscription(carol.page, senderId);
      expect((await state(carol.page)).whisperedBy).toEqual({});
      expect((await state(carol.page)).lastWhisperer).toBeNull();
      expect(await inboundPeak(carol.page, senderId)).toBeLessThan(0.005);
      await test.info().attach(`whisper-${sender.username}-${test.info().project.name}`, { body: await sender.page.screenshot(), contentType: "image/png" });
    } finally { await release(); }
    await expect.poll(async () => (await state(receiver.page)).whisperedBy).toEqual({});
    await expect.poll(() => inboundPeak(carol.page, senderId), { timeout: scaled(30_000) }).toBeGreaterThan(0.05);
    expect((await state(receiver.page)).lastWhisperer).toBe(senderId);
  }
  expect(await carol.page.evaluate(() => (window as unknown as { __whisperPackets: number }).__whisperPackets)).toBe(0);
  await bob.page.getByTestId("voice-leave").click();
  await expect.poll(async () => (await state(alice.page)).lastWhisperer).toBeNull();
});
