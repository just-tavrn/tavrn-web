// SPDX-License-Identifier: Apache-2.0
// Feature round 3, voice (design note 4.13 item 3, tavrn-protocol/VOICE.md §7a, §8, §9.1): the participant dropdown on
// voice rows and stage tiles, the priority speaker (bit 30) with ducking that only verified speakers trigger,
// role order and colours, the soundboard emoji signal, the analyser speaking ring (with a latency measurement
// against LiveKit's active-speaker events) and the idle timeout setting.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, tokenOf } from "./helpers";
import { isTouch, longPress, openContextMenu, openMembers, postMessage } from "./menu-helpers";
import { FAKE_MEDIA, closeOpened, toneWav, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));
const row = (page: Page, address: string) => page.getByTestId("voice-participant").and(page.locator(`[data-user="${address}"]`));
const RAIDER_BLUE = "rgb(52, 152, 219)";

interface Hooks {
  speaking: "analyser" | "livekit";
  priority: string[];
  ducking: Record<string, number>;
  local: { identity: string };
}

async function voiceHooks(page: Page): Promise<Hooks> {
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __tavrnVoice?: unknown }).__tavrnVoice), { timeout: 30_000 }).toBe(true);
  return page.evaluate(() => (window as unknown as { __tavrnVoice: { state: () => unknown } }).__tavrnVoice.state() as Hooks);
}

async function api<T>(request: APIRequestContext, method: "post" | "patch" | "get", path: string, token: string, data?: unknown): Promise<T> {
  const resp = await request[method](`${NODE}/api/v1${path}`, { headers: auth(token), ...(data !== undefined ? { data } : {}) });
  expect(resp.ok(), `${method} ${path}: ${await resp.text()}`).toBeTruthy();
  return (await resp.json().catch(() => null)) as T;
}

async function userId(request: APIRequestContext, token: string, roomId: string, address: string): Promise<string> {
  const members = await api<{ user: { id: string; address: string } }[]>(request, "get", `/rooms/${roomId}/members`, token);
  return members.find((m) => m.user.address === address)!.user.id;
}

async function joinVoice(page: Page, roomId: string, voiceId: string) {
  await page.goto(`/rooms/${roomId}/channels/${voiceId}`);
  await page.getByTestId("voice-join").click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 30_000 });
}

