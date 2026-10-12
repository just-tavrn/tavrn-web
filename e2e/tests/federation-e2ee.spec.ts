// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginViaUi, openNavIfMobile, registerViaUi, tokenOf, type UiAccount, openRoomInvite } from "./helpers";
import { freshIdentityKey } from "./crypto-helpers";
import { A, B, BROWSER_API_A, FEDERATION_BROWSER, NODE_A, NODE_B, WEB_A, WEB_B, chromiumOnly, indexOf } from "./federation-helpers";
import { scaled } from "./timeouts";

test.use(FEDERATION_BROWSER);

// End-to-end encryption across nodes (FEDERATION.md §3.5, §3.6, §4, §6): users of a.test and b.test in an
// encrypted room channel hosted on b.test, friends and DMs across the nodes, a group DM with members of
// both, key changes of a user of the other node, and a new device that restores everything from the
// conversation index and the backups. Crypto-heavy steps (MLS joins, Welcomes) get longer timeouts.
const CRYPTO = { timeout: scaled(20_000) };

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

/** Phones: close an open navigation or member drawer before using the message area. */
async function closeDrawers(page: Page) {
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (!(await overlay.isVisible())) return;
  const members = (await page.getByTestId("members-drawer").getAttribute("data-open")) === "true";
  await overlay.click({ position: { x: members ? 8 : (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
}

async function send(page: Page, text: string) {
  await closeDrawers(page);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled(CRYPTO);
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(message(page, text)).toBeVisible();
}

async function api(page: Page, base: string, method: "get" | "post", path: string, data?: unknown) {
  const resp = await page.request[method](`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data });
  expect(resp.ok(), `${method} ${path}: ${resp.status()} ${await resp.text()}`).toBeTruthy();
  return resp.status() === 204 ? null : resp.json();
}

/** `a` (home `aBase`) and `b` (home `bBase`) become friends across their nodes over the API. */
async function befriend(a: Page, aBase: string, b: Page, bBase: string, bAddress: string) {
  await api(a, aBase, "post", "/users/me/friends/requests", { user: bAddress });
  await expect.poll(async () => (await api(b, bBase, "get", "/users/me/friends")).incoming.length, CRYPTO).toBeGreaterThan(0);
  const { incoming } = await api(b, bBase, "get", "/users/me/friends");
  await api(b, bBase, "post", `/users/me/friends/requests/${incoming[0].id}/accept`);
  await expect.poll(async () => (await api(a, aBase, "get", "/users/me/friends")).friends.map((f: { user: { address: string } }) => f.user.address), CRYPTO).toContain(bAddress);
}

async function openDmList(page: Page, web: string) {
  await page.goto(`${web}/`);
  await openNavIfMobile(page);
  return page.getByTestId("dm-list");
}

test.describe("Encryption across nodes", () => {
  chromiumOnly();

  test("Room on B: direct invite from the invite list, chat with a reaction and an edit, the node only sees ciphertext", async ({ browser, page }) => {
    test.setTimeout(scaled(240_000));
    const alice = await registerViaUi(page, { prefix: "fea", web: WEB_A, domain: A });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "feb", web: WEB_B, domain: B });

    // Bob creates an encrypted room on his node b.test and writes before Alice joins.
    await openNavIfMobile(bobPage);
    await bobPage.getByRole("button", { name: "Raum erstellen" }).click();
    const roomName = `Brücke ${bob.username.slice(-5)}`;
    await bobPage.getByRole("dialog").getByLabel("Name").fill(roomName);
    await bobPage.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(bobPage.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(bobPage.getByTestId("encrypted-marker")).toBeVisible();
    const channelId = bobPage.url().split("/channels/")[1]!;
    await send(bobPage, "Vor Alices Beitritt");

    // Direct invite by address: it travels to Alice's home node a.test and shows up live.
    await openRoomInvite(bobPage);
    const dialog = bobPage.getByRole("dialog");
    await dialog.getByLabel("Eine Person direkt einladen").fill(alice.address);
    await dialog.getByRole("button", { name: "Einladung senden" }).click();
    await expect(bobPage.getByRole("status").filter({ hasText: `Einladung an ${alice.address} gesendet` })).toBeVisible();
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    await expect(page.getByRole("status").filter({ hasText: `Einladung zu ${roomName} von ${bob.address}` })).toBeVisible(CRYPTO);
    const invite = page.getByTestId("invite-list").getByTestId("invite").filter({ hasText: roomName });
    await expect(invite).toContainText(`Von ${bob.address} · auf ${B}`);
    await invite.getByRole("button", { name: "Annehmen" }).click();
    await expect(page).toHaveURL(new RegExp(`/n/${B}/rooms/[0-9A-Z]+/channels/${channelId}`), CRYPTO);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByTestId("invite-list")).toHaveCount(0);
    // The join is recorded in the index on a.test; Alice joined after Bob's first message, which the node
    // does not serve her under the default policy `since_join` (ENCRYPTION.md §7b).
    await expect.poll(async () => (await indexOf(page.request, NODE_A, await tokenOf(page))).items.map((e) => `${e.node}/${e.kind}`)).toContain(`${B}/room`);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByTestId("undecryptable")).toHaveCount(0);

    // Both write; MLS runs on b.test, keys come from each user's home node.
    await send(page, "Hallo aus a.test");
    await expect(message(bobPage, "Hallo aus a.test")).toBeVisible(CRYPTO);
    await send(bobPage, "Hallo aus b.test");
    await expect(message(page, "Hallo aus b.test")).toBeVisible(CRYPTO);
    await expect(page.getByTestId("ghost-warning")).toHaveCount(0);
    await expect(bobPage.getByTestId("ghost-warning")).toHaveCount(0);

    // A reaction from a.test and an edit of an encrypted message.
    const bobsMessage = message(page, "Hallo aus b.test");
    await bobsMessage.hover();
    await bobsMessage.getByRole("button", { name: "Reagieren" }).click();
    await page.getByRole("menuitem", { name: "🔥" }).click();
    await expect(message(bobPage, "Hallo aus b.test").getByRole("button", { name: "🔥 1" })).toBeVisible();
    const own = message(page, "Hallo aus a.test");
    await own.hover();
    await own.getByRole("button", { name: "Nachricht bearbeiten" }).click();
    await page.getByLabel("Neuer Text").fill("Hallo aus a.test, bearbeitet");
    await page.keyboard.press("Enter");
    await expect(message(bobPage, "Hallo aus a.test, bearbeitet")).toContainText("(bearbeitet)", CRYPTO);

    // b.test stores only ciphertext.
    const stored = await api(bobPage, NODE_B, "get", `/conversations/${channelId}/messages`);
    const user = stored.filter((m: { device_id?: string | null }) => !!m.device_id);
    expect(user.length).toBe(3);
    for (const m of user) {
      expect(m.encrypted).toBe(true);
      expect(typeof m.content).toBe("string");
    }
    expect(JSON.stringify(stored)).not.toContain("Hallo aus");
    expect(JSON.stringify(stored)).not.toContain("Vor Alices Beitritt");
    await bobPage.context().close();
  });

  test("Friends across nodes, DM in both directions, group with three people, the DM's node unreachable", async ({ browser, page }) => {
    test.setTimeout(scaled(300_000));
    const alice = await registerViaUi(page, { prefix: "fda", web: WEB_A, domain: A });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "fdb", web: WEB_B, domain: B });
    const carolPage = await newPage(browser);
    const carol = await registerViaUi(carolPage, { prefix: "fdc", web: WEB_A, domain: A });

    // Friend request by full address; b.test shows it live and Bob accepts there.
    await page.goto(`${WEB_A}/friends`);
    await page.getByLabel("Benutzername oder Adresse").fill(bob.address);
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Anfrage an ${bob.address} gesendet` })).toBeVisible();
    await expect(page.getByTestId("friends-outgoing")).toContainText(bob.address);
    await expect(bobPage.getByRole("status").filter({ hasText: "Neue Freundschaftsanfrage" })).toBeVisible(CRYPTO);
    await bobPage.goto(`${WEB_B}/friends`);
    await expect(bobPage.getByTestId("friends-incoming")).toContainText(alice.address);
    await bobPage.getByTestId("friends-incoming").getByRole("button", { name: "Annehmen" }).click();
    await expect(bobPage.getByTestId("friends-list")).toContainText(alice.address);
    await expect(page.getByTestId("friends-list")).toContainText(bob.address, CRYPTO);
    await befriend(page, NODE_A, carolPage, NODE_A, carol.address);

    // The DM lives on a.test (the initiator's home node); Bob's device gets in by Welcome there.
    await page.reload();
    await page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText(bob.username);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await send(page, "Hallo Bob, über zwei Knoten");

    // Bob: the DM appears by itself (invitation of a friend), marked with its node, with one unread message.
    const bobList = await openDmList(bobPage, WEB_B);
    const dm = bobList.getByRole("link", { name: new RegExp(alice.username) });
    await expect(dm).toBeVisible(CRYPTO);
    await expect(dm.getByTestId("conversation-node")).toHaveText(A);
    await expect(dm.getByTestId("unread-count")).toHaveText("1", CRYPTO);
    await dm.click();
    await expect(bobPage).toHaveURL(new RegExp(`/n/${A}/conversations/`));
    await expect(message(bobPage, "Hallo Bob, über zwei Knoten")).toBeVisible(CRYPTO);
    await send(bobPage, "Hallo Alice, angekommen");
    await expect(message(page, "Hallo Alice, angekommen")).toBeVisible(CRYPTO);
    await expect.poll(async () => (await indexOf(bobPage.request, NODE_B, await tokenOf(bobPage))).items.map((e) => `${e.node}/${e.kind}`), CRYPTO).toContain(`${A}/dm`);

    // a.test cannot be reached while Bob has the DM open: a clear notice, sending fails, retry recovers.
    await bobPage.route(`${BROWSER_API_A}/**`, (route) => route.abort("connectionrefused"));
    const box = bobPage.getByLabel("Nachricht", { exact: true });
    await box.fill("Geht das?");
    await bobPage.keyboard.press("Enter");
    const banner = bobPage.getByTestId("node-unreachable-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-node", A);
    await expect(banner).toContainText("Räume und Unterhaltungen");
    await bobPage.unroute(`${BROWSER_API_A}/**`);
    await banner.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(banner).toHaveCount(0);
    await send(bobPage, "Wieder da");
    await expect(message(page, "Wieder da")).toBeVisible(CRYPTO);

    // Group DM on a.test with Bob (b.test) and Carol (a.test).
    await page.goto(`${WEB_A}/`);
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Neue Gruppe" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Gruppenname (optional)").fill("Zwei Knoten");
    await dialog.getByTestId("dm-friend-picker").locator("label").filter({ hasText: bob.address }).getByRole("checkbox").check();
    await dialog.getByTestId("dm-friend-picker").locator("label").filter({ hasText: carol.address }).getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Gruppe erstellen" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText("Zwei Knoten");
    await send(page, "Hallo Gruppe");
    for (const [p, web] of [[bobPage, WEB_B], [carolPage, WEB_A]] as const) {
      const list = await openDmList(p, web);
      await list.getByRole("link", { name: /Zwei Knoten/ }).click(CRYPTO);
      await expect(message(p, "Hallo Gruppe")).toBeVisible(CRYPTO);
    }
    await send(bobPage, "Bob grüßt die Gruppe");
    await expect(message(carolPage, "Bob grüßt die Gruppe")).toBeVisible(CRYPTO);
    await expect(message(page, "Bob grüßt die Gruppe")).toBeVisible(CRYPTO);
    await send(carolPage, "Carol auch");
    await expect(message(bobPage, "Carol auch")).toBeVisible(CRYPTO);
    for (const p of [page, bobPage, carolPage]) await expect(p.getByTestId("ghost-warning")).toHaveCount(0);
    await bobPage.context().close();
    await carolPage.context().close();
  });

  test("A new device restores the room and the DM via the index and the backup; a key change of the B user locks the verified DM", async ({ browser, page }) => {
    test.setTimeout(scaled(300_000));
    const alice = await registerViaUi(page, { prefix: "fva", web: WEB_A, domain: A });
    const bobPage = await newPage(browser);
    const bob: UiAccount = await registerViaUi(bobPage, { prefix: "fvb", web: WEB_B, domain: B });
    await befriend(page, NODE_A, bobPage, NODE_B, bob.address);

    // Safety numbers compared across the nodes; Alice marks Bob as verified.
    const openVerify = async (p: Page, web: string, address: string) => {
      await p.goto(`${web}/friends`);
      await p.getByTestId("friends-list").locator("li").filter({ hasText: address }).getByTestId("verify-button").click();
      const d = p.getByTestId("verify-dialog");
      await expect(d.getByTestId("safety-number")).toBeVisible(CRYPTO);
      return d;
    };
    const aliceDialog = await openVerify(page, WEB_A, bob.address);
    const bobDialog = await openVerify(bobPage, WEB_B, alice.address);
    const numbers = async (d: typeof aliceDialog) => (await d.getByTestId("safety-number").locator("span").allTextContents()).join(" ");
    expect(await numbers(aliceDialog)).toBe(await numbers(bobDialog));
    await aliceDialog.getByLabel("Gescannter oder eingefügter Code der anderen Person").fill(await bobDialog.getByTestId("verify-payload").inputValue());
    await aliceDialog.getByRole("button", { name: "Vergleichen" }).click();
    await aliceDialog.getByRole("button", { name: "Als verifiziert markieren" }).click();
    await expect(aliceDialog.getByTestId("verify-state")).toHaveAttribute("data-state", "verified");
    await aliceDialog.getByRole("button", { name: "Schließen", exact: true }).click();
    await bobDialog.getByRole("button", { name: "Schließen", exact: true }).click();

    // A DM with history, and a room on b.test joined through a direct invite.
    await page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("verified-badge").first()).toBeVisible();
    await send(page, "Vor dem neuen Gerät");
    const room = await api(bobPage, NODE_B, "post", "/rooms", { name: `Archiv ${bob.username.slice(-5)}`, join_mode: "invite" });
    await api(bobPage, NODE_B, "post", `/rooms/${room.id}/invites/direct`, { user: alice.address });
    await page.goto(`${WEB_A}/`);
    const invite = page.getByTestId("invite-list").getByTestId("invite").filter({ hasText: room.name });
    await invite.getByRole("button", { name: "Annehmen" }).click(CRYPTO);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible(CRYPTO);
    await send(page, "Im Raum auf b.test");
    // Let the debounced backup upload run.
    // (The account's trust record lives next to them under the ULID of time 0, ENCRYPTION.md §7.)
    await expect.poll(async () => (await api(page, NODE_A, "get", "/users/me/backups")).items.filter((b: { conversation: string }) => !b.conversation.endsWith("/00000000000000000000000000")).map((b: { conversation: string }) => b.conversation.split("/")[0]).sort(), CRYPTO).toEqual([A, B]);

    // A new browser of Alice on a.test: recovery key, then the index brings back the room on b.test and
    // the backups the history of the room and the DM.
    const laptop = await newPage(browser);
    await loginViaUi(laptop, alice, WEB_A);
    await laptop.getByTestId("recovery-key-input").fill(alice.recoveryWords);
    await laptop.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(laptop.getByTestId("app-shell")).toBeVisible(CRYPTO);
    await openNavIfMobile(laptop);
    const remoteRoom = laptop.getByRole("link", { name: `${room.name} (${B})` });
    await expect(remoteRoom).toBeVisible(CRYPTO);
    await remoteRoom.click();
    await expect(message(laptop, "Im Raum auf b.test")).toBeVisible(CRYPTO);
    await expect(laptop.getByTestId("undecryptable")).toHaveCount(0);
    const list = await openDmList(laptop, WEB_A);
    await list.getByRole("link", { name: new RegExp(bob.username) }).click();
    await expect(message(laptop, "Vor dem neuen Gerät")).toBeVisible(CRYPTO);
    await expect(laptop.getByTestId("undecryptable")).toHaveCount(0);
    await laptop.context().close();

    // Bob resets his identity on b.test: a.test learns it, Alice's DM with the verified contact is blocked.
    await page.goto(`${WEB_A}/`);
    await (await openDmList(page, WEB_A)).getByRole("link", { name: new RegExp(bob.username) }).click();
    await expect(page.getByTestId("verified-badge").first()).toBeVisible();
    await api(bobPage, NODE_B, "post", "/users/me/identity/reset", { identity_public_key: await freshIdentityKey(), password: bob.password });
    const notice = page.getByTestId("verification-notice");
    await expect(notice).toBeVisible(CRYPTO);
    await expect(notice).toHaveAttribute("data-blocking", "true");
    await expect(notice).toContainText(`${bob.address} hat einen neuen Sicherheitsschlüssel`);
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeDisabled();
    await expect(page.getByTestId("verification-broken-badge").first()).toBeVisible();
    await expect(page.getByTestId("key-changed-badge").first()).toBeVisible();
    await notice.getByRole("button", { name: "Ich vertraue dem neuen Schlüssel" }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId("verified-badge")).toHaveCount(0);
    await bobPage.context().close();
  });
});
