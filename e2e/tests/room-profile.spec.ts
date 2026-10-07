// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, registerViaApi } from "./helpers";

/** Phase 4E settings of track S: per-room profile, welcome channel switch, upload categories (design note 4.11). */

async function join(request: APIRequestContext, token: string, code: string) {
  const resp = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${token}` }, data: {} });
  expect(resp.ok()).toBeTruthy();
}

async function api(request: APIRequestContext, token: string, path: string) {
  const resp = await request.get(`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(resp.ok()).toBeTruthy();
  return resp.json();
}

test.describe("Room settings (phase 4E)", () => {
  test("a member sets and resets their profile in a room", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Profile");
    await join(request, bob.token, await inviteCode(request, alice.token, room.id));
    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}/settings/profile`);
    const section = page.getByTestId("room-profile");
    await expect(section).toContainText("Mein Profil in diesem Raum");
    await page.getByTestId("room-nickname").fill("Heiler");
    await page.getByTestId("room-bio").fill("**Main** healer");
    await section.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("Gespeichert")).toBeVisible();
    const me = (await api(request, bob.token, `/rooms/${room.id}/members`)).find((m: { user: { id: string } }) => m.user.id === bob.userId);
    expect([me.nick, me.room_bio]).toEqual(["Heiler", "**Main** healer"]);
    // Shown again after a reload; reset clears it.
    await page.reload();
    await expect(page.getByTestId("room-nickname")).toHaveValue("Heiler");
    await page.getByTestId("room-profile-reset").click();
    await expect(page.getByTestId("room-nickname")).toHaveValue("");
    const after = (await api(request, bob.token, `/rooms/${room.id}/members`)).find((m: { user: { id: string } }) => m.user.id === bob.userId);
    expect(after.nick ?? null).toBeNull();
  });

  test("the owner limits uploads to images; the welcome channel has no switch any more", async ({ browser, page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Regeln");
    await join(request, bob.token, await inviteCode(request, alice.token, room.id));
    expect(room.channels.some((c: { kind: string; system_name: string }) => c.kind === "system" && c.system_name === "welcome")).toBe(true);
    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}/settings/overview`);
    // The welcome channel is the room's security log (design note 4.13 item 12): it cannot be switched off.
    await expect(page.getByTestId("upload-category-images")).toBeVisible();
    await expect(page.getByTestId("welcome-enabled")).toHaveCount(0);

    // Upload categories of @everyone: only images.
    for (const c of ["audio", "video", "documents", "archives", "other"]) {
      const box = page.getByTestId(`upload-category-${c}`);
      await box.uncheck();
      await expect(box).not.toBeChecked();
    }
    await expect(page.getByTestId("upload-category-images")).toBeChecked();
    const policyOf = async () => (await api(request, bob.token, `/conversations/${room.channels.find((c: { kind: string }) => c.kind === "text").id}/upload-policy`)).allowed_categories;
    await expect.poll(policyOf).toEqual(["images"]);

    // Bob's composer shows it and refuses a PDF before uploading anything.
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    await loginAs(bobPage, bob);
    await bobPage.goto(`/rooms/${room.id}`);
    await expect(bobPage.getByTestId("upload-allowed")).toHaveText("Hier erlaubte Uploads: Bilder");
    await bobPage.getByTestId("file-input").setInputFiles({ name: "regeln.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 test") });
    await expect(bobPage.getByTestId("upload-error")).toHaveText("Dokumente dürfen hier nicht hochgeladen werden");
    await bobContext.close();
  });
});
