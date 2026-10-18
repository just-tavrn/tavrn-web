// SPDX-License-Identifier: Apache-2.0
// SFU isolation, targeted control, decrypted audio and restoration with three independent browser contexts.
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, hooks, inboundPeak, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);
interface WhisperState { whispering: string[]; whisperedBy: Record<string, true>; lastWhisperer: string | null; remote: { identity: string; tracks: { name: string; subscribed: boolean; encrypted: boolean }[] }[] }
async function state(page: Page): Promise<WhisperState> {
  return page.evaluate(() => (window as unknown as { __tavrnVoice: { state(): WhisperState } }).__tavrnVoice.state());
}
async function toggle(page: Page, address: string) {
  await page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`)).getByTestId("tile-menu-button").click();
  await page.getByRole("menuitem", { name: /^Zu .* flüstern$/ }).click();
}
test("only the addressed participant hears and receives whisper, then normal voice returns", async ({ browser, request }) => {
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
  for (const u of [bob, carol]) {
    const res = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(u.page)}` }, data: {} });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  for (const u of [alice, bob, carol]) {
    await u.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await u.page.getByTestId("voice-join").click();
    await expect(u.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: scaled(30_000) });
  }
  const aliceId = (await hooks(alice.page)).local!.identity;
  const bobId = (await hooks(bob.page)).local!.identity;
  // Record packets at the SDK boundary: Carol must receive neither start nor end, including recipient names.
  await carol.page.evaluate(() => {
    const w = window as unknown as { __whisperPackets: number; __tavrnVoice: { room: { on(e: string, cb: (data: Uint8Array, p: unknown, kind: unknown, topic: string) => void): void } } };
    w.__whisperPackets = 0;
    w.__tavrnVoice.room.on("dataReceived", (_data, _p, _kind, topic) => { if (topic === "tavrn.whisper") w.__whisperPackets++; });
  });
  for (const [sender, receiver, senderId, receiverId] of [[alice, bob, aliceId, bobId], [bob, alice, bobId, aliceId]] as const) {
    await toggle(sender.page, receiver.address);
    await expect.poll(async () => (await state(sender.page)).whispering).toEqual([receiverId]);
    await expect.poll(async () => (await state(receiver.page)).whisperedBy[senderId]).toBe(true);
    await expect.poll(() => inboundPeak(receiver.page, senderId), { timeout: scaled(30_000) }).toBeGreaterThan(0.05);
    const remote = (await state(receiver.page)).remote.find((p) => p.identity === senderId)!;
    expect(remote.tracks.find((t) => t.name === "whisper")).toMatchObject({ subscribed: true, encrypted: true });
    expect((await state(carol.page)).whisperedBy).toEqual({});
    expect((await state(carol.page)).lastWhisperer).toBeNull();
    expect((await state(carol.page)).remote.find((p) => p.identity === senderId)?.tracks.find((t) => t.name === "whisper")?.subscribed ?? false).toBe(false);
    expect(await inboundPeak(carol.page, senderId)).toBeLessThan(0.005);
    await toggle(sender.page, receiver.address);
    await expect.poll(async () => (await state(receiver.page)).whisperedBy).toEqual({});
    await expect.poll(() => inboundPeak(carol.page, senderId), { timeout: scaled(30_000) }).toBeGreaterThan(0.05);
    expect((await state(receiver.page)).lastWhisperer).toBe(senderId);
  }
  expect(await carol.page.evaluate(() => (window as unknown as { __whisperPackets: number }).__whisperPackets)).toBe(0);
  await bob.page.getByTestId("voice-leave").click();
  await expect.poll(async () => (await state(alice.page)).lastWhisperer).toBeNull();
});
