// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, tokenOf } from "./helpers";
import { closeOpened, voiceUser } from "./voice-helpers";
import { openContextMenu } from "./menu-helpers";

test.afterEach(closeOpened);

test("ordinary members configure personal whisper groups from a voice channel without joining voice", async ({ browser, request }) => {
  const owner = await voiceUser(browser, "wgown");
  const member = await voiceUser(browser, "wgmem");
  const room = await createRoomViaApi(request, await tokenOf(owner.page), "Whisper settings");
  const roomId = room.id as string;
  const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
  const code = await inviteCode(request, await tokenOf(owner.page), roomId);
  const join = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(member.page)}` }, data: {} });
  expect(join.ok()).toBeTruthy();
  const page = member.page;
  await page.goto(`/rooms/${roomId}/channels/${voiceId}`);
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByTestId("nav-toggle").click();
  const row = page.getByTestId("voice-channel").filter({ has: page.locator(`[href$='/channels/${voiceId}']`) });
  await openContextMenu(page, row.getByTestId("voice-channel-header"));
  await page.getByTestId("channel-menu").getByRole("menuitem", { name: "Flüstern", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}/settings/whisper$`));
  await expect(page.getByRole("heading", { name: "Flüstern", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Gruppenname" }).fill("Team");
  await page.getByRole("button", { name: "Neue Flüstergruppe" }).click();
  const group = page.getByRole("group", { name: "Team", exact: true });
  await group.getByRole("combobox", { name: "Raummitglied hinzufügen" }).fill(owner.username);
  await page.getByRole("option").click();
  await expect(group.getByRole("list", { name: "Mitglieder", exact: true })).toContainText(owner.address);
  await page.reload();
  await expect(page.getByRole("group", { name: "Team", exact: true })).toContainText(owner.address);
  await expect(page.getByTestId("voice-e2ee")).toHaveCount(0);
});
