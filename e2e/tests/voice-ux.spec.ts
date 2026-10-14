// SPDX-License-Identifier: Apache-2.0
// Voice UX round (tavrn-web #119, #123, #124, #125): moving yourself by drag and drop with visible drop targets, the
// local "mute for you" with its markers, the hint when talking while muted (nothing leaks to the other side), and the
// new cue in the settings. Two browser contexts with Chromium's fake microphone (speech-like sound, `fake-audio.ts`).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, tokenOf, type Account } from "./helpers";
import { isTouch } from "./menu-helpers";
import { FAKE_MEDIA, closeOpened, cues, hooks, inboundPeak, opened, voiceUser, type VoiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));
const row = (page: Page, address: string) => page.getByTestId("voice-participant").and(page.locator(`[data-user="${address}"]`));
const channelBox = (page: Page, id: string) => page.getByTestId("voice-channel").and(page.locator(`[data-channel="${id}"]`));
const phone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

interface Setup {
  owner: Account;
  roomId: string;
  voiceId: string;
  code: string;
}

async function setup(request: APIRequestContext): Promise<Setup> {
  const owner = await registerViaApi(request, "uxown");
  const room = await createRoomViaApi(request, owner.token, "Stammtisch");
  const voice = room.channels.find((c: { kind: string }) => c.kind === "voice") as { id: string };
  return { owner, roomId: room.id as string, voiceId: voice.id, code: await inviteCode(request, owner.token, room.id) };
}

async function joinRoom(request: APIRequestContext, user: VoiceUser, code: string) {
  const resp = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: auth(await tokenOf(user.page)), data: {} });
  expect(resp.ok(), await resp.text()).toBeTruthy();
}

/** Joins the room's voice channel "Sprache" from the channel list. */
async function joinFromSidebar(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: scaled(30_000) });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible();
}

