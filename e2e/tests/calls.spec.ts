// SPDX-License-Identifier: Apache-2.0
// Calls in DMs and group DMs (design note 4.11, tavrn-protocol/VOICE.md §11): the caller's "Call" button rings the
// other members (banner and ringtone), accepting joins an end-to-end encrypted LiveKit call with audible
// audio, hanging up ends it with a system message; declining ends a DM call as missed; group calls ring
// everybody and show who is in.
import { expect, test, type Page } from "@playwright/test";
import { NODE, openNavIfMobile, tokenOf } from "./helpers";
import { FAKE_MEDIA, befriend, closeOpened, cues, hooks, inboundPeak, message, openConversation, send, voiceUser, type VoiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

const consoleLines: string[] = [];
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && consoleLines.length) await info.attach("browser-console", { body: consoleLines.join("\n"), contentType: "text/plain" });
  consoleLines.length = 0;
  await closeOpened();
});

/** The id of the conversation shown on `page` (from the URL). */
const conversationId = (page: Page) => new URL(page.url()).pathname.split("/conversations/")[1]!.split("/")[0]!;

/** Types of the node's call messages in a conversation (API; the client renders them generically for now). */
async function callMessages(page: Page, id: string): Promise<string[]> {
  const resp = await page.request.get(`${NODE}/api/v1/conversations/${id}/messages`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } });
  expect(resp.ok()).toBeTruthy();
  return ((await resp.json()) as { content: { type?: string } | string }[]).map((m) => (typeof m.content === "object" ? (m.content.type ?? "") : "")).filter((t) => t.startsWith("system.call."));
}

/** alice opens a DM with bob and writes (creates the encrypted group), bob reads it (joins the group). */
async function dmBetween(alice: VoiceUser, bob: VoiceUser): Promise<string> {
  await befriend(alice, bob);
  await alice.page.goto("/friends");
  await alice.page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
  await expect(alice.page.getByTestId("conversation-name")).toHaveText(bob.username);
  await send(alice.page, "Hallo, gleich ruf ich an");
  await openConversation(bob.page, new RegExp(alice.username));
  await expect(message(bob.page, "Hallo, gleich ruf ich an")).toBeVisible({ timeout: 20_000 });
  return conversationId(alice.page);
}