test.describe("Voice, round 3", () => {
  test("Participant menu on row and tile, priority speaker only with the permission, role colour and order, soundboard emoji, speaking ring", async ({ browser, request }) => {
    test.setTimeout(scaled(300_000));
    const owner = await voiceUser(browser, "r3own");
    const alice = await voiceUser(browser, "r3ali");
    const bob = await voiceUser(browser, "r3bob");
    const ownerToken = await tokenOf(owner.page);
    const room = await createRoomViaApi(request, ownerToken, "Runde drei");
    const roomId = room.id as string;
    const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
    const code = await inviteCode(request, ownerToken, roomId);
    for (const u of [alice, bob]) await api(request, "post", `/invites/${code}/join`, await tokenOf(u.page), {});
    // Bob gets the coloured "Raider" role and a nickname; nobody but the owner has priority_speaker.
    const raider = await api<{ id: string }>(request, "post", `/rooms/${roomId}/roles`, ownerToken, { name: "Raider", color: "#3498db", permissions: "0" });
    const bobId = await userId(request, ownerToken, roomId, bob.address);
    await api(request, "patch", `/rooms/${roomId}/members/${bobId}`, ownerToken, { roles: [raider.id], nickname: "Bobby" });
    // A clip whose sound object carries an emoji (the field comes with the sound model of feature round 3).
    const clip = await request.post(`${NODE}/api/v1/rooms/${roomId}/soundboard`, {
      headers: { ...auth(ownerToken), "Content-Type": "audio/wav", "Tavrn-Sound-Name": "Fanfare", "Tavrn-Sound-Duration-Ms": "2000" },
      data: toneWav(2),
    });
    expect(clip.ok(), await clip.text()).toBeTruthy();
    await bob.page.route("**/api/v1/rooms/*/soundboard", async (route) => {
      const resp = await route.fetch();
      const list = (await resp.json()) as Record<string, unknown>[];
      await route.fulfill({ response: resp, json: list.map((s) => ({ ...s, emoji: "🎺" })) });
    });

    for (const u of [owner, alice, bob]) await joinVoice(u.page, roomId, voiceId);
    for (const u of [owner, alice, bob]) for (const other of [owner, alice, bob]) await expect(tile(u.page, other.address)).toBeVisible({ timeout: 30_000 });
    const ids = Object.fromEntries(await Promise.all([owner, alice, bob].map(async (u) => [u.address, (await voiceHooks(u.page)).local.identity] as const)));

    // Speaking rings come from the analysers of the decoded audio (LiveKit's events are the fallback).
    expect((await voiceHooks(alice.page)).speaking).toBe("analyser");

    // Order and colour: Bob (Raider, position 1) first, under his nickname in the role colour, on rows and tiles.
    await openNavIfMobile(alice.page);
    await expect(alice.page.getByTestId("voice-participant").first()).toHaveAttribute("data-user", bob.address, { timeout: 20_000 });
    await expect(row(alice.page, bob.address).getByTestId("voice-participant-name")).toHaveText("Bobby");
    await expect(row(alice.page, bob.address).getByTestId("voice-participant-name")).toHaveCSS("color", RAIDER_BLUE);
    await expect(tile(alice.page, bob.address).getByTestId("tile-name")).toHaveCSS("color", RAIDER_BLUE);
    await expect(alice.page.getByTestId("voice-tile").first()).toHaveAttribute("data-user", bob.address);

    // The participant menu on a list row: the member list's dropdown (right-click / long press), no dialog.
    await openNavIfMobile(owner.page);
    await openContextMenu(owner.page, row(owner.page, bob.address));
    const menu = owner.page.getByTestId("member-menu");
    await expect(menu).toBeVisible();
    await expect(owner.page.getByRole("dialog")).toHaveCount(0);
    for (const name of ["Profil", "Nachricht", "Adresse kopieren", "ID kopieren", "Serverseitig stummschalten", "Trennen", "Aus dem Raum entfernen"])
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    // Per-user volume up to 200 % (in the own call).
    const slider = menu.getByTestId("menu-volume").getByRole("slider");
    await slider.evaluate((el: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "150");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(menu.getByTestId("menu-volume")).toContainText("150 %");
    expect(await owner.page.evaluate((a) => JSON.parse(localStorage.getItem("tavrn.voice.settings") ?? "{}").userVolumes?.[a], bob.address)).toBe(150);
    await owner.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // The same menu on a stage tile: right-click / long press and the ⋯ button.
    // (Phones: back from the channel drawer to the stage through the channel link; no reload, that would leave.)
    if ((owner.page.viewportSize()?.width ?? 1280) < 768) await owner.page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
    await expect(tile(owner.page, bob.address)).toBeVisible({ timeout: 20_000 });
    if (isTouch()) await longPress(owner.page, tile(owner.page, bob.address));
    else await tile(owner.page, bob.address).click({ button: "right", position: { x: 30, y: 30 } });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Profil" })).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // (The click right after a long press is swallowed for 400 ms, so a long press never also taps.)
    if (isTouch()) await owner.page.waitForTimeout(500);
    await tile(owner.page, bob.address).hover();
    await tile(owner.page, bob.address).getByTestId("tile-menu-button").click();
    await expect(menu.getByRole("menuitem", { name: "Serverseitig stummschalten" })).toBeVisible();
    await owner.page.keyboard.press("Escape");

    // Priority speaker: only the owner has the bit, so only the owner gets the toggle.
    await expect(owner.page.getByTestId("voice-priority")).toBeVisible();
    await expect(bob.page.getByTestId("voice-priority")).toHaveCount(0);
    await expect(alice.page.getByTestId("voice-priority")).toHaveCount(0);
    // Security: Bob sets `priority=1` himself (his token has no attribute updates; even if LiveKit took it,
    // receivers check the permission): nobody is ducked, nothing is shown.
    await bob.page.evaluate(() =>
      Promise.race([
        (window as unknown as { __tavrnVoice: { room: { localParticipant: { setAttributes: (a: Record<string, string>) => Promise<void> } } } }).__tavrnVoice.room.localParticipant
          .setAttributes({ priority: "1" })
          .catch(() => undefined),
        new Promise((r) => setTimeout(r, 3000)),
      ]),
    );
    await alice.page.waitForTimeout(1500);
    expect((await voiceHooks(alice.page)).priority).toEqual([]);
    expect(Object.values((await voiceHooks(alice.page)).ducking).every((g) => g > 0.99)).toBe(true);
    await expect(tile(alice.page, bob.address)).not.toHaveAttribute("data-priority", "true");

    // The owner turns priority on: Alice ducks Bob (not the owner) to 25 %, the owner's tile and row show it.
    await owner.page.getByTestId("voice-priority").click();
    await expect(owner.page.getByTestId("voice-priority")).toHaveAttribute("aria-pressed", "true");
    await expect(tile(alice.page, owner.address)).toHaveAttribute("data-priority", "true", { timeout: 15_000 });
    await expect(tile(alice.page, owner.address).getByTestId("priority-glyph")).toHaveAttribute("aria-label", /spricht als Gesprächsleitung/);
    await expect(row(alice.page, owner.address).getByTestId("priority-glyph")).toBeAttached();
    await expect.poll(async () => (await voiceHooks(alice.page)).ducking[ids[bob.address]!], { timeout: 10_000 }).toBeCloseTo(0.25, 2);
    expect((await voiceHooks(alice.page)).ducking[ids[owner.address]!]).toBeCloseTo(1, 2);
    await owner.page.getByTestId("voice-priority").click();
    await expect(tile(alice.page, owner.address)).not.toHaveAttribute("data-priority", "true", { timeout: 15_000 });
    await expect.poll(async () => (await voiceHooks(alice.page)).ducking[ids[bob.address]!], { timeout: 10_000 }).toBeCloseTo(1, 2);

    // Soundboard: Bob plays the clip; Alice sees its emoji on Bob's tile while it plays (data channel signal).
    await bob.page.getByTestId("voice-soundboard").click();
    await bob.page.getByTestId("soundboard-clip").filter({ hasText: "Fanfare" }).click();
    await expect(tile(bob.page, bob.address).getByTestId("sound-overlay")).toHaveText("🎺");
    await expect(tile(alice.page, bob.address).getByTestId("sound-overlay")).toHaveText("🎺", { timeout: 10_000 });
    await expect(tile(alice.page, bob.address).getByTestId("sound-overlay")).toHaveCount(0, { timeout: 10_000 });
    await bob.page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();

    // Speaking ring latency (VOICE.md §9.1): Bob unmutes (his fake microphone plays a tone); Alice records when
    // his tile lights up and when LiveKit's active-speaker event names him.
    await bob.page.getByTestId("voice-mute").click();
    await expect(tile(alice.page, bob.address)).not.toHaveAttribute("data-speaking", "true", { timeout: 20_000 });
    await alice.page.waitForTimeout(2000);
    await alice.page.evaluate(
      ({ address, identity }) => {
        const w = window as unknown as { __r3: { ring?: number; livekit?: number }; __tavrnVoice: { room: { on: (e: string, f: (s: { identity: string }[]) => void) => void } } };
        w.__r3 = {};
        const now = () => performance.timeOrigin + performance.now();
        const el = document.querySelector(`[data-testid="voice-tile"][data-user="${address}"]`)!;
        new MutationObserver(() => {
          if (el.getAttribute("data-speaking") && !w.__r3.ring) w.__r3.ring = now();
        }).observe(el, { attributes: true, attributeFilter: ["data-speaking"] });
        w.__tavrnVoice.room.on("activeSpeakersChanged", (speakers) => {
          if (!w.__r3.livekit && speakers.some((p) => p.identity === identity)) w.__r3.livekit = now();
        });
      },
      { address: bob.address, identity: ids[bob.address]! },
    );
    const start = await bob.page.evaluate(() => {
      const t = performance.timeOrigin + performance.now();
      (document.querySelector('[data-testid="voice-mute"]') as HTMLButtonElement).click();
      return t;
    });
    await expect.poll(() => alice.page.evaluate(() => (window as unknown as { __r3: { ring?: number } }).__r3.ring ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => alice.page.evaluate(() => (window as unknown as { __r3: { livekit?: number } }).__r3.livekit ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
    const times = await alice.page.evaluate(() => (window as unknown as { __r3: { ring: number; livekit: number } }).__r3);
    const ring = Math.round(times.ring - start);
    const livekit = Math.round(times.livekit - start);
    await test.info().attach("speaking-latency", { body: JSON.stringify({ project: test.info().project.name, ringMs: ring, livekitMs: livekit }), contentType: "application/json" });
    console.info(`[${test.info().project.name}] speaking ring after unmute: ${ring} ms (LiveKit active speaker: ${livekit} ms)`);
    expect(ring).toBeLessThan(1500);
  });

  test("Role colour and nickname in the chat, member list unchanged", async ({ page, request }) => {
    const owner = await registerViaApi(request, "r3own");
    const bob = await registerViaApi(request, "r3bob");
    const room = await createRoomViaApi(request, owner.token, "Farben");
    const text = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "text")!.id;
    const code = await inviteCode(request, owner.token, room.id);
    await api(request, "post", `/invites/${code}/join`, bob.token, {});
    const raider = await api<{ id: string }>(request, "post", `/rooms/${room.id}/roles`, owner.token, { name: "Raider", color: "#3498db", permissions: "0" });
    await api(request, "patch", `/rooms/${room.id}/members/${bob.userId}`, owner.token, { roles: [raider.id], nickname: "Bobby" });
    await postMessage(request, bob.token, text, "Hallo in Blau");
    await postMessage(request, owner.token, text, "Hallo ohne Farbe");

    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${text}`);
    const bobMessage = page.getByTestId("message").filter({ hasText: "Hallo in Blau" });
    // The nickname, never the raw local part, in the role colour.
    await expect(bobMessage.getByTestId("message-author")).toHaveText("Bobby");
    await expect(bobMessage.getByTestId("message-author")).toHaveCSS("color", RAIDER_BLUE);
    const ownMessage = page.getByTestId("message").filter({ hasText: "Hallo ohne Farbe" });
    await expect(ownMessage.getByTestId("message-author")).not.toHaveCSS("color", RAIDER_BLUE);
    // The member list keeps its colours and names.
    await openMembers(page);
    await expect(page.getByTestId("member-row").filter({ hasText: "Bobby" }).locator('span[style*="color"]', { hasText: "Bobby" })).toHaveCSS("color", RAIDER_BLUE);
  });

  test("Settings: priority speaker key, away after 5/10/15/30 minutes or never", async ({ page, request }) => {
    const user = await registerViaApi(request, "r3set");
    await loginAs(page, user);
    await page.goto("/settings/voice");
    await expect(page.getByTestId("priority-key")).toHaveText("keins");
    if (!isTouch()) {
      await page.getByTestId("priority-capture").click();
      await page.keyboard.press("KeyV");
      await expect(page.getByTestId("priority-key")).toHaveText("V");
      await page.getByTestId("priority-clear").click();
      await expect(page.getByTestId("priority-key")).toHaveText("keins");
    }

    await page.goto("/settings/profile");
    const select = page.getByTestId("idle-timeout");
    await expect(select).toHaveValue("10");
    await expect(select.locator("option")).toHaveText(["5 Minuten", "10 Minuten", "15 Minuten", "30 Minuten", "Nie"]);
    await select.selectOption("0");
    await page.reload();
    await expect(page.getByTestId("idle-timeout")).toHaveValue("0");
    await page.getByTestId("idle-timeout").selectOption("5");
    expect(await page.evaluate(() => localStorage.getItem("tavrn.idle.minutes"))).toBe("5");
  });
});
