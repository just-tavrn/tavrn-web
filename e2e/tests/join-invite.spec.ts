// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi } from "./helpers";

test.describe('Joining in the "+" dialog', () => {
  test("Paste an invite link, preview, join; invalid invites are explained", async ({ page, request, baseURL }) => {
    const owner = await registerViaApi(request, "owner");
    const guest = await registerViaApi(request, "guest");
    const room = await createRoomViaApi(request, owner.token, "Stammtisch");
    const code = await inviteCode(request, owner.token, room.id);
    await loginAs(page, guest);
    await page.goto("/");
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("tab-join-invite").click();

    // Not a link at all, then an expired or unknown code: friendly explanations.
    const input = dialog.getByLabel("Einladungslink oder Code");
    await input.fill("das ist kein link");
    await dialog.getByTestId("join-invite-check").click();
    await expect(dialog.getByRole("alert")).toHaveText("Das ist kein Einladungslink und kein Code.");
    await input.fill(`${baseURL}/invite/GibtEsNicht123`);
    await dialog.getByTestId("join-invite-check").click();
    await expect(dialog.getByRole("alert")).toContainText("ungültig oder abgelaufen");

    // A valid link: preview, then join.
    await input.fill(`${baseURL}/invite/${code}`);
    await dialog.getByTestId("join-invite-check").click();
    await expect(dialog.getByTestId("join-preview-name")).toHaveText("Stammtisch");
    await dialog.getByTestId("join-invite-submit").click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openNavIfMobile(page);
    await expect(page.getByTestId("room-name")).toHaveText("Stammtisch");

    // A bare code works too (already a member: the room opens again).
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    await page.getByRole("dialog").getByTestId("tab-join-invite").click();
    await page.getByRole("dialog").getByLabel("Einladungslink oder Code").fill(code);
    await page.getByRole("dialog").getByTestId("join-invite-check").click();
    await expect(page.getByRole("dialog").getByTestId("join-preview-name")).toHaveText("Stammtisch");
  });
});
