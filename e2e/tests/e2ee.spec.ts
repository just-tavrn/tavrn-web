// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, loginViaUi, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, type UiAccount, openRoomInvite } from "./helpers";
import { createGroup, cryptoAccountViaApi, externalJoin, freshIdentityKey, resetAndReattest, sendEncrypted } from "./crypto-helpers";
import { scaled } from "./timeouts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A browser context of the same device type as the current project. */
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 15_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

async function createRoomInUi(page: Page, name: string): Promise<string> {
  await openNavIfMobile(page);
  await page.getByRole("button", { name: "Raum erstellen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Erstellen" }).click();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  return page.url();
}

async function inviteLink(page: Page): Promise<string> {
  await openRoomInvite(page);
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  await page.getByRole("button", { name: "Fertig" }).click();
  await closeDrawers(page);
  return link;
}

/** Phones: close an open navigation or member drawer before using the message area. */
async function closeDrawers(page: Page) {
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (!(await overlay.isVisible())) return;
  // The navigation drawer covers the left side of the overlay, the member drawer the right side.
  const members = (await page.getByTestId("members-drawer").getAttribute("data-open")) === "true";
  await overlay.click({ position: { x: members ? 8 : (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
}

test.describe("End-to-end encryption", () => {
  test("encrypted channel: two people, reactions, pins, editing, image, reload, new device via the backup", async ({ browser, page }) => {
    test.setTimeout(scaled(180_000));
    const alice = await registerViaUi(page, { prefix: "alice" });
    const roomUrl = await createRoomInUi(page, "Geheimbund");
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByTestId("unencrypted-banner")).toHaveCount(0);
    await openNavIfMobile(page);
    await expect(page.getByRole("link", { name: /allgemein/ }).getByTestId("channel-lock")).toBeVisible();
    await page.goto(roomUrl);
    await send(page, "Vor Bobs Beitritt");
    await expect(message(page, "Vor Bobs Beitritt")).toBeVisible();
    const link = await inviteLink(page);

    const bobPage = await newPage(browser);
    await registerViaUi(bobPage, { prefix: "bob" });
    await bobPage.goto(link);
    await bobPage.getByRole("button", { name: "Beitreten" }).click();
    await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");
    // Bob joined after this message: with the default policy `since_join` the node does not serve it to him
    // (ENCRYPTION.md §7b), his device has no key for it anyway (§5.4).
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);
    await expect(bobPage.getByTestId("message-list")).not.toContainText("Vor Bobs Beitritt");

    await send(bobPage, "Hallo von Bob");
    await expect(message(page, "Hallo von Bob")).toBeVisible();
    await send(page, "Willkommen, Bob!");
    await expect(message(bobPage, "Willkommen, Bob!")).toBeVisible();

    // Reactions, pins and edits work on encrypted messages.
    const bobsMessage = message(page, "Hallo von Bob");
    await bobsMessage.hover();
    await bobsMessage.getByRole("button", { name: "Reagieren" }).click();
    await page.getByRole("menuitem", { name: "🔥" }).click();
    await expect(message(bobPage, "Hallo von Bob").getByRole("button", { name: "🔥 1" })).toBeVisible();
    await bobsMessage.hover();
    await bobsMessage.getByRole("button", { name: "Anpinnen", exact: true }).click();
    await page.getByRole("button", { name: "Angepinnte Nachrichten" }).click();
    await expect(page.getByTestId("pin-panel")).toContainText("Hallo von Bob");
    const own = message(bobPage, "Hallo von Bob");
    await own.hover();
    await own.getByRole("button", { name: "Nachricht bearbeiten" }).click();
    await bobPage.getByLabel("Neuer Text").fill("Hallo von Bob, bearbeitet");
    await bobPage.keyboard.press("Enter");
    await expect(message(page, "Hallo von Bob, bearbeitet")).toContainText("(bearbeitet)");

    // Encrypted image: uploaded as ciphertext, shown after decryption on the other side.
    await page.getByLabel("Datei auswählen").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("pending-uploads")).toContainText("pixel.png");
    await send(page, "Ein Bild");
    await expect(message(bobPage, "Ein Bild").getByTestId("attachment-image").locator("img")).toBeVisible();
    await expect(message(bobPage, "Ein Bild")).toContainText("pixel.png");
    const blobId = await message(page, "Ein Bild").getAttribute("data-message-id");
    const stored = await (await page.request.get(`${NODE}/api/v1/conversations/${roomUrl.split("/channels/")[1]}/messages`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` } })).json();
    const envelope = stored.find((m: { id: string }) => m.id === blobId);
    expect(envelope.encrypted).toBe(true);
    expect(typeof envelope.content).toBe("string");
    expect(JSON.stringify(envelope)).not.toContain("Ein Bild");
    expect(envelope.attachments[0].name).toBe("");

    // Reload: the epoch keys are stored locally.
    await page.reload();
    await expect(message(page, "Vor Bobs Beitritt")).toBeVisible();
    await expect(message(page, "Willkommen, Bob!")).toBeVisible();

    // A new browser of Alice, unlocked with the recovery key, reads the history from the backup.
    const laptop = await newPage(browser);
    await loginViaUi(laptop, alice);
    await laptop.getByTestId("recovery-key-input").fill(alice.recoveryWords);
    await laptop.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(laptop.getByTestId("app-shell")).toBeVisible();
    await laptop.goto(roomUrl);
    await expect(message(laptop, "Vor Bobs Beitritt")).toBeVisible({ timeout: 20_000 });
    await expect(message(laptop, "Hallo von Bob, bearbeitet")).toBeVisible();
    await expect(laptop.getByTestId("undecryptable")).toHaveCount(0);
    await send(laptop, "Vom Laptop");
    await expect(message(bobPage, "Vom Laptop")).toBeVisible();
    await bobPage.context().close();
    await laptop.context().close();
  });
});

async function befriendViaApi(a: Page, b: UiAccount) {
  const resp = await a.request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${await tokenOf(a)}` }, data: { user: b.username } });
  expect(resp.ok()).toBeTruthy();
}

async function acceptViaApi(page: Page) {
  const token = await tokenOf(page);
  const list = await (await page.request.get(`${NODE}/api/v1/users/me/friends`, { headers: { Authorization: `Bearer ${token}` } })).json();
  for (const r of list.incoming) await page.request.post(`${NODE}/api/v1/users/me/friends/requests/${r.id}/accept`, { headers: { Authorization: `Bearer ${token}` } });
}

async function openMembers(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1280 && (await page.getByTestId("members-drawer").getAttribute("data-open")) !== "true") await page.getByRole("button", { name: "Mitglieder öffnen" }).click();
}

test.describe("Direct messages and groups", () => {
  test("Friend request, DM in both directions, group with three people, leaving", async ({ browser, page }) => {
    test.setTimeout(scaled(240_000));
    const alice = await registerViaUi(page, { prefix: "alice" });
    const bobPage = await newPage(browser);
    // Bob has a display name: the DM shows it in the header, the member list and on his messages alike.
    const bob = await registerViaUi(bobPage, { prefix: "bob", displayName: "Bob Baumann" });
    const carolPage = await newPage(browser);
    const carol = await registerViaUi(carolPage, { prefix: "carol" });

    // Friend request through the UI, accepted live on the other side.
    await page.goto("/friends");
    await page.getByLabel("Benutzername oder Adresse").fill(bob.username);
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Anfrage an ${bob.address} gesendet` })).toBeVisible();
    await expect(page.getByTestId("friends-outgoing")).toContainText(bob.address);
    await expect(bobPage.getByRole("status").filter({ hasText: "Neue Freundschaftsanfrage" })).toBeVisible();
    await bobPage.goto("/friends");
    await expect(bobPage.getByTestId("friends-incoming")).toContainText(alice.address);
    await bobPage.getByTestId("friends-incoming").getByRole("button", { name: "Annehmen" }).click();
    await expect(bobPage.getByTestId("friends-list")).toContainText(alice.address);
    await expect(page.getByTestId("friends-list")).toContainText(bob.address);
    await befriendViaApi(page, carol);
    await acceptViaApi(carolPage);

    // DM: Alice writes first; Bob's device is added with a Welcome and reads it.
    await page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText("Bob Baumann");
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await send(page, "Hallo Bob, ganz privat");
    await bobPage.goto("/");
    await openNavIfMobile(bobPage);
    const dm = bobPage.getByTestId("dm-list").getByRole("link", { name: new RegExp(alice.username) });
    await expect(dm.getByTestId("unread-count")).toHaveText("1");
    await dm.click();
    await expect(message(bobPage, "Hallo Bob, ganz privat")).toBeVisible();
    await openNavIfMobile(bobPage);
    await expect(bobPage.getByTestId("dm-list").getByRole("link", { name: new RegExp(alice.username) }).getByTestId("unread-count")).toHaveCount(0);
    await closeDrawers(bobPage);
    // Typing indicator in a DM (only the members get it).
    const bobBox = bobPage.getByLabel("Nachricht", { exact: true });
    await expect(bobBox).toBeEnabled({ timeout: 15_000 });
    await bobBox.fill("Hallo Al");
    await expect(page.getByTestId("typing-indicator")).toHaveText("Jemand schreibt…");
    await send(bobPage, "Hallo Alice, angekommen");
    await expect(message(page, "Hallo Alice, angekommen")).toBeVisible();
    await expect(message(page, "Hallo Alice, angekommen").getByTestId("message-author")).toHaveText("Bob Baumann");
    await expect(message(page, "Hallo Alice, angekommen").getByTestId("message-avatar")).toHaveAccessibleName(/Bob Baumann/);
    await openMembers(page);
    await expect(page.getByTestId("conversation-members")).toContainText(bob.address);

    // Group DM with three people.
    await page.goto("/");
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Neue Gruppe" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Gruppenname (optional)").fill("Kleeblatt");
    await dialog.getByTestId("dm-friend-picker").locator("label").filter({ hasText: bob.address }).getByRole("checkbox").check();
    await dialog.getByTestId("dm-friend-picker").locator("label").filter({ hasText: carol.address }).getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Gruppe erstellen" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText("Kleeblatt");
    await send(page, "Hallo Gruppe");
    for (const p of [bobPage, carolPage]) {
      await p.goto("/");
      await openNavIfMobile(p);
      await p.getByTestId("dm-list").getByRole("link", { name: /Kleeblatt/ }).click();
      await expect(message(p, "Hallo Gruppe")).toBeVisible();
    }
    await send(carolPage, "Hallo von Carol");
    await expect(message(page, "Hallo von Carol")).toBeVisible();
    await expect(message(bobPage, "Hallo von Carol")).toBeVisible();

    // Carol leaves; the others go on without her.
    await openMembers(carolPage);
    carolPage.once("dialog", (d) => d.accept());
    await carolPage.getByRole("button", { name: "Gruppe verlassen" }).click();
    await expect(carolPage).toHaveURL(/\/$/);
    await openNavIfMobile(carolPage);
    await expect(carolPage.getByTestId("dm-list")).not.toContainText("Kleeblatt");
    await openMembers(page);
    await expect(page.getByTestId("conversation-members")).not.toContainText(carol.address);
    await send(page, "Ohne Carol");
    await expect(message(bobPage, "Ohne Carol")).toBeVisible();
    await expect(page.getByTestId("ghost-warning")).toHaveCount(0);

    // Any member renames the group; the others see the new name live.
    await closeDrawers(page);
    await page.getByRole("button", { name: "Gruppe umbenennen" }).click();
    const rename = page.getByRole("dialog");
    await expect(rename.getByLabel("Gruppenname (optional)")).toHaveValue("Kleeblatt");
    await rename.getByLabel("Gruppenname (optional)").fill("Vierblatt");
    await rename.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText("Vierblatt");
    await expect(bobPage.getByTestId("conversation-name")).toHaveText("Vierblatt");
    await openNavIfMobile(bobPage);
    await expect(bobPage.getByTestId("dm-list")).toContainText("Vierblatt");
    await bobPage.context().close();
    await carolPage.context().close();
  });
});

test.describe("Trust and devices", () => {
  test("Security key changed after a contact resets their identity", async ({ browser, page }) => {
    test.setTimeout(scaled(150_000));
    await registerViaUi(page, { prefix: "alice" });
    const roomUrl = await createRoomInUi(page, "Vertrauen");
    const link = await inviteLink(page);
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    await bobPage.goto(link);
    await bobPage.getByRole("button", { name: "Beitreten" }).click();
    await send(bobPage, "Ich bin Bob");
    await expect(message(page, "Ich bin Bob")).toBeVisible();
    await expect(page.getByTestId("key-changed-badge")).toHaveCount(0);

    // Bob resets his identity (new identity key); Alice is told and sees the notice.
    const resp = await bobPage.request.post(`${NODE}/api/v1/users/me/identity/reset`, { headers: { Authorization: `Bearer ${await tokenOf(bobPage)}` }, data: { identity_public_key: await freshIdentityKey(), password: bob.password } });
    expect(resp.status()).toBe(204);
    // Bob's own browser notices that its key is stale and asks to unlock again.
    await expect(bobPage).toHaveURL(/\/encryption/);
    await openMembers(page);
    const badge = page.getByTestId("member-list").getByTestId("key-changed-badge");
    await expect(badge).toBeVisible();
    await expect(message(page, "Ich bin Bob").getByTestId("key-changed-badge")).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await badge.click();
    await expect(page.getByTestId("key-changed-badge")).toHaveCount(0);
    await page.goto(roomUrl);
    await expect(page.getByTestId("key-changed-badge")).toHaveCount(0);
    await bobPage.context().close();
  });

  test("A changed security key holds the contact's device back until it is acknowledged", async ({ page, request }) => {
    test.setTimeout(scaled(150_000));
    // Bob runs his encryption in the test process; Alice uses the browser.
    const bob = await cryptoAccountViaApi(request, "bob");
    const room = await createRoomViaApi(request, bob.token, "Schluesselwechsel", "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await createGroup(request, bob, channel);
    await sendEncrypted(request, bob, channel, "Hallo von Bob");
    const code = await inviteCode(request, bob.token, room.id);
    await registerViaUi(page, { prefix: "alice" });
    await page.goto(`/invite/${code}`);
    await page.getByRole("button", { name: "Beitreten" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    // Alice's device is in the group (her own message goes out) and Bob's device counts.
    await send(page, "Hallo Bob");
    await expect(message(page, "Hallo Bob")).toBeVisible();
    await expect(page.getByTestId("ghost-warning")).toHaveCount(0);
    const roomUrl = page.url();

    // While Alice is away, Bob resets his key and his device comes back attested under the new one.
    await page.goto("/");
    await resetAndReattest(request, bob);
    await page.goto(roomUrl);
    const warning = page.getByTestId("ghost-warning");
    await expect(warning).toContainText(`${bob.address}/${bob.deviceId}`, { timeout: 30_000 });
    await expect(warning).toContainText("Änderung noch nicht bestätigt");
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeDisabled();

    // Acknowledging the changed key lets the device count: the warning goes, sending works.
    await openMembers(page);
    const badge = page.getByTestId("member-list").getByTestId("key-changed-badge");
    page.once("dialog", (d) => d.accept());
    await badge.click();
    await closeDrawers(page);
    await expect(warning).toHaveCount(0, { timeout: 30_000 });
    await send(page, "Willkommen zurück");
    await expect(message(page, "Willkommen zurück")).toBeVisible();
  });

  test("Ghost check: a device of a non-member in the group blocks sending until confirmed", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    // Alice (owner) and Mallory run their encryption in the test process; Bob uses the browser.
    const alice = await cryptoAccountViaApi(request, "alice");
    const room = await createRoomViaApi(request, alice.token, "Geisterhaus", "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    await createGroup(request, alice, channel);
    await sendEncrypted(request, alice, channel, "Hallo aus dem Testprozess");
    const mallory = await cryptoAccountViaApi(request, "mallory");
    const code = await inviteCode(request, alice.token, room.id);
    expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${mallory.token}` }, data: {} })).ok()).toBeTruthy();
    await externalJoin(request, mallory, channel);
    // Mallory leaves the room, but nobody with the right to remove her device is online.
    expect((await request.post(`${NODE}/api/v1/rooms/${room.id}/leave`, { headers: { Authorization: `Bearer ${mallory.token}` }, data: {} })).ok()).toBeTruthy();

    await registerViaUi(page, { prefix: "bob" });
    await page.goto(`/invite/${code}`);
    await page.getByRole("button", { name: "Beitreten" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    const warning = page.getByTestId("ghost-warning");
    await expect(warning).toContainText("Ein unbekanntes Gerät ist Teil dieser Unterhaltung");
    await expect(warning).toContainText(`${mallory.address}/${mallory.deviceId}`);
    await expect(warning).toContainText("kein Mitglied dieser Unterhaltung");
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeDisabled();
    await expect(page.getByText("Bestätige zuerst die Warnung zum unbekannten Gerät.")).toBeVisible();
    await warning.getByRole("button", { name: "Ich verstehe" }).click();
    await expect(warning).toBeVisible();
    await send(page, "Trotzdem gesendet");
    await expect(message(page, "Trotzdem gesendet")).toBeVisible();
  });
});

test.describe("Toggling encryption and restricted mode", () => {
  test("encrypted channel without keys is locked; turning it off shows a system message and the marker", async ({ page, request }) => {
    const owner = await registerViaApi(request, "own");
    const room = await createRoomViaApi(request, owner.token, "Umschalt-Raum", "invite", { encrypted: true });
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByTestId("e2ee-locked")).toBeVisible();
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeDisabled();
    await openNavIfMobile(page);
    await expect(page.getByTestId("channel-lock")).toBeVisible();

    await page.goto(`/rooms/${room.id}/settings/channels`);
    const editor = page.getByTestId("channel-editor");
    await editor.getByTestId("encrypted-toggle").uncheck();
    await editor.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Ausschalten" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Channel gespeichert" })).toBeVisible();
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("unencrypted-banner")).toBeVisible();
    await expect(page.getByTestId("system-message")).toContainText("Verschlüsselung ausgeschaltet");
    await expect(page.getByTestId("e2ee-locked")).toHaveCount(0);
    await openNavIfMobile(page);
    // (The welcome channel is unencrypted by design and carries the marker too.)
    await expect(page.getByRole("link", { name: /allgemein/ }).getByTestId("channel-unlocked")).toBeVisible();
  });
});
