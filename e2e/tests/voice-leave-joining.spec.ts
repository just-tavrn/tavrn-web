// SPDX-License-Identifier: Apache-2.0
// Leave while joining (VOICE.md §3): the voice bar offers Leave as soon as a join starts. Pressed before the join is
// done, it cancels the attempt: the call never connects, the microphone is not published, the seat the node gave is
// freed and no error is shown. The node's answer to voice/join is held back so the click lands in the join.
import { expect, test } from "@playwright/test";
import { createRoomViaApi, openNavIfMobile, tokenOf } from "./helpers";
import { FAKE_MEDIA, closeOpened, voiceUser } from "./voice-helpers";
import { scaled } from "./timeouts";

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });
test.afterEach(closeOpened);

test("leave while joining cancels the join: no call, no seat, no error", async ({ browser, request }) => {
  test.setTimeout(scaled(120_000));
  const u = await voiceUser(browser, "vlj", undefined, { cuesOff: true });
  const room = await createRoomViaApi(request, await tokenOf(u.page), "Abbruch", "invite", { encrypted: true });
  let held = 0;
  await u.page.route("**/voice/join", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    held += 1;
    // Long enough for the phone, where the voice bar sits in the navigation drawer that has to be opened first.
    await new Promise((r) => setTimeout(r, 6_000));
    await route.continue();
  });
  await u.page.goto(`/rooms/${room.id}`);
  await openNavIfMobile(u.page);
  await u.page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
  const bar = u.page.getByTestId("voice-bar");
  await expect(bar).toHaveAttribute("data-status", "joining", { timeout: scaled(20_000) });
  await expect.poll(() => held, { timeout: scaled(20_000) }).toBe(1);
  // While joining, only the voice bar offers Leave (the stage still shows its join panel); on phones it is in the
  // navigation drawer, which closed when the channel opened.
  await openNavIfMobile(u.page);
  await u.page.getByTestId("voice-bar-leave").click();
  await expect(bar).toHaveCount(0);
  // The held answer arrives meanwhile: the cancelled join neither connects nor comes back.
  await u.page.waitForTimeout(6_000); // a window in which nothing may happen (not scaled)
  await expect(bar).toHaveCount(0);
  await expect(u.page.locator('[role="status"], [role="alert"]').filter({ hasText: /Verbindung|fehlgeschlagen|failed/i })).toHaveCount(0);
  // The node does not keep the seat: nobody is listed in the channel.
  await expect(u.page.getByTestId("voice-participant").and(u.page.locator(`[data-user="${u.address}"]`))).toHaveCount(0, { timeout: scaled(15_000) });
});