async function createVoiceChannel(request: APIRequestContext, s: Setup, name: string): Promise<string> {
  const resp = await request.post(`${NODE}/api/v1/rooms/${s.roomId}/channels`, { headers: auth(s.owner.token), data: { kind: "voice", name } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return (await resp.json()).id as string;
}

const serious = (violations: { impact?: string | null; id: string }[]) => violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);

/** The axe gate on the stage in its current state (docs/ACCESSIBILITY.md: serious and critical WCAG violations fail). */
async function axeStage(page: Page) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include('[data-testid="voice-stage"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(serious(result.violations)).toEqual([]);
}

test.describe("Voice UX round", () => {
  test("Moving yourself: drag your row onto a channel you may join; a channel you may not join refuses the drop (#119)", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const s = await setup(request);
    const raidId = await createVoiceChannel(request, s, "Raid");
    const stageId = await createVoiceChannel(request, s, "Bühne");
    // "Bühne" is visible but nobody may connect (bit 16 denied for @everyone): a drop there is refused.
    const room = await (await request.get(`${NODE}/api/v1/rooms/${s.roomId}`, { headers: auth(s.owner.token) })).json();
    const everyone = room.roles.find((r: { is_everyone: boolean }) => r.is_everyone).id as string;
    const deny = await request.put(`${NODE}/api/v1/rooms/${s.roomId}/overrides`, { headers: auth(s.owner.token), data: { target_type: "channel", target_id: stageId, subject_type: "role", subject_id: everyone, allow: "0", deny: String(2 ** 16) } });
    expect(deny.ok(), await deny.text()).toBeTruthy();
    const alice = await voiceUser(browser, "uxali", undefined, { cuesOff: true });
    await joinRoom(request, alice, s.code);
    await joinFromSidebar(alice.page, s.roomId);
    await openNavIfMobile(alice.page);
    const own = row(alice.page, alice.address);
    await expect(own).toBeVisible({ timeout: scaled(20_000) });

    if (isTouch()) {
      // No HTML5 drag on touch: the non-drag equivalent is clicking the channel; "Bühne" cannot be joined at all.
      await alice.page.getByRole("link", { name: "Sprachkanal Raid" }).click();
      await expect(alice.page.getByTestId("voice-bar-channel")).toContainText("Raid", { timeout: scaled(30_000) });
      await openNavIfMobile(alice.page);
      await expect(channelBox(alice.page, raidId).locator(`[data-testid="voice-participant"][data-user="${alice.address}"]`)).toHaveCount(1, { timeout: scaled(20_000) });
      await alice.page.getByRole("link", { name: /Sprachkanal Bühne/ }).click();
      await expect(alice.page.getByText("Du darfst diesen Sprachkanal nicht betreten.")).toBeVisible();
      await expect(alice.page.getByTestId("voice-bar-channel")).toContainText("Raid");
      return;
    }

    // The own row is draggable (nobody else is: Alice has no move_members), with the switch hint.
    await expect(own).toHaveAttribute("draggable", "true");
    expect(await own.getAttribute("title")).toContain("Auf einen anderen Sprachkanal ziehen, um dorthin zu wechseln");
    // Dropped on "Raid" (a channel she may join): she switches to it. (The accept/refuse indicator while the drag
    // hovers is covered by the component's unit tests; Playwright's drag runs through to the drop.)
    await own.dragTo(channelBox(alice.page, raidId));
    await expect(alice.page.getByTestId("voice-bar-channel")).toContainText("Raid", { timeout: scaled(30_000) });
    await expect(channelBox(alice.page, raidId).locator(`[data-testid="voice-participant"][data-user="${alice.address}"]`)).toHaveCount(1, { timeout: scaled(20_000) });
    await expect(channelBox(alice.page, s.voiceId).getByTestId("voice-participant")).toHaveCount(0);
    await expect(channelBox(alice.page, raidId)).not.toHaveAttribute("data-drop");
    // Dropped on "Bühne" (no connect): refused, nothing happens, no indicator lingers.
    const ownInRaid = channelBox(alice.page, raidId).locator(`[data-testid="voice-participant"][data-user="${alice.address}"]`);
    await ownInRaid.dragTo(channelBox(alice.page, stageId));
    await alice.page.waitForTimeout(1_500);
    await expect(alice.page.getByTestId("voice-bar-channel")).toContainText("Raid");
    await expect(ownInRaid).toHaveCount(1);
    await expect(channelBox(alice.page, stageId).getByTestId("voice-participant")).toHaveCount(0);
    await expect(channelBox(alice.page, stageId)).not.toHaveAttribute("data-drop");
    await expect(alice.page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected");

    // A moderator (the owner, move_members) drags Alice back into "Sprache": the node moves her.
    const modContext = await browser.newContext({ ...test.info().project.use });
    opened.push(modContext);
    const mod = await modContext.newPage();
    await loginAs(mod, s.owner);
    await mod.goto(`/rooms/${s.roomId}`);
    const aliceRow = channelBox(mod, raidId).locator(`[data-testid="voice-participant"][data-user="${alice.address}"]`);
    await expect(aliceRow).toHaveCount(1, { timeout: scaled(20_000) });
    await aliceRow.dragTo(channelBox(mod, s.voiceId));
    await expect(channelBox(mod, s.voiceId).locator(`[data-testid="voice-participant"][data-user="${alice.address}"]`)).toHaveCount(1, { timeout: scaled(30_000) });
    await expect(alice.page.getByTestId("voice-bar-channel")).toContainText("Sprache", { timeout: scaled(30_000) });
    await expect(alice.page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected", { timeout: scaled(30_000) });
  });

  test("Mute for you: marker on tile and row, header reminder, nothing of them is heard, one click undoes it (#124)", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const s = await setup(request);
    const alice = await voiceUser(browser, "uxlma", undefined, { cuesOff: true });
    const bob = await voiceUser(browser, "uxlmb", undefined, { cuesOff: true });
    for (const u of [alice, bob]) await joinRoom(request, u, s.code);
    for (const u of [alice, bob]) await joinFromSidebar(u.page, s.roomId);
    await expect(tile(alice.page, bob.address)).toBeVisible({ timeout: scaled(30_000) });
    const bobId = (await hooks(alice.page)).remote.find((r) => r.identity.startsWith(`${bob.address}/`))!.identity;
    // Bob's fake microphone plays: Alice sees him speaking and hears him.
    await expect(tile(alice.page, bob.address)).toHaveAttribute("data-speaking", "true", { timeout: scaled(30_000) });
    const volumes = async () => ((await hooks(alice.page)) as unknown as { volumes: Record<string, { microphone: number; stream: number }> }).volumes[bobId];
    expect(await volumes()).toEqual({ microphone: 1, stream: 1 });

    // "Mute for you" in Bob's menu (the row's ⋯ button in the channel list; the drawer on phones).
    await openNavIfMobile(alice.page);
    await row(alice.page, bob.address).hover();
    await row(alice.page, bob.address).getByRole("button", { name: /Optionen für/ }).click();
    const menu = alice.page.getByTestId("member-menu");
    const item = menu.getByRole("menuitemcheckbox", { name: "Für mich stummschalten" });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("aria-checked", "false");
    await item.click();
    // The item stays open as the undo and shows the state.
    await expect(menu.getByRole("menuitemcheckbox", { name: "Für mich wieder laut" })).toHaveAttribute("aria-checked", "true");
    await alice.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // Row: marker and no speaking ring (nothing is heard).
    await expect(row(alice.page, bob.address)).toHaveAttribute("data-local-muted", "true");
    const rowMark = row(alice.page, bob.address).getByTestId("local-mute-mark");
    await expect(rowMark).toHaveAccessibleName(/ für dich wieder laut schalten$/);
    expect(await rowMark.getAttribute("title")).toContain("Für dich stumm");
    await expect(row(alice.page, bob.address)).not.toHaveAttribute("data-speaking", "true");
    if (phone(alice.page)) await alice.page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
    // Tile: marker, no ring, the header counts, the gains are zero (voice and stream audio).
    await expect(tile(alice.page, bob.address)).toHaveAttribute("data-local-muted", "true");
    await expect(tile(alice.page, bob.address).getByTestId("local-mute-mark")).toBeVisible();
    await expect(tile(alice.page, bob.address)).not.toHaveAttribute("data-speaking", "true");
    await expect(alice.page.getByTestId("local-mute-reminder")).toHaveText("Für dich stumm: 1");
    await expect.poll(volumes).toEqual({ microphone: 0, stream: 0 });
    // Bob keeps talking meanwhile: still never shown speaking.
    await alice.page.waitForTimeout(2_000);
    await expect(tile(alice.page, bob.address)).not.toHaveAttribute("data-speaking", "true");
    // Nobody else is told: Bob's own state is unchanged (not muted, not server-muted).
    await expect(bob.page.getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "false");
    await expect(tile(bob.page, bob.address).getByTestId("flag-muted")).toHaveCount(0);
    await axeStage(alice.page);

    // One click on the tile's marker lifts it.
    await tile(alice.page, bob.address).hover();
    await tile(alice.page, bob.address).getByTestId("local-mute-mark").click();
    await expect(tile(alice.page, bob.address)).not.toHaveAttribute("data-local-muted");
    await expect(alice.page.getByTestId("local-mute-reminder")).toHaveCount(0);
    await expect.poll(volumes).toEqual({ microphone: 1, stream: 1 });
    await expect(tile(alice.page, bob.address)).toHaveAttribute("data-speaking", "true", { timeout: scaled(30_000) });
    await openNavIfMobile(alice.page);
    await expect(row(alice.page, bob.address).getByTestId("local-mute-mark")).toHaveCount(0);
  });

  test("Talking while muted: a soft cue, the pulsing microphone and a notice; nothing is sent; the setting turns it off (#125, #123)", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const s = await setup(request);
    // Alice with the hint on (stored: it is off by default on Android, #147) and cues on; Bob only listens.
    const alice = await voiceUser(browser, "uxtma", undefined, { mutedTalkHint: true });
    const bob = await voiceUser(browser, "uxtmb", undefined, { cuesOff: true });
    for (const u of [alice, bob]) await joinRoom(request, u, s.code);
    for (const u of [alice, bob]) await joinFromSidebar(u.page, s.roomId);
    await expect(tile(bob.page, alice.address)).toBeVisible({ timeout: scaled(30_000) });
    const aliceId = (await hooks(bob.page)).remote.find((r) => r.identity.startsWith(`${alice.address}/`))!.identity;
    // Unmuted, Alice's fake microphone is heard by Bob.
    await expect.poll(() => inboundPeak(bob.page, aliceId), { timeout: scaled(20_000) }).toBeGreaterThan(0.01);

    // Muted: the capture stays open for the hint, the gate is closed, the track muted; the hint comes within seconds.
    await alice.page.getByTestId("voice-mute").click();
    await expect(alice.page.getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => cues(alice.page), { timeout: scaled(15_000) }).toContainEqual({ cue: "muted_talk", own: true });
    const state = await hooks(alice.page);
    expect(state.capturing).toBe(true);
    expect(state.mutedTalkListening).toBe(true);
    await expect(alice.page.getByTestId("voice-mute")).toHaveAttribute("data-pulse", "true");
    await expect(tile(alice.page, alice.address)).toHaveAttribute("data-muted-talk", "true");
    // (The toast's text ends with its dismiss "×".)
    await expect(alice.page.getByTestId("muted-talk-hint")).toContainText("Du redest, aber dein Mikrofon ist stumm.");
    await axeStage(alice.page);
    // Nothing leaks: Bob decodes silence from Alice and never sees her speaking; her track stays encrypted.
    expect(await inboundPeak(bob.page, aliceId)).toBeLessThan(0.01);
    await expect(tile(bob.page, alice.address)).not.toHaveAttribute("data-speaking", "true");
    await expect(tile(bob.page, alice.address).getByTestId("flag-muted")).toBeVisible();
    expect((await hooks(alice.page)).local!.tracks.every((t) => t.encrypted)).toBe(true);
    // Rate-limited: one cue so far, the pulse ends by itself, the notice came once.
    expect((await cues(alice.page)).filter((c) => c.cue === "muted_talk")).toHaveLength(1);
    await expect(alice.page.getByTestId("voice-mute")).not.toHaveAttribute("data-pulse", { timeout: scaled(10_000) });
    // Unmuted: no pulse, Bob hears her again.
    await alice.page.getByTestId("voice-mute").click();
    await expect(alice.page.getByTestId("voice-mute")).toHaveAttribute("aria-pressed", "false");
    await expect(alice.page.getByTestId("voice-mute")).not.toHaveAttribute("data-pulse");
    await expect.poll(() => inboundPeak(bob.page, aliceId), { timeout: scaled(20_000) }).toBeGreaterThan(0.01);

    // The setting (Input mode) and the new cue with its preview in the settings (#123); the gear of the controls keeps
    // the call (a page load would end it).
    await alice.page.getByTestId("voice-controls").getByRole("button", { name: "Einstellungen für Sprachchat & Video" }).click();
    await expect(alice.page.getByTestId("voice-settings")).toBeVisible();
    const cueBox = alice.page.getByTestId("cue-muted_talk");
    await expect(cueBox).toBeChecked();
    await alice.page.getByRole("button", { name: "Abspielen: Sprechen bei stummem Mikrofon" }).click();
    await expect.poll(() => alice.page.evaluate(() => (window as unknown as { __tavrnCues?: { scheduled?: { cue: string }[] } }).__tavrnCues?.scheduled?.some((c) => c.cue === "muted_talk") ?? false), { timeout: scaled(10_000) }).toBe(true);
    const hint = alice.page.getByTestId("muted-talk-hint");
    await expect(hint).toBeChecked();
    await hint.uncheck();
    // Stored as false where the default is on; on Android off is the default, which is not stored (#147).
    expect((await alice.page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.voice.settings") ?? "{}").mutedTalkHint)) ?? false).toBe(false);
    // Back in the channel through the voice bar (still connected), a mute releases the capture again and no hint comes.
    await openNavIfMobile(alice.page);
    await alice.page.getByTestId("voice-bar").getByTitle("Sprachkanal öffnen").click();
    await expect(alice.page.getByTestId("voice-stage")).toBeVisible({ timeout: scaled(30_000) });
    await expect(alice.page.getByTestId("voice-bar")).toHaveAttribute("data-status", "connected");
    const before = (await cues(alice.page)).filter((c) => c.cue === "muted_talk").length;
    await alice.page.getByTestId("voice-mute").click();
    await expect.poll(async () => (await hooks(alice.page)).capturing, { timeout: scaled(10_000) }).toBe(false);
    expect((await hooks(alice.page)).mutedTalkListening).toBe(false);
    await alice.page.waitForTimeout(3_000);
    expect((await cues(alice.page)).filter((c) => c.cue === "muted_talk")).toHaveLength(before);
    await expect(alice.page.getByTestId("voice-mute")).not.toHaveAttribute("data-pulse");
  });
});
