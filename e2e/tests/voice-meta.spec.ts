// SPDX-License-Identifier: Apache-2.0
// The voice header's session timer and the channel status (tavrn-protocol VOICE.md §5 `session_started_at`, §2a
// `status`, permissions.md bit 38; docs/CLIENT.md "Voice channels"): the timer counts from the node's session start
// for the joiner and for a member who only looks at the channel, the row's tooltip names the running time and the
// status, and the status is edited in place by members with `voice_status` only (Enter saves, Escape cancels).
// axe scans the header with the editor open.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, openNavIfMobile, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const CLOCK = /^\d\d:\d\d:\d\d$/;

async function api<T>(request: APIRequestContext, method: "post" | "patch" | "get", path: string, token: string, data?: unknown): Promise<T> {
  const resp = await request[method](`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
  expect(resp.ok(), `${method} ${path}: ${await resp.text()}`).toBeTruthy();
  return (await resp.json().catch(() => null)) as T;
}

/** The visible digits of the header timer (the live region's text is announced, not shown). */
const clock = (page: Page) => page.getByTestId("voice-session-timer").locator("[aria-hidden]");

/** The voice channel's row in the channel list (the drawer on phones). */
async function voiceRow(page: Page) {
  await openNavIfMobile(page);
  return page.getByRole("link", { name: "Sprachkanal Sprache" });
}

/** Closes the phone's navigation drawer again (it covers the stage header while open). */
async function closeNavIfMobile(page: Page) {
  const drawer = page.getByTestId("nav-drawer");
  // The backdrop's centre lies under the drawer itself, so a tap there is intercepted: the click event is enough.
  if ((await drawer.getAttribute("data-open")) === "true") await page.getByRole("button", { name: "Drawer schließen" }).dispatchEvent("click");
  await expect(drawer).not.toHaveAttribute("data-open", "true");
}

test.describe("Voice session timer and channel status", () => {
  test("timer for the joiner and a late viewer, tooltip, status edit with the bit only", async ({ browser, request }) => {
    test.setTimeout(scaled(240_000));
    const owner = await voiceUser(browser, "vmown");
    const member = await voiceUser(browser, "vmmem");
    const ownerToken = await tokenOf(owner.page);
    const memberToken = await tokenOf(member.page);
    const room = await createRoomViaApi(request, ownerToken, "Stammtisch");
    const roomId = room.id as string;
    const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
    await api(request, "post", `/invites/${await inviteCode(request, ownerToken, roomId)}/join`, memberToken, {});

    // The member looks at the empty channel: no timer, no status, no pencil (no permission).
    await member.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await expect(member.page.getByTestId("voice-join-panel")).toBeVisible({ timeout: scaled(30_000) });
    await expect(member.page.getByTestId("voice-session-timer")).toHaveCount(0);
    await expect(member.page.getByTestId("voice-status")).toHaveCount(0);
    await expect(member.page.getByTestId("voice-status-edit")).toHaveCount(0);

    // The owner joins: the timer runs in their header.
    await owner.page.goto(`/rooms/${roomId}/channels/${voiceId}`);
    await owner.page.getByTestId("voice-join").click();
    await expect(owner.page.getByTestId("voice-stage")).toBeVisible({ timeout: scaled(30_000) });
    await expect(clock(owner.page)).toHaveText(CLOCK, { timeout: scaled(30_000) });
    const first = await clock(owner.page).textContent();
    await expect.poll(() => clock(owner.page).textContent(), { timeout: scaled(10_000) }).not.toBe(first);
    await expect(owner.page.getByTestId("voice-session-announce")).toHaveAttribute("aria-live", "polite");

    // The late viewer sees the same session's timer (from voice.state) and the running time in the row's tooltip.
    await expect(clock(member.page)).toHaveText(CLOCK, { timeout: scaled(30_000) });
    const row = await voiceRow(member.page);
    await expect(row).toHaveAttribute("title", /^Läuft seit \d\d:\d\d:\d\d$/);
    await closeNavIfMobile(member.page);

    // The owner (every bit) sets the status in place: Escape throws a draft away, Enter saves.
    await owner.page.getByRole("button", { name: "Kanalstatus bearbeiten" }).click();
    const input = owner.page.getByRole("textbox", { name: "Kanalstatus" });
    await expect(input).toBeFocused();
    await input.fill("Verworfen");
    await input.press("Escape");
    await expect(owner.page.getByTestId("voice-status-editor")).toHaveCount(0);
    await owner.page.getByRole("button", { name: "Kanalstatus bearbeiten" }).click();
    await owner.page.getByRole("textbox", { name: "Kanalstatus" }).fill("Raid um neun");
    await expect(owner.page.getByTestId("voice-status-counter")).toContainText("12/128");
    const axe = await new AxeBuilder({ page: owner.page }).include('[data-testid="voice-stage"] header').withTags(TAGS).analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await owner.page.getByRole("textbox", { name: "Kanalstatus" }).press("Enter");
    await expect(owner.page.getByTestId("voice-status")).toHaveText("Raid um neun");

    // channel.update brings it to the member: under the name and in the tooltip, still without a pencil.
    await expect(member.page.getByTestId("voice-status")).toHaveText("Raid um neun", { timeout: scaled(20_000) });
    await expect(await voiceRow(member.page)).toHaveAttribute("title", /^Raid um neun\nLäuft seit \d\d:\d\d:\d\d$/);
    await closeNavIfMobile(member.page);
    await expect(member.page.getByTestId("voice-status-edit")).toHaveCount(0);

    // A role with voice_status alone (bit 38) lets the member edit it; the owner sees the change.
    const role = await api<{ id: string }>(request, "post", `/rooms/${roomId}/roles`, ownerToken, { name: "Gastgeber", permissions: (1n << 38n).toString(), position: 1 });
    const members = await api<{ user: { id: string; address: string } }[]>(request, "get", `/rooms/${roomId}/members`, ownerToken);
    const memberId = members.find((m) => m.user.address === member.address)!.user.id;
    await api(request, "patch", `/rooms/${roomId}/members/${memberId}`, ownerToken, { roles: [role.id] });
    await member.page.getByRole("button", { name: "Kanalstatus bearbeiten" }).click({ timeout: scaled(20_000) });
    await member.page.getByRole("textbox", { name: "Kanalstatus" }).fill("Planung bis zehn");
    await member.page.getByRole("textbox", { name: "Kanalstatus" }).press("Enter");
    await expect(member.page.getByTestId("voice-status")).toHaveText("Planung bis zehn");
    await expect(owner.page.getByTestId("voice-status")).toHaveText("Planung bis zehn", { timeout: scaled(20_000) });

    // The last participant leaves: the session ends, the timer goes for everybody.
    await owner.page.getByTestId("voice-leave").click();
    await expect(owner.page.getByTestId("voice-join-panel")).toBeVisible({ timeout: scaled(20_000) });
    await expect(owner.page.getByTestId("voice-session-timer")).toHaveCount(0, { timeout: scaled(20_000) });
    await expect(member.page.getByTestId("voice-session-timer")).toHaveCount(0, { timeout: scaled(20_000) });
    await expect(await voiceRow(member.page)).toHaveAttribute("title", "Planung bis zehn");
  });
});
