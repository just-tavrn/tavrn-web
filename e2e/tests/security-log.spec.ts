// SPDX-License-Identifier: Apache-2.0
// The welcome channel as the room's security log (design note 4.13 item 12): joins, leaves and security key changes of
// members, visible to every member whatever the overrides say.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, registerViaUi, tokenOf } from "./helpers";
import { freshIdentityKey } from "./crypto-helpers";
import { openContextMenu } from "./menu-helpers";
import { scaled } from "./timeouts";

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

const message = (page: Page, text: string) => page.getByTestId("message").filter({ hasText: text });

async function joinInUi(page: Page, code: string) {
  await page.goto(`/invite/${code}`);
  await page.getByRole("button", { name: "Beitreten" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
}

test.describe("Security log in the welcome channel", () => {
  test("shows joins, leaves and key changes; no override hides it", async ({ browser, page, request }) => {
    test.setTimeout(scaled(180_000));
    const owner = await registerViaApi(request, "owner");
    const room = await createRoomViaApi(request, owner.token, "Protokoll");
    const wid = room.channels.find((c: { kind: string }) => c.kind === "system").id as string;
    const everyone = room.roles.find((r: { is_everyone: boolean }) => r.is_everyone).id as string;
    const auth = { Authorization: `Bearer ${owner.token}` };

    // Alice and Bob use browsers; Bob writes, so Alice's browser knows (pins) his security key.
    const alice = await registerViaUi(page, { prefix: "alice" });
    await joinInUi(page, await inviteCode(request, owner.token, room.id));
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    await joinInUi(bobPage, await inviteCode(request, owner.token, room.id));
    await send(bobPage, "Ich bin Bob");
    await expect(message(page, "Ich bin Bob")).toBeVisible({ timeout: 20_000 });

    // Carol joins and leaves over the API.
    const carol = await registerViaApi(request, "carol");
    expect((await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, owner.token, room.id)}/join`, { headers: { Authorization: `Bearer ${carol.token}` }, data: {} })).ok()).toBeTruthy();
    expect((await request.post(`${NODE}/api/v1/rooms/${room.id}/leave`, { headers: { Authorization: `Bearer ${carol.token}` }, data: {} })).ok()).toBeTruthy();

    // The owner tries to hide the channel: for @everyone and for Alice herself.
    const aliceId = (await (await page.request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).json()).id as string;
    for (const [subject_type, subject_id] of [["role", everyone], ["member", aliceId]]) {
      const resp = await request.put(`${NODE}/api/v1/rooms/${room.id}/overrides`, {
        headers: auth,
        data: { target_type: "channel", target_id: wid, subject_type, subject_id, allow: "0", deny: String(1 + 2 ** 34) },
      });
      expect(resp.ok(), await resp.text()).toBeTruthy();
    }

    // Bob resets his identity.
    const reset = await bobPage.request.post(`${NODE}/api/v1/users/me/identity/reset`, {
      headers: { Authorization: `Bearer ${await tokenOf(bobPage)}` },
      data: { identity_public_key: await freshIdentityKey(), password: bob.password },
    });
    expect(reset.status()).toBe(204);

    // Alice still sees the channel pinned at the top and reads the whole log.
    await page.goto(`/rooms/${room.id}/channels/${room.channels.find((c: { kind: string }) => c.kind === "text").id}`);
    await openNavIfMobile(page);
    const pinned = page.getByTestId("pinned-channels").getByTestId("channel-row");
    await expect(pinned).toHaveAttribute("data-kind", "system");
    await page.goto(`/rooms/${room.id}/channels/${wid}`);
    const events = page.getByTestId("member-event");
    await expect(events).toHaveCount(5, { timeout: 20_000 });
    expect(await events.evaluateAll((list) => list.map((e) => e.getAttribute("data-event")))).toEqual(["join", "join", "join", "join", "leave"]);
    await expect(events.last()).toContainText(`${carol.username} hat den Raum verlassen`);
    const key = page.getByTestId("key-event");
    await expect(key).toHaveCount(1);
    await expect(key).toHaveAttribute("data-rotated", "false");
    await expect(key).toContainText(`Der Sicherheitsschlüssel von ${bob.username} hat sich geändert`);
    // Alice's browser had pinned the old key: the same warning as everywhere else.
    await expect(key.getByTestId("key-changed-badge")).toBeVisible({ timeout: 20_000 });
    // Read-only: a note instead of the composer.
    await expect(page.getByTestId("read-only-note")).toContainText("Sicherheitsprotokoll des Raums");
    expect(alice.address).toContain("@");
    await bobPage.context().close();
  });

  test("its entries cannot be deleted, not even by the owner (MODERATION.md §3)", async ({ page, request }) => {
    const owner = await registerViaApi(request, "owner");
    const member = await registerViaApi(request, "member");
    const room = await createRoomViaApi(request, owner.token, "Unlöschbar");
    const wid = room.channels.find((c: { kind: string }) => c.kind === "system").id as string;
    expect((await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, owner.token, room.id)}/join`, { headers: { Authorization: `Bearer ${member.token}` }, data: {} })).ok()).toBeTruthy();
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${wid}`);
    const entry = page.getByTestId("member-event").filter({ hasText: member.username });
    await expect(entry).toBeVisible({ timeout: 20_000 });
    await openContextMenu(page, entry);
    const menu = page.getByTestId("message-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /löschen/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const id = await entry.getAttribute("data-message-id");
    const del = await request.delete(`${NODE}/api/v1/conversations/${wid}/messages/${id}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(del.status()).toBe(403);
    expect((await del.json()).code).toBe("message.system_protected");
    await expect(entry).toBeVisible();
  });
});