test.describe("Calls in direct messages", () => {
  test("Call: ringing with a ringtone, answering, encrypted audio, hanging up ends it for both", async ({ browser }) => {
    test.setTimeout(scaled(240_000));
    const alice = await voiceUser(browser, "calla", consoleLines);
    const bob = await voiceUser(browser, "callb", consoleLines);
    const id = await dmBetween(alice, bob);

    await alice.page.getByTestId("call-start").click();
    const aliceView = alice.page.getByTestId("call-view");
    await expect(aliceView).toBeVisible({ timeout: 30_000 });
    await expect(alice.page.getByTestId("call-ringing-tile")).toBeVisible();

    // bob's devices ring: banner and ringtone (recorded by the development hook).
    const banner = bob.page.getByTestId("call-incoming");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(alice.username);
    await expect.poll(async () => (await cues(bob.page)).some((c) => c.cue === "ringtone")).toBe(true);
    await banner.getByTestId("call-accept").click();
    await expect(banner).toBeHidden();
    const bobView = bob.page.getByTestId("call-view");
    await expect(bobView).toBeVisible({ timeout: 30_000 });

    // Both connected, end-to-end encrypted, and each hears the other.
    for (const [me, other] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      await expect(me.page.getByTestId("call-view").getByTestId("voice-tile")).toHaveCount(2, { timeout: 30_000 });
      await expect.poll(async () => (await hooks(me.page)).remote.some((r) => r.identity.startsWith(`${other.address}/`) && r.isEncrypted), { timeout: 30_000 }).toBe(true);
      const state = await hooks(me.page);
      expect(state.e2eeEnabled && state.localEncrypted).toBe(true);
      const remote = state.remote.find((r) => r.identity.startsWith(`${other.address}/`))!;
      await expect.poll(() => inboundPeak(me.page, remote.identity), { timeout: 20_000 }).toBeGreaterThan(0.01);
    }
    // Muted, alice's microphone capture is released after a short grace period (on Android an open capture with echo
    // cancellation keeps the phone in its call audio mode, which made remote voices very quiet); unmuting opens it
    // again with the same device, and bob hears her again.
    expect((await hooks(alice.page)).capturing).toBe(true);
    const mute = alice.page.getByTestId("call-view").getByTestId("voice-mute");
    await mute.click();
    await expect.poll(async () => (await hooks(alice.page)).capturing, { timeout: 10_000 }).toBe(false);
    await mute.click();
    await expect.poll(async () => (await hooks(alice.page)).capturing, { timeout: 10_000 }).toBe(true);
    const aliceId = (await hooks(bob.page)).remote.find((r) => r.identity.startsWith(`${alice.address}/`))!.identity;
    await expect.poll(() => inboundPeak(bob.page, aliceId), { timeout: 20_000 }).toBeGreaterThan(0.01);
    await expect(alice.page.getByTestId("call-status")).toHaveText(/\d+:\d\d/);
    // Minimize and reopen (desktop: from the voice bar; phones: the pill).
    await alice.page.getByTestId("call-minimize").click();
    await expect(aliceView).toBeHidden();
    const width = alice.page.viewportSize()?.width ?? 1280;
    if (width < 768) await alice.page.getByTestId("call-pill").click();
    else await alice.page.getByTestId("call-open").click();
    await expect(aliceView).toBeVisible();

    // bob hangs up: the DM call ends for both, with a message about it.
    await bob.page.getByTestId("call-leave").click();
    await expect(bobView).toBeHidden();
    await expect(aliceView).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => callMessages(alice.page, id)).toEqual(["system.call.ended"]);
    const ended = alice.page.getByTestId("call-event");
    await expect(ended).toHaveAttribute("data-outcome", "ended");
    await expect(ended).toContainText(`Anruf von ${alice.username} beendet`);
    await expect(ended).toContainText(/· \d+:\d\d/);
  });

  test("Declining ends the call as missed", async ({ browser }) => {
    test.setTimeout(scaled(180_000));
    const alice = await voiceUser(browser, "calld", consoleLines);
    const bob = await voiceUser(browser, "calle", consoleLines);
    const id = await dmBetween(alice, bob);
    await alice.page.getByTestId("call-start").click();
    await expect(alice.page.getByTestId("call-view")).toBeVisible({ timeout: 30_000 });
    const banner = bob.page.getByTestId("call-incoming");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByTestId("call-decline").click();
    await expect(banner).toBeHidden();
    await expect(alice.page.getByTestId("call-view")).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => callMessages(bob.page, id)).toEqual(["system.call.missed"]);
    const missed = bob.page.getByTestId("call-event");
    await expect(missed).toHaveAttribute("data-outcome", "missed");
    await expect(missed).toContainText(`Verpasster Anruf von ${alice.username}`);
    // The ring left an entry in bob's notification center.
    const bells = bob.page.getByTestId("notification-bell");
    // Phones have one in the header and one in the (closed, off-screen) navigation drawer.
    const onScreen = await bells.evaluateAll((els) => els.findIndex((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth; }));
    await bells.nth(Math.max(0, onScreen)).click();
    const entry = bob.page.getByTestId("notification-entry").and(bob.page.locator('[data-kind="call"]'));
    await expect(entry).toContainText(`${alice.username} ruft an`);
  });

  test("A group call with three people shows who is in it", async ({ browser }) => {
    test.setTimeout(scaled(300_000));
    const alice = await voiceUser(browser, "calgf", consoleLines);
    const bob = await voiceUser(browser, "calgg", consoleLines);
    const carol = await voiceUser(browser, "calgh", consoleLines);
    await befriend(alice, bob);
    await befriend(alice, carol);
    const page = alice.page;
    await page.goto("/");
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Neue Gruppe" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Gruppenname (optional)").fill("Funkkreis");
    await dialog.getByTestId("dm-friend-picker").locator("label").filter({ hasText: bob.address }).getByRole("checkbox").check();
    await dialog.getByTestId("dm-friend-picker").locator("label").filter({ hasText: carol.address }).getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Gruppe erstellen" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText("Funkkreis");
    await send(page, "Gleich Gruppenanruf");
    for (const u of [bob, carol]) {
      await openConversation(u.page, /Funkkreis/);
      await expect(message(u.page, "Gleich Gruppenanruf")).toBeVisible({ timeout: 20_000 });
    }

    await page.getByTestId("call-start").click();
    await expect(page.getByTestId("call-view")).toBeVisible({ timeout: 30_000 });
    for (const u of [bob, carol]) {
      const banner = u.page.getByTestId("call-incoming");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute("data-group", "true");
      await expect(banner).toContainText("Funkkreis");
      await banner.getByTestId("call-accept").click();
      await expect(u.page.getByTestId("call-view")).toBeVisible({ timeout: 30_000 });
    }
    for (const u of [alice, bob, carol]) {
      await expect(u.page.getByTestId("call-view").getByTestId("voice-tile")).toHaveCount(3, { timeout: 40_000 });
      const who = u.page.getByTestId("call-who");
      for (const other of [alice, bob, carol]) await expect(who).toContainText(other.username);
    }
    // One leaves: the group call goes on for the others.
    await carol.page.getByTestId("call-leave").click();
    await expect(page.getByTestId("call-view").getByTestId("voice-tile")).toHaveCount(2, { timeout: 20_000 });
    await expect(bob.page.getByTestId("call-view")).toBeVisible();
  });
});
