// SPDX-License-Identifier: Apache-2.0
// Real browser/HTTP/media proof of the distinction between initiation and a received-whisper reply.
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, hooks, inboundPeak, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);
type State = { whispering: string[]; whisperedBy: Record<string, true>; lastWhisperer: string | null; remote: { identity: string; tracks: { name: string }[] }[] };
const state = (page: Page): Promise<State> => page.evaluate(() => (window as unknown as { __tavrnVoice: { state(): State } }).__tavrnVoice.state());
const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));

test("denied initiation still permits an actual reply; channel grants and live revocation are enforced", async ({ browser, request }) => {
  test.setTimeout(scaled(240_000));
  test.skip(process.env.E2E_VOICE === "false", "LiveKit unavailable");
  const alice = await voiceUser(browser, "waperm", undefined, { cuesOff: true });
  const bob = await voiceUser(browser, "wbperm", undefined, { cuesOff: true, hotkeys: { whisper_reply: "F8" } });
  const ownerToken = await tokenOf(alice.page);
  const bobToken = await tokenOf(bob.page);
  const room = await createRoomViaApi(request, ownerToken, "Whisper permissions");
  const roomId = room.id as string;
  const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
  const code = await inviteCode(request, ownerToken, roomId);
  const joined = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${bobToken}` }, data: {} });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  const detail = await (await request.get(`${NODE}/api/v1/rooms/${roomId}`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
  const everyone = (detail.roles as { id: string; is_everyone: boolean }[]).find((r) => r.is_everyone)!.id;
  const override = async (allow: bigint, deny: bigint) => {
    const response = await request.put(`${NODE}/api/v1/rooms/${roomId}/overrides`, { headers: { Authorization: `Bearer ${ownerToken}` }, data: { target_type: "channel", target_id: voiceId, subject_type: "role", subject_id: everyone, allow: String(allow), deny: String(deny) } });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const whisper = 1n << 41n;
  await override(0n, whisper);
  for (const user of [alice, bob]) {
    await user.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await user.page.getByTestId("voice-join").click();
    await expect(user.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: scaled(30_000) });
  }
  const aliceId = (await hooks(alice.page)).local!.identity;
  const bobId = (await hooks(bob.page)).local!.identity;
  const path = `${NODE}/api/v1/rooms/${roomId}/channels/${voiceId}/voice/whisper`;
  const bobHeaders = { Authorization: `Bearer ${await tokenOf(bob.page)}` };
  expect((await request.post(path, { headers: bobHeaders, data: { recipients: [aliceId] } })).status()).toBe(403);
  expect((await request.post(path, { headers: bobHeaders, data: { reply_to: "01J9ZZZZZZZZZZZZZZZZZZZZZZ" } })).status()).toBe(403);
  await expect(tile(bob.page, alice.address).getByTestId("whisper-hold")).toHaveCount(0);
  await bob.page.keyboard.press("F8");
  expect((await state(bob.page)).whispering).toEqual([]);

  // Real hold, then the real reply hotkey: no programmatic controller calls substitute for the user path.
  const aliceHold = tile(alice.page, bob.address).getByTestId("whisper-hold");
  await expect(aliceHold).toBeVisible();
  await aliceHold.focus();
  await alice.page.keyboard.down("Space");
  try {
    await expect.poll(async () => (await state(bob.page)).whisperedBy[aliceId]).toBe(true);
    await expect.poll(() => inboundPeak(bob.page, aliceId), { timeout: scaled(30_000) }).toBeGreaterThan(0.05);
    // A continuous hold remains active across the first half-minute.
    await alice.page.waitForTimeout(31_000);
    expect((await state(alice.page)).whispering).toEqual([bobId]);
    expect((await state(bob.page)).whisperedBy[aliceId]).toBe(true);
    const name = (await state(bob.page)).remote.find((p) => p.identity === aliceId)!.tracks.find((p) => p.name.startsWith("whisper:"))!.name;
    const premature = await request.delete(`${path}/${name.slice(8)}`, { headers: { Authorization: `Bearer ${await tokenOf(alice.page)}` } });
    expect(premature.status()).toBe(409);
    expect((await state(alice.page)).whispering).toEqual([bobId]);
  } finally { await alice.page.keyboard.up("Space"); }
  await expect.poll(async () => (await state(bob.page)).whisperedBy).toEqual({});
  expect((await state(bob.page)).lastWhisperer).toBe(aliceId);
  await bob.page.keyboard.down("F8");
  try {
    await expect.poll(async () => (await state(bob.page)).whispering).toEqual([aliceId]);
    await expect.poll(async () => (await state(alice.page)).whisperedBy[bobId]).toBe(true);
    await expect.poll(() => inboundPeak(alice.page, bobId), { timeout: scaled(30_000) }).toBeGreaterThan(0.05);
  } finally { await bob.page.keyboard.up("F8"); }
  await expect.poll(async () => (await state(alice.page)).whisperedBy).toEqual({});
  // A successful reply did not grant permission to initiate.
  expect((await request.post(path, { headers: bobHeaders, data: { recipients: [aliceId] } })).status()).toBe(403);

  await override(whisper, 0n);
  const bobHold = tile(bob.page, alice.address).getByTestId("whisper-hold");
  await expect(bobHold).toBeVisible();
  await bobHold.focus();
  await bob.page.keyboard.down("Space");
  try {
    await expect.poll(async () => (await state(alice.page)).whisperedBy[bobId]).toBe(true);
    await override(0n, whisper);
    await expect.poll(async () => (await state(bob.page)).whispering).toEqual([]);
    await expect.poll(async () => (await state(alice.page)).whisperedBy).toEqual({});
    expect((await request.post(path, { headers: bobHeaders, data: { recipients: [aliceId] } })).status()).toBe(403);
  } finally { await bob.page.keyboard.up("Space"); }
});
