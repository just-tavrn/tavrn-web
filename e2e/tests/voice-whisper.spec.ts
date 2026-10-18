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
  await expect.poll(async () => (await state(page)).remote.find((p) => p.identity === sender)?.tracks.some((p) => p.name.startsWith("whisper:"))).toBe(true);
  await page.evaluate((id) => {
    const room = (window as unknown as { __tavrnVoice: { room: { remoteParticipants: Map<string, { audioTrackPublications: Map<string, { trackName: string; setSubscribed(on: boolean): void }> }> } } }).__tavrnVoice.room;
    [...room.remoteParticipants.get(id)!.audioTrackPublications.values()].find((p) => p.trackName.startsWith("whisper:"))!.setSubscribed(true);
  }, sender);
  // This flag is changed by the SFU's permission response. UI filtering alone cannot make it pass.
  await expect.poll(() => page.evaluate((id) => {
    const room = (window as unknown as { __tavrnVoice: { room: { remoteParticipants: Map<string, { audioTrackPublications: Map<string, { trackName: string; permissionStatus: string; isSubscribed: boolean }> }> } } }).__tavrnVoice.room;
    const pub = [...room.remoteParticipants.get(id)!.audioTrackPublications.values()].find((p) => p.trackName.startsWith("whisper:"));
    return pub && { permission: pub.permissionStatus, subscribed: pub.isSubscribed };
  }, sender), { timeout: scaled(30_000) }).toEqual({ permission: "not_allowed", subscribed: false });
}

test("only addressed participants hear whisper; the SFU rejects outsiders and normal voice returns on release", async ({ browser, request }) => {
  test.setTimeout(scaled(300_000));
  test.skip(process.env.E2E_VOICE === "false", "LiveKit unavailable");
  const errors: string[] = [];
  const alice = await voiceUser(browser, "whali", errors, { cuesOff: true });
  const bob = await voiceUser(browser, "whbob", errors, { cuesOff: true, hotkeys: { whisper_reply: "KeyR" } });
  const carol = await voiceUser(browser, "whcar", errors, { cuesOff: true });
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
  // A signal-only reconnect must retire old capabilities and still allow a new authorized whisper.
  for (const user of [alice, bob]) {
    const previousSid = await user.page.evaluate(() => (window as unknown as { __tavrnVoice: { room: { localParticipant: { sid: string } } } }).__tavrnVoice.room.localParticipant.sid);
    await user.page.evaluate(async () => {
      const room = (window as unknown as { __tavrnVoice: { room: { once(event: string, done: () => void): void; simulateScenario(scenario: string): Promise<void> } } }).__tavrnVoice.room;
      const resumed = new Promise<void>((done) => room.once("reconnected", done));
      await room.simulateScenario("signal-reconnect");
      await resumed;
    });
    await expect.poll(() => user.page.evaluate((previous) => {
      const sid = (window as unknown as { __tavrnVoice?: { room: { localParticipant: { sid: string } } } }).__tavrnVoice?.room.localParticipant.sid;
      return !!sid && sid !== previous;
    }, previousSid), { timeout: scaled(30_000) }).toBe(true);
    await expect(user.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: scaled(30_000) });
  }
  await expect(tile(alice.page, bob.address).getByTestId("whisper-hold")).toBeEnabled({ timeout: scaled(30_000) });
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
      await expect(sender.page.getByRole("menu")).not.toBeVisible();
      const remote = (await state(receiver.page)).remote.find((p) => p.identity === senderId)!;
      expect(remote.tracks.find((p) => p.name.startsWith("whisper:"))).toMatchObject({ subscribed: true, encrypted: true });
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
  // Denying initiation removes all person/group start surfaces but preserves the server-bound reply shortcut.
  const bobToken = await tokenOf(bob.page);
  const me = await request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${bobToken}` } });
  const bobUser = await me.json() as { id: string };
  const deny = await request.put(`${NODE}/api/v1/rooms/${roomId}/overrides`, { headers: { Authorization: `Bearer ${token}` }, data: { target_type: "channel", target_id: voiceId, subject_type: "member", subject_id: bobUser.id, allow: "0", deny: (1n << 41n).toString() } });
  expect(deny.ok(), await deny.text()).toBeTruthy();
  await expect(tile(bob.page, alice.address).getByTestId("whisper-hold")).toHaveCount(0);
  const rejected = await request.post(`${NODE}/api/v1/rooms/${roomId}/channels/${voiceId}/voice/whisper`, { headers: { Authorization: `Bearer ${bobToken}` }, data: { recipients: [aliceId] } });
  expect(rejected.status()).toBe(403);
  // Refresh the bounded reply receipt with a newly received whisper.
  const releaseAlice = await hold(alice.page, bob.address);
  await expect.poll(async () => (await state(bob.page)).whisperedBy[aliceId]).toBe(true);
  await releaseAlice();
  await expect.poll(async () => (await state(bob.page)).whisperedBy).toEqual({});
  await bob.page.keyboard.down("KeyR");
  try {
    await expect.poll(async () => (await state(bob.page)).whispering).toEqual([aliceId]);
    await expect.poll(async () => (await state(alice.page)).whisperedBy[bobId]).toBe(true);
    await expect.poll(() => inboundPeak(alice.page, bobId)).toBeGreaterThan(0.05);
  } finally { await bob.page.keyboard.up("KeyR"); }
  await expect.poll(async () => (await state(alice.page)).whisperedBy).toEqual({});
  await bob.page.getByTestId("voice-leave").click();
  await expect.poll(async () => (await state(alice.page)).lastWhisperer).toBeNull();
  expect(errors.filter((error) => error.includes("Cannot update a component"))).toEqual([]);
});
