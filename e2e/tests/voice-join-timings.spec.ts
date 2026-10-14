// SPDX-License-Identifier: Apache-2.0
// The voice join (docs/CLIENT.md "Voice troubleshooting"): "Log join timings" prints one table with the stages, the
// /rtc WebSocket, the peer connection and the selected candidate pair; the stages show the parallel join (voice/join
// before the self update is done, the fresh key before the microphone is published); without the switch nothing is
// recorded; switching channels does not wait for the previous channel's leave.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, openNavIfMobile, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

async function navigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function joinVoice(page: Page, roomId: string, name = "Sprache") {
  await navigate(page, `/rooms/${roomId}`);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: `Sprachkanal ${name}` }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: scaled(30_000) });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible();
}

const marks = (page: Page) => page.evaluate(() => performance.getEntriesByType("mark").filter((m) => m.name.startsWith("vj:")).map((m) => ({ name: m.name.slice(3), at: m.startTime })));

async function room(request: APIRequestContext, page: Page) {
  const token = await tokenOf(page);
  const r = await createRoomViaApi(request, token, "Zeiten", "invite", { encrypted: true });
  return { id: r.id as string, token };
}

test("log join timings: the switch, one table on connected with the parallel stages", async ({ browser, request }) => {
  const tables: string[] = [];
  const u = await voiceUser(browser, "vjt");
  u.page.on("console", (m) => m.type() === "info" && m.text().startsWith("voice: join timings") && tables.push(m.text()));
  const r = await room(request, u.page);
  await u.page.goto("/settings/voice");
  const toggle = u.page.getByTestId("log-join-timings");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  expect(await u.page.evaluate(() => localStorage.getItem("tavrn.debug.voice"))).toBe("1");

  await joinVoice(u.page, r.id);
  await expect.poll(() => tables.length, { timeout: scaled(15_000) }).toBe(1);
  const table = tables[0]!;
  for (const stage of ["click", "ensure_joined_done", "voice_join_sent", "voice_join_response", "self_update_done", "lk_signal_connected", "fresh_key_ready", "store_connected", "mic_published"]) {
    expect(table, stage).toContain(stage);
  }
  expect(table).toMatch(/\/rtc WebSocket: opened after \d+ ms/);
  expect(table).toMatch(/peer connection 1: created at \d+, ICE checking after \d+ ms, connected after \d+ ms, \w+ → \w+ over (udp|tcp), RTT/);
  const at = Object.fromEntries((await marks(u.page)).map((m) => [m.name, m.at]));
  // voice/join goes out right after the group join, before the self update is done (joinFlow.ts).
  expect(at.voice_join_sent).toBeLessThan(at.self_update_done!);
  expect(at.fresh_key_ready).toBeLessThanOrEqual(at.store_connected!);
  expect(at.store_connected).toBeLessThanOrEqual(at.mic_published!);
  await u.page.getByTestId("voice-leave").click();
  await expect(u.page.getByTestId("voice-stage")).toHaveCount(0);
});

test("without the switch: no marks, no table; switching channels does not wait for the previous leave", async ({ browser, request }) => {
  const tables: string[] = [];
  const u = await voiceUser(browser, "vjn");
  u.page.on("console", (m) => m.text().startsWith("voice: join timings") && tables.push(m.text()));
  const r = await room(request, u.page);
  const second = await request.post(`${NODE}/api/v1/rooms/${r.id}/channels`, { headers: { Authorization: `Bearer ${r.token}` }, data: { kind: "voice", name: "Zweiter" } });
  expect(second.ok(), await second.text()).toBeTruthy();
  const secondId = (await second.json()).id as string;
  await u.page.goto(`/rooms/${r.id}`);
  await joinVoice(u.page, r.id);
  expect(await marks(u.page)).toEqual([]);

  // The previous channel's leave hangs: the switch still connects.
  let held = 0;
  await u.page.route("**/voice/leave", async (route) => {
    held++;
    await new Promise((res) => setTimeout(res, 4_000));
    await route.continue().catch(() => undefined);
  });
  const started = Date.now();
  await joinVoice(u.page, r.id, "Zweiter");
  expect(held).toBe(1);
  expect(Date.now() - started).toBeLessThan(4_000);
  // The node moved the participation (one voice session per user): only the second channel lists this user.
  await expect
    .poll(async () => {
      const resp = await request.get(`${NODE}/api/v1/rooms/${r.id}/voice`, { headers: { Authorization: `Bearer ${r.token}` } });
      const states = ((await resp.json()) as { items: { channel_id: string; participants: { identity: string }[] }[] }).items;
      return states.filter((s) => s.participants.some((p) => p.identity.startsWith(`${u.address}/`))).map((s) => s.channel_id);
    })
    .toEqual([secondId]);
  expect(tables).toEqual([]);
  await u.page.unroute("**/voice/leave");
});
